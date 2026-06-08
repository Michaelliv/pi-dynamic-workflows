import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

export type AgentThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export type WorkflowAgentTranscriptStatus = "done" | "error";

export interface WorkflowAgentTranscript {
  label?: string;
  phase?: string;
  status: WorkflowAgentTranscriptStatus;
  transcriptPath?: string;
  sessionId?: string;
  requestedModel?: string;
  resolvedModel?: string;
  thinkingLevel?: AgentThinkingLevel;
  error?: string;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /** Directory where each subagent Pi session transcript is persisted. Defaults to Pi's normal session directory. */
  transcriptDir?: string;
  /** Called after each subagent finishes, with the persisted transcript path and audit metadata. */
  onTranscript?: (info: WorkflowAgentTranscript) => void;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string | Model<any>;
  thinkingLevel?: AgentThinkingLevel;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly transcriptDir?: string;
  private readonly onTranscript?: (info: WorkflowAgentTranscript) => void;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.transcriptDir = options.transcriptDir;
    this.onTranscript = options.onTranscript;
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
    const runSessionOptions = this.resolveRunSessionOptions(options, agentDir);
    const sessionManager = this.createSessionManager();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager,
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
      ...runSessionOptions,
    });
    session.sessionManager.appendSessionInfo(
      options.label ? `workflow subagent: ${options.label}` : "workflow subagent",
    );

    let removeAbortListener: (() => void) | undefined;
    let status: WorkflowAgentTranscriptStatus = "done";
    let errorMessage: string | undefined;
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      if (options.schema) {
        if (!capture.called) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } catch (error) {
      status = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      removeAbortListener?.();
      const transcript: WorkflowAgentTranscript = {
        label: options.label,
        phase: options.phase,
        status,
        transcriptPath: session.sessionFile,
        sessionId: session.sessionId,
        requestedModel: formatModelRef(options.model),
        resolvedModel: formatModelRef(session.model ?? runSessionOptions.model),
        thinkingLevel: options.thinkingLevel ?? session.thinkingLevel,
        error: errorMessage,
      };
      session.dispose();
      this.onTranscript?.(transcript);
    }
  }

  validateRunOptions(options: AgentRunOptions<any>): void {
    this.resolveRunSessionOptions(options, getAgentDir());
  }

  private createSessionManager(): SessionManager {
    if (this.sessionOptions.sessionManager) return this.sessionOptions.sessionManager;
    return SessionManager.create(this.cwd, this.transcriptDir);
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
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private resolveRunSessionOptions(
    options: AgentRunOptions<any>,
    agentDir: string,
  ): Pick<CreateAgentSessionOptions, "authStorage" | "model" | "modelRegistry" | "thinkingLevel"> {
    const thinkingLevelOptions =
      options.thinkingLevel === undefined ? {} : ({ thinkingLevel: options.thinkingLevel } as const);

    if (!options.model) return thinkingLevelOptions;
    if (typeof options.model !== "string") return { model: options.model, ...thinkingLevelOptions };

    const authStorage = this.sessionOptions.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
    const modelRegistry =
      this.sessionOptions.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const settingsManager = this.sessionOptions.settingsManager ?? SettingsManager.create(this.cwd, agentDir);
    const resolvedModel = resolveModel(modelRegistry, options.model);

    if (!resolvedModel) {
      const suggestions = suggestModels(modelRegistry, options.model, {
        defaultProvider: settingsManager.getDefaultProvider(),
      });
      const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      throw new Error(
        `Unknown workflow agent model "${options.model}". Use "provider/model-id" or a unique exact model id from the model registry.${hint}`,
      );
    }

    return {
      authStorage,
      modelRegistry,
      model: resolvedModel,
      ...thinkingLevelOptions,
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

function formatModelRef(model: string | Model<any> | undefined): string | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  return `${model.provider}/${model.id}`;
}

export function resolveModel(
  modelRegistry: Pick<ModelRegistry, "getAvailable">,
  requested: string,
): Model<any> | undefined {
  const trimmed = requested.trim();
  if (!trimmed) return undefined;

  const availableModels = modelRegistry.getAvailable();
  const canonicalMatch = availableModels.find((model) => `${model.provider}/${model.id}` === trimmed);
  if (canonicalMatch) return canonicalMatch;

  const matches = availableModels.filter((model) => model.id === trimmed);
  if (matches.length === 1) return matches[0];

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    const provider = trimmed.slice(0, slashIndex);
    const modelId = trimmed.slice(slashIndex + 1);
    return availableModels.find((model) => model.provider === provider && model.id === modelId);
  }

  return undefined;
}

export function suggestModels(
  modelRegistry: Pick<ModelRegistry, "getAvailable">,
  requested: string,
  options: { defaultProvider?: string; limit?: number } = {},
): string[] {
  const query = normalizeModelSearchText(requested);
  if (!query) return [];

  const limit = options.limit ?? 5;
  return modelRegistry
    .getAvailable()
    .map((model) => {
      const canonical = `${model.provider}/${model.id}`;
      return {
        canonical,
        score: modelSuggestionScore(query, canonical) + (model.provider === options.defaultProvider ? 25 : 0),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.canonical.localeCompare(b.canonical))
    .slice(0, limit)
    .map((item) => item.canonical);
}

function modelSuggestionScore(query: string, canonical: string): number {
  const target = normalizeModelSearchText(canonical);
  if (target === query) return 1000;
  if (target.includes(query)) return 800 - Math.max(0, target.length - query.length);

  const queryTokens = query.split(" ").filter((token) => token.length >= 3);
  if (!queryTokens.length) return 0;

  let score = 0;
  for (const token of queryTokens) {
    if (target.includes(token)) score += token.length;
  }

  return score;
}

function normalizeModelSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
