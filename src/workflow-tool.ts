import { complete } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkflowAgentRunReport } from "./agent.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Required raw JavaScript workflow script, with no Markdown fences.",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
      "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
      "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: true,
} as const;

const STEPFUN_PROGRESS_MAX_TOKENS = 16384;
const STEPFUN_HANDOFF_MAX_TOKENS = 2048;
const PROGRESS_TRANSCRIPT_MAX_CHARS = 20_000;
const HANDOFF_TRANSCRIPT_MAX_CHARS = 30_000;
const STEPFUN_PROGRESS_PROMPT = [
  "Summarize one Pi workflow child-agent's progress for a live status line.",
  'Return compact JSON only: {"progress":"4-16 words, concrete outcome/status"}.',
  "Do not mention secrets. Do not include markdown.",
].join("\n");
const STEPFUN_HANDOFF_PROMPT = [
  "Write a Pi workflow child-agent handoff after the child has finished.",
  "You receive the child result plus a running trace with thinking/reasoning removed.",
  'Return compact JSON only: {"handoff":"one concise sentence with outcome, checks run, and any gap"}.',
  "Do not mention hidden reasoning or secrets. Do not include markdown.",
].join("\n");

function createProgressUpdater(
  getAgent: () => WorkflowAgentSnapshot | undefined,
  update: () => void,
  ctx: any,
): (report: WorkflowAgentRunReport) => void {
  let summarizing = false;
  let pending: WorkflowAgentRunReport | undefined;
  let lastSummarizedTail = "";

  const drain = async () => {
    summarizing = true;
    try {
      while (pending) {
        const report = pending;
        pending = undefined;
        const agent = getAgent();
        if (!agent) continue;
        agent.resultPreview = cheapProgressPreview(report);
        update();
        const transcriptTail = tail(report.transcript, PROGRESS_TRANSCRIPT_MAX_CHARS);
        if (transcriptTail === lastSummarizedTail) continue;
        lastSummarizedTail = transcriptTail;
        const summary = await summarizeAgentProgress(report, ctx);
        if (summary && getAgent() === agent) {
          agent.resultPreview = summary;
          update();
        }
      }
    } finally {
      summarizing = false;
      if (pending) void drain();
    }
  };

  return (report: WorkflowAgentRunReport) => {
    const agent = getAgent();
    if (agent) {
      agent.resultPreview = cheapProgressPreview(report);
      update();
    }
    pending = report;
    if (!summarizing) void drain();
  };
}

export function cheapProgressPreview(report: WorkflowAgentRunReport): string {
  const toolCalls = [...report.transcript.matchAll(/\[tool_call ([^\]]+)\]/g)];
  if (toolCalls.length) {
    const name = toolCalls[toolCalls.length - 1][1].split(/\s/)[0];
    return preview(`${name}…`, 80);
  }
  const traces = [...report.transcript.matchAll(/\[tool_trace ([^\]]+)\]/g)];
  if (traces.length) {
    const label = traces[traces.length - 1][1].split(":")[0]?.trim();
    if (label) return preview(`${label}…`, 80);
  }
  const lines = report.transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("[User]") || line.startsWith("[Tool")) continue;
    const toolCallText = line.match(/Tool call \(([^,\s]+)/);
    if (toolCallText) return preview(`${toolCallText[1]}…`, 80);
    const stripped = line.replace(/^\[Assistant[^\]]*\]\s*/, "").trim();
    const cursorTrace = stripped.match(/^([^:]{1,40}): (.+)/);
    if (cursorTrace && !stripped.startsWith("[")) return preview(`${cursorTrace[1]}…`, 80);
    if (stripped && !stripped.startsWith("[")) return preview(stripped, 80);
  }
  return "working…";
}

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  pi?: ExtensionAPI;
}

function isExtensionAPI(value: unknown): value is ExtensionAPI {
  const candidate = value as Partial<ExtensionAPI> | undefined;
  return typeof candidate?.registerTool === "function" && typeof candidate?.on === "function";
}

