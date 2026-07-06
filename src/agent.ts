import { type AssistantMessage, getModel, type Model, type TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  type SessionStats,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

export type WorkflowModelPoolEntry = string | string[];
export type WorkflowModelPools = Record<string, WorkflowModelPoolEntry>;

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the workflow agent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every workflow agent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  model?: string;
  pool?: string;
  agentType?: string;
  context?: "fresh" | "fork";
  acceptance?: unknown;
  async?: boolean;
  timeoutMs?: number;
  onRunComplete?: (report: WorkflowAgentRunReport) => void;
  /** Fired after each agent turn completes (model response + tool results). */
  onProgress?: (report: WorkflowAgentRunReport) => void | Promise<void>;
}

export interface WorkflowAgentRunMetrics {
  provider?: string;
  model?: string;
  api?: string;
  durationMs: number;
  tokensPerSecond: number | null;
  toolCalls: number;
  toolResults: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

export interface WorkflowAgentRunReport {
  label?: string;
  phase?: string;
  metrics: WorkflowAgentRunMetrics;
  transcript: string;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  readonly modelPools: WorkflowModelPools;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.modelPools = loadWorkflowModelPools(
      this.sessionOptions.settingsManager ?? SettingsManager.create(this.cwd, getAgentDir()),
    );
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.baseTools, ...(options.tools ?? [])];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const agentDir = getAgentDir();
    const model = resolveAgentModel(options, this.modelPools, this.sessionOptions.modelRegistry);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
      ...(model ? { model } : {}),
    });

    let removeAbortListener: (() => void) | undefined;
    let removeProgressListener: (() => void) | undefined;
    const started = Date.now();
    try {
      if (options.signal?.aborted) throw new Error("Workflow agent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onProgress) {
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        const emitProgress = () => {
          void options.onProgress?.(
            this.buildRunReport(session.messages, session.getSessionStats(), Date.now() - started, options, true),
          );
        };
        const debouncedEmit = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            emitProgress();
          }, 400);
        };
        removeProgressListener = session.subscribe((event) => {
          if (event.type === "turn_end" || event.type === "tool_execution_end") {
            emitProgress();
            return;
          }
          if (event.type === "message_end") {
            if ((event as { message?: { role?: string } }).message?.role === "assistant") emitProgress();
            return;
          }
          if (event.type === "message_update") debouncedEmit();
        });
        const unsubscribe = removeProgressListener;
        removeProgressListener = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          unsubscribe?.();
        };
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Workflow agent was aborted");

      const result = options.schema
        ? (() => {
            if (!capture.called) {
              throw new Error("Workflow agent finished without calling structured_output");
            }
            return capture.value as AgentRunResult<TSchemaDef>;
          })()
        : (this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>);

      options.onRunComplete?.(
        this.buildRunReport(session.messages, session.getSessionStats(), Date.now() - started, options),
      );
      return result;
    } finally {
      removeProgressListener?.();
      removeAbortListener?.();
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this workflow agent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private buildRunReport(
    messages: unknown[],
    stats: SessionStats,
    durationMs: number,
    options: AgentRunOptions<any>,
    forProgress = false,
  ): WorkflowAgentRunReport {
    const assistant = [...messages].reverse().find((message) => (message as any)?.role === "assistant") as
      | AssistantMessage
      | undefined;
    const inferred = inferToolActivity(messages);
    const cursorUsage = aggregateCursorSdkUsage(messages);
    const tokens = cursorUsage?.tokens ?? stats.tokens;
    const metricDurationMs =
      cursorUsage?.durationMs && cursorUsage.durationMs > 0 ? cursorUsage.durationMs : durationMs;
    const seconds = metricDurationMs / 1000;
    const tokensPerSecond =
      cursorUsage?.tokensPerSecond ?? (seconds > 0 && tokens.output > 0 ? tokens.output / seconds : null);
    const formatMessage = forProgress ? formatProgressTranscriptMessage : formatTranscriptMessage;
    return {
      label: options.label,
      phase: options.phase,
      metrics: {
        provider: assistant?.provider ?? this.sessionOptions.model?.provider,
        model: assistant?.model ?? this.sessionOptions.model?.id,
        api: assistant?.api ?? this.sessionOptions.model?.api,
        durationMs: metricDurationMs,
        tokensPerSecond,
        toolCalls: Math.max(stats.toolCalls, inferred.toolCalls),
        toolResults: stats.toolResults,
        tokens,
        cost: stats.cost,
      },
      transcript: messages.map(formatMessage).join("\n\n"),
    };
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}

interface CursorSdkUsageMetadata {
  turnEnded?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  tokenDelta?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  tokensPerSecond?: number;
}

function aggregateCursorSdkUsage(
  messages: unknown[],
): Pick<WorkflowAgentRunMetrics, "tokens" | "durationMs" | "tokensPerSecond"> | undefined {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let durationMs = 0;
  let tpsOutputTokens = 0;
  let sawUsage = false;

  for (const message of messages) {
    if ((message as any)?.role !== "assistant") continue;
    const usage = (message as any).piCursorSdk?.usage as CursorSdkUsageMetadata | undefined;
    if (!usage) continue;
    sawUsage = true;
    if (usage.turnEnded) {
      tokens.input += usage.turnEnded.inputTokens;
      tokens.output += usage.turnEnded.outputTokens;
      tokens.cacheRead += usage.turnEnded.cacheReadTokens;
      tokens.cacheWrite += usage.turnEnded.cacheWriteTokens;
      tpsOutputTokens += usage.turnEnded.outputTokens;
    } else if (typeof usage.tokenDelta === "number") {
      // Cursor token-delta is cumulative but not split; keep it as total and output for TPS fallback.
      const output = usage.outputTokens ?? usage.tokenDelta;
      tokens.output += output;
      tpsOutputTokens += output;
    }
    if (typeof usage.durationMs === "number") durationMs += usage.durationMs;
  }

  if (!sawUsage) return undefined;
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    tokens,
    durationMs,
    tokensPerSecond: durationMs > 0 && tpsOutputTokens > 0 ? tpsOutputTokens / (durationMs / 1000) : null,
  };
}

