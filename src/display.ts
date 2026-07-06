import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  model?: string;
  durationMs?: number;
  tokensPerSecond?: number | null;
  toolCalls?: number;
  totalTokens?: number;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;
  const widget = ctx && !streamToolUpdates ? createWidgetWorkflowDisplay(ctx, options) : undefined;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const lines = [workflowTitle(snapshot)];
  const subtitle = workflowSubtitle(snapshot);
  if (subtitle) lines.push(subtitle);

  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      lines.push(...renderAgentLines(agent, showResultPreviews));
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  Unphased");
    for (const agent of unphased.slice(-maxAgents)) {
      lines.push(...renderAgentLines(agent, showResultPreviews));
    }
  }

  const visibleLogs = snapshot.logs.slice(-maxLogs);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push("");
    for (const log of visibleLogs) lines.push(`  log: ${log}`);
  }
  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  _completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  return renderWorkflowLines(snapshot, options).join("\n");
}

function workflowTitle(snapshot: WorkflowSnapshot): string {
  const parts = [`Workflow: ${snapshot.name} — ${snapshot.doneCount}/${snapshot.agentCount} done`];
  if (snapshot.runningCount > 0) parts.push(`${snapshot.runningCount} running`);
  if (snapshot.errorCount > 0) parts.push(`${snapshot.errorCount} errors`);
  return parts.join(" · ");
}

function workflowSubtitle(snapshot: WorkflowSnapshot): string | undefined {
  const parts: string[] = [];
  if (snapshot.currentPhase) parts.push(`Phase: ${snapshot.currentPhase}`);
  const running = snapshot.agents.filter((agent) => agent.status === "running");
  const active = running[running.length - 1];
  if (active) parts.push(`Active: ${active.label}`);
  const progress = active?.resultPreview ?? latestProgress(snapshot);
  if (progress) parts.push(progress);
  return parts.length ? parts.join(" · ") : undefined;
}

function latestProgress(snapshot: WorkflowSnapshot): string | undefined {
  for (let i = snapshot.agents.length - 1; i >= 0; i--) {
    const preview = snapshot.agents[i].resultPreview;
    if (preview) return preview;
  }
  return undefined;
}

function renderAgentLines(agent: WorkflowAgentSnapshot, showResultPreviews: boolean): string[] {
  const metrics = formatAgentMetrics(agent);
  const lines = [`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${metrics}`];
  if (showResultPreviews && agent.resultPreview) lines.push(`       ${agent.resultPreview}`);
  return lines;
}

function formatAgentMetrics(agent: WorkflowAgentSnapshot): string {
  const parts = [];
  if (agent.model) parts.push(agent.model);
  if (typeof agent.durationMs === "number") parts.push(formatElapsed(agent.durationMs));
  if (typeof agent.toolCalls === "number") parts.push(`${agent.toolCalls} tools`);
  if (typeof agent.totalTokens === "number") parts.push(`${formatCount(agent.totalTokens)} tok`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
    : `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${formatNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${formatNumber(value / 1_000)}k`;
  return String(value);
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