export function createWorkflowTool(
  piOrOptions: ExtensionAPI | WorkflowToolOptions = {},
  maybeOptions: WorkflowToolOptions = {},
): ToolDefinition<typeof workflowToolSchema, any> {
  const pi = isExtensionAPI(piOrOptions) ? piOrOptions : piOrOptions.pi;
  const options = isExtensionAPI(piOrOptions) ? maybeOptions : piOrOptions;
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple workflow agents with agent(), parallel(), and pipeline().",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow for nontrivial repo changes, explicit workflow requests, fan-out, or multi-agent orchestration. For trivial one-file fixes, direct tools are fine.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "Phase names may be conditional or built in a loop; call phase(title) at runtime when the work actually starts.",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable. Runs are capped at 16 concurrent agents and 1000 total agent() calls.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For broad work, arrange phases as context gathering workflow -> implementation workflow -> verification workflow -> cleanup/report. The parent agent orchestrates and synthesizes rather than doing bulk implementation itself.",
      "For workflow, agentType is a dynamic role/pool hint. Use { agentType: 'worker' } for implementation. For text verification, run an ensemble with parallel verifier agents using { agentType: 'verifier', pool: 'verifier-spark', timeout: '5m' } and { agentType: 'verifier', pool: 'verifier-kimi', timeout: '5m' }. For visual evidence, use { agentType: 'verifier', pool: 'multimodal-verifier', timeout: '5m' }.",
      "For implementation workflows, prefer small vertical slices: implement one locally testable slice at a time, run validation, run the verifier ensemble, repair, then continue. Add a cleanup/simplicity pass after large runs.",
      "For workflow, set per-agent wall-clock limits with opts.timeout or opts.timeoutMs, e.g. agent(prompt, { label: 'verify', timeout: '5m' }); timed-out agents fail open as null instead of blocking parallel().",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, do not assume child agents have repository code context from the parent; include enough task context and relevant paths in each agent prompt.",
      "For reusable orchestration recipes (worker/verifier repair loops, dynamic fan-out, per-item pipelines), load the `workflow-patterns` skill.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, ctx, workflowDisplayOptions);
      display.clear();
      ctx?.ui?.setWidget?.("workflow", undefined);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const findRunningAgent = (label: string) =>
        [...snapshot.agents].reverse().find((item) => item.label === label && item.status === "running");

      const progressUpdaters = new Map<string, (report: WorkflowAgentRunReport) => void>();
      const getProgressUpdater = (label: string) => {
        let existing = progressUpdaters.get(label);
        if (existing) return existing;
        existing = createProgressUpdater(() => findRunningAgent(label), update, ctx);
        progressUpdaters.set(label, existing);
        return existing;
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          signal,
          concurrency: options.concurrency,
          pi,
          ctx,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
          onLog(message) {
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            recordPhase(title);
            update();
          },
          onAgentStart(event) {
            if (signal?.aborted) throw new Error("Workflow was aborted");
            recordPhase(event.phase);
            snapshot.agents.push({
              id: snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
              model: event.model,
            });
            update();
          },
          onAgentProgress(event) {
            const agent = findRunningAgent(event.label);
            if (!agent) return;
            agent.durationMs = event.report.metrics.durationMs;
            agent.toolCalls = event.report.metrics.toolCalls;
            agent.totalTokens = event.report.metrics.tokens.total;
            getProgressUpdater(event.label)(event.report);
          },
          async onAgentEnd(event) {
            const agent = findRunningAgent(event.label);
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
              agent.resultPreview = preview(event.result);
              if (event.report) {
                agent.model = modelName(event.report);
                agent.durationMs = event.report.metrics.durationMs;
                agent.tokensPerSecond = event.report.metrics.tokensPerSecond;
                agent.toolCalls = event.report.metrics.toolCalls;
                agent.totalTokens = event.report.metrics.tokens.total;
                agent.resultPreview = "writing handoff…";
                update();
                agent.resultPreview =
                  (await summarizeAgentHandoff(event.report, event.result, ctx)) ?? preview(event.result);
              }
            }
            update();
          },
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any child agents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      return {
        content: [
          {
            type: "text",
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          agentReports: result.agents,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

async function summarizeAgentHandoff(
  report: WorkflowAgentRunReport,
  result: unknown,
  ctx: any,
): Promise<string | undefined> {
  try {
    const model = ctx.modelRegistry?.find?.("stepfun", "step-3.7-flash");
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok || !auth.apiKey) return undefined;
    const response = await complete(
      model,
      {
        systemPrompt: STEPFUN_HANDOFF_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: [
                  `<label>${report.label ?? "agent"}</label>`,
                  `<phase>${report.phase ?? ""}</phase>`,
                  `<model>${modelName(report) ?? "unknown"}</model>`,
                  `<metrics>tokens=${report.metrics.tokens.total}; tools=${report.metrics.toolCalls}; durationMs=${report.metrics.durationMs}</metrics>`,
                  "<result>",
                  preview(result, 4000),
                  "</result>",
                  "<trace_without_thinking>",
                  tail(stripThinkingTranscript(report.transcript), HANDOFF_TRANSCRIPT_MAX_CHARS),
                  "</trace_without_thinking>",
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        temperature: 0,
        maxTokens: STEPFUN_HANDOFF_MAX_TOKENS,
        cacheRetention: "none",
      },
    );
    return parseHandoff(responseText(response));
  } catch {
    return undefined;
  }
}

async function summarizeAgentProgress(report: WorkflowAgentRunReport, ctx: any): Promise<string | undefined> {
  try {
    const model = ctx.modelRegistry?.find?.("stepfun", "step-3.7-flash");
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok || !auth.apiKey) return undefined;
    const response = await complete(
      model,
      {
        systemPrompt: STEPFUN_PROGRESS_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: [
                  `<label>${report.label ?? "agent"}</label>`,
                  `<phase>${report.phase ?? ""}</phase>`,
                  `<model>${modelName(report) ?? "unknown"}</model>`,
                  `<metrics>tokens=${report.metrics.tokens.total}; tools=${report.metrics.toolCalls}</metrics>`,
                  "<transcript>",
                  tail(report.transcript, PROGRESS_TRANSCRIPT_MAX_CHARS),
                  "</transcript>",
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        temperature: 0,
        maxTokens: STEPFUN_PROGRESS_MAX_TOKENS,
        cacheRetention: "none",
      },
    );
    return parseProgress(responseText(response));
  } catch {
    return undefined;
  }
}

function responseText(response: { content?: Array<{ type?: string; text?: string }> }): string {
  return (
    response.content
      ?.filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim() ?? ""
  );
}

function parseProgress(raw: string): string | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = match ? (JSON.parse(match[0]) as { progress?: unknown }) : undefined;
    const progress = cleanOneLine(parsed?.progress);
    return progress ? preview(progress, 120) : undefined;
  } catch {
    const text = cleanOneLine(raw);
    return text ? preview(text, 120) : undefined;
  }
}

function parseHandoff(raw: string): string | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = match ? (JSON.parse(match[0]) as { handoff?: unknown }) : undefined;
    const handoff = cleanOneLine(parsed?.handoff);
    return handoff ? preview(handoff, 180) : undefined;
  } catch {
    const text = cleanOneLine(raw);
    return text ? preview(text, 180) : undefined;
  }
}

function stripThinkingTranscript(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => !/thinking|reasoning|encrypted_content|thinkingSignature/i.test(line))
    .join("\n");
}

function cleanOneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(-max);
}

function modelName(report: WorkflowAgentRunReport): string | undefined {
  const { provider, model } = report.metrics;
  return provider && model ? `${provider}/${model}` : model;
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