export function formatTranscriptMessage(message: unknown): string {
  const anyMessage = message as any;
  switch (anyMessage.role) {
    case "user":
      return `[User]\n${formatContent(anyMessage.content)}`;
    case "assistant": {
      const lines: string[] = [];
      const model = [anyMessage.provider, anyMessage.model].filter(Boolean).join("/");
      lines.push(`[Assistant${model ? ` ${model}` : ""}]`);
      for (const part of anyMessage.content ?? []) {
        const partType = String(part?.type ?? "").toLowerCase();
        if (partType.includes("thinking") || partType.includes("reasoning")) continue;
        if (part.type === "text" && part.text) lines.push(part.text);
        else if (part.type === "toolCall")
          lines.push(`[tool_call ${part.name}] ${JSON.stringify(part.arguments ?? {})}`);
      }
      return lines.join("\n");
    }
    case "toolResult":
      return `[Tool result ${anyMessage.toolName ?? anyMessage.toolCallId ?? ""}]\n${formatContent(anyMessage.content)}`;
    case "bashExecution":
      return `[Bash]\n$ ${anyMessage.command ?? ""}\n${anyMessage.output ?? ""}`;
    case "custom":
      return `[Custom]\n${formatContent(anyMessage.content)}`;
    case "branchSummary":
    case "compactionSummary":
      return `[${anyMessage.role}]\n${anyMessage.summary ?? ""}`;
    default:
      return `[${anyMessage.role ?? "message"}]\n${JSON.stringify(message)}`;
  }
}

export function formatProgressTranscriptMessage(message: unknown): string {
  const anyMessage = message as any;
  switch (anyMessage.role) {
    case "user":
      return `[User]\n${formatContent(anyMessage.content)}`;
    case "assistant": {
      const lines: string[] = [];
      const model = [anyMessage.provider, anyMessage.model].filter(Boolean).join("/");
      lines.push(`[Assistant${model ? ` ${model}` : ""}]`);
      for (const part of anyMessage.content ?? []) {
        const partType = String(part?.type ?? "").toLowerCase();
        if (partType.includes("thinking") || partType.includes("reasoning")) {
          const trace = formatThinkingTrace(part.thinking ?? part.text ?? "");
          if (trace) lines.push(trace);
          continue;
        }
        if (part.type === "text" && part.text) lines.push(scrubProgressText(part.text));
        else if (part.type === "toolCall")
          lines.push(`[tool_call ${part.name}] ${JSON.stringify(part.arguments ?? {})}`);
      }
      return lines.join("\n");
    }
    case "toolResult":
      return `[Tool result ${anyMessage.toolName ?? anyMessage.toolCallId ?? ""}]\n${formatContent(anyMessage.content)}`;
    case "bashExecution":
      return `[Bash]\n$ ${anyMessage.command ?? ""}\n${anyMessage.output ?? ""}`;
    case "custom":
      return `[Custom]\n${formatContent(anyMessage.content)}`;
    case "branchSummary":
    case "compactionSummary":
      return `[${anyMessage.role}]\n${anyMessage.summary ?? ""}`;
    default:
      return `[${anyMessage.role ?? "message"}]\n${JSON.stringify(message)}`;
  }
}

export function inferToolActivity(messages: unknown[]): { toolCalls: number; lastToolLabel?: string } {
  let toolCalls = 0;
  let lastToolLabel: string | undefined;

  for (const message of messages) {
    const anyMessage = message as any;
    if (anyMessage.role === "assistant" && Array.isArray(anyMessage.content)) {
      for (const part of anyMessage.content) {
        if (part?.type === "toolCall") {
          toolCalls++;
          lastToolLabel = part.name;
          continue;
        }
        const partType = String(part?.type ?? "").toLowerCase();
        if (partType.includes("thinking") || partType.includes("reasoning")) {
          const trace = formatThinkingTrace(part.thinking ?? part.text ?? "");
          if (trace) {
            toolCalls++;
            lastToolLabel = trace.match(/^\[tool_trace ([^:]+):/)?.[1]?.trim() ?? lastToolLabel;
          }
          continue;
        }
        if (part?.type === "text" && typeof part.text === "string") {
          const match = part.text.match(/Tool call \(([^,\s]+)/);
          if (match) {
            toolCalls++;
            lastToolLabel = match[1];
          }
        }
      }
    }
  }

  return { toolCalls, lastToolLabel };
}

function formatThinkingTrace(raw: string): string | undefined {
  const line = raw.replace(/\s+/g, " ").trim();
  const match = line.match(/^([^:]{1,64}): (.+)/);
  if (!match) return undefined;
  const name = match[1].trim();
  const detail = scrubProgressText(match[2].trim(), 200);
  if (!detail) return undefined;
  return `[tool_trace ${name}: ${detail}]`;
}

function scrubProgressText(text: string, max = 2000): string {
  return text
    .replace(/\b(sk|pk)[-_][A-Za-z0-9]{10,}\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .slice(0, max);
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "image") return `[image ${part.mimeType ?? ""}]`;
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function loadWorkflowModelPools(manager: SettingsManager): WorkflowModelPools {
  const fromSettings = (settings: unknown) =>
    (settings as { workflowModelPools?: WorkflowModelPools } | undefined)?.workflowModelPools;
  return { ...fromSettings(manager.getGlobalSettings()), ...fromSettings(manager.getProjectSettings()) };
}

function resolveAgentModel(
  options: Pick<AgentRunOptions, "model" | "agentType" | "pool">,
  pools: WorkflowModelPools,
  registry?: ModelRegistry,
): Model<any> | undefined {
  const spec = resolveAgentModelSpec(options, pools, registry);
  if (!spec) return undefined;
  return resolveModelSpec(spec, registry);
}

export function resolveAgentModelSpec(
  options: Pick<AgentRunOptions, "model" | "agentType" | "pool">,
  pools: WorkflowModelPools | undefined,
  registry?: ModelRegistry,
): string | undefined {
  if (options.model) return options.model;
  const poolName = options.pool ?? options.agentType;
  if (!poolName) return undefined;
  return pickAvailableModel(pools?.[poolName], registry);
}

function pickAvailableModel(entry: WorkflowModelPoolEntry | undefined, registry?: ModelRegistry): string | undefined {
  if (!entry) return undefined;
  const specs = Array.isArray(entry) ? entry : [entry];
  if (!registry) return specs[0];
  const available = new Set(registry.getAvailable().map((m) => `${m.provider}/${m.id}`));
  return specs.find((s) => available.has(s)) ?? specs[0];
}

function resolveModelSpec(spec: string, registry?: ModelRegistry): Model<any> | undefined {
  const [provider, ...rest] = spec.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) return undefined;
  if (registry) {
    const found = registry.find(provider, modelId);
    if (found) return found;
  }
  try {
    return getModel(provider as any, modelId);
  } catch {
    return undefined;
  }
}
