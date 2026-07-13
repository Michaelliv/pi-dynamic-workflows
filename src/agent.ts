import { join } from "node:path";
import {
  type AssistantMessage,
  getSupportedThinkingLevels,
  type Model,
  type TextContent,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodingTools,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

type WorkflowThinkingLevel = ThinkingLevel | "off" | "max";

const THINKING_LEVELS = new Set<WorkflowThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// "sonnet:low" -> pattern "sonnet" + level "low". Bedrock ":0" ids fall through (not a level).
function parseModelSpec(spec: string | undefined): {
  modelPattern?: string;
  thinkingLevel?: WorkflowThinkingLevel;
} {
  if (spec === undefined) return {};
  const trimmed = spec.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1) {
    const suffix = trimmed.slice(colon + 1).toLowerCase() as WorkflowThinkingLevel;
    if (THINKING_LEVELS.has(suffix)) {
      return { modelPattern: trimmed.slice(0, colon).trim(), thinkingLevel: suffix };
    }
  }
  return { modelPattern: trimmed };
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /** Model pattern or ID (for example, "haiku", "sonnet:low", or "anthropic/claude-opus-4-5"). */
  model?: string;
  /** Called once with the resolved "provider/id" the subagent runs on. */
  onModel?: (model: string) => void;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private resourceLoaderAuthStorage?: AuthStorage;
  private resourceLoaderModelRegistry?: ModelRegistry;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
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

    const { session } = await this.createSession(options.model, customTools);

    let removeAbortListener: (() => void) | undefined;
    try {
      if (session.model) options.onModel?.(`${session.model.provider}/${session.model.id}`);
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
    } finally {
      removeAbortListener?.();
      session.dispose();
    }
  }

  private async createSession(modelSpec: string | undefined, customTools: ToolDefinition[]) {
    const cwd = this.sessionOptions.cwd ?? this.cwd;
    const agentDir = this.sessionOptions.agentDir ?? getAgentDir();
    const sessionManager = this.sessionOptions.sessionManager ?? SessionManager.inMemory(cwd);
    const excludeTools = [...new Set([...(this.sessionOptions.excludeTools ?? []), "workflow"])];

    if (!this.sessionOptions.resourceLoader) {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        authStorage: this.sessionOptions.authStorage,
        settingsManager: this.sessionOptions.settingsManager,
        modelRegistry: this.sessionOptions.modelRegistry,
      });
      const { model, thinkingLevel } = this.resolveModelSpec(
        modelSpec,
        services.modelRegistry,
        this.sessionOptions.model?.provider ?? services.settingsManager.getDefaultProvider(),
        this.sessionOptions.model,
      );
      const resolvedThinkingLevel = this.resolveThinkingLevel(thinkingLevel, model);

      return createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent: this.sessionOptions.sessionStartEvent,
        model,
        thinkingLevel: (resolvedThinkingLevel ?? this.sessionOptions.thinkingLevel) as ThinkingLevel | undefined,
        scopedModels: this.sessionOptions.scopedModels,
        tools: this.sessionOptions.tools,
        excludeTools,
        noTools: this.sessionOptions.noTools,
        customTools: this.sessionOptions.customTools ?? customTools,
      });
    }

    let authStorage = this.sessionOptions.authStorage;
    if (!authStorage) {
      this.resourceLoaderAuthStorage ??= AuthStorage.create(join(agentDir, "auth.json"));
      authStorage = this.resourceLoaderAuthStorage;
    }
    let modelRegistry = this.sessionOptions.modelRegistry;
    if (!modelRegistry) {
      this.resourceLoaderModelRegistry ??= ModelRegistry.create(authStorage, join(agentDir, "models.json"));
      modelRegistry = this.resourceLoaderModelRegistry;
    }
    const settingsManager = this.sessionOptions.settingsManager ?? SettingsManager.create(cwd, agentDir);
    const extensionsResult = this.sessionOptions.resourceLoader.getExtensions();
    const failedProviderRegistrations: typeof extensionsResult.runtime.pendingProviderRegistrations = [];
    for (const registration of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(registration.name, registration.config);
      } catch {
        failedProviderRegistrations.push(registration);
      }
    }
    extensionsResult.runtime.pendingProviderRegistrations = failedProviderRegistrations;
    const { model, thinkingLevel } = this.resolveModelSpec(
      modelSpec,
      modelRegistry,
      this.sessionOptions.model?.provider ?? settingsManager.getDefaultProvider(),
      this.sessionOptions.model,
    );
    const resolvedThinkingLevel = this.resolveThinkingLevel(thinkingLevel, model);

    return createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      settingsManager,
      customTools: this.sessionOptions.customTools ?? customTools,
      authStorage,
      modelRegistry,
      ...this.sessionOptions,
      excludeTools,
      ...(model ? { model } : {}),
      ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel as ThinkingLevel } : {}),
    });
  }

  private resolveThinkingLevel(
    requested: WorkflowThinkingLevel | undefined,
    model: Model<any> | undefined,
  ): WorkflowThinkingLevel | undefined {
    if (requested !== "max" || !model) return requested;

    const supported = getSupportedThinkingLevels(model) as readonly string[];
    if (supported.includes("max")) return "max";

    for (const fallback of ["xhigh", "high", "medium", "low", "minimal"] as const) {
      if (supported.includes(fallback)) return fallback;
    }

    return "off";
  }

  private resolveModelSpec(
    spec: string | undefined,
    modelRegistry: ModelRegistry,
    preferredProvider: string | undefined,
    inheritedModel: Model<any> | undefined,
  ): { model: Model<any> | undefined; thinkingLevel: WorkflowThinkingLevel | undefined } {
    if (spec === undefined) return { model: inheritedModel, thinkingLevel: undefined };

    const trimmed = spec.trim();
    const normalized = trimmed.toLowerCase();
    const hasExactModel = modelRegistry
      .getAll()
      .some(
        (model) =>
          `${model.provider}/${model.id}`.toLowerCase() === normalized || model.id.toLowerCase() === normalized,
      );
    if (hasExactModel) {
      return { model: this.resolveModel(trimmed, modelRegistry, preferredProvider), thinkingLevel: undefined };
    }

    const { modelPattern, thinkingLevel } = parseModelSpec(trimmed);
    return {
      model: this.resolveModel(modelPattern ?? "", modelRegistry, preferredProvider),
      thinkingLevel,
    };
  }

  private resolveModel(pattern: string, modelRegistry: ModelRegistry, preferredProvider?: string): Model<any> {
    const normalizedPattern = pattern.trim().toLowerCase();
    const all = modelRegistry.getAll();
    const available = modelRegistry.getAvailable();
    if (!normalizedPattern) {
      throw new Error(`unknown model "${pattern}"; model pattern must not be empty`);
    }

    const canonicalMatches = available.filter(
      (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedPattern,
    );
    if (canonicalMatches.length === 1) return canonicalMatches[0];
    if (canonicalMatches.length > 1) {
      throw new Error(
        `ambiguous model "${pattern}"; use an explicit provider/model: ${this.formatModelChoices(canonicalMatches)}`,
      );
    }

    const unavailableCanonicalMatches = all.filter(
      (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedPattern,
    );
    if (unavailableCanonicalMatches.length > 0) {
      throw new Error(
        `model "${pattern}" is unavailable; configure auth for: ${this.formatModelChoices(unavailableCanonicalMatches)}`,
      );
    }

    const slashIndex = normalizedPattern.indexOf("/");
    if (slashIndex !== -1) {
      const provider = normalizedPattern.slice(0, slashIndex);
      const modelPattern = normalizedPattern.slice(slashIndex + 1);
      if (!provider || !modelPattern) {
        throw new Error(`unknown model "${pattern}"; provider and model pattern must not be empty`);
      }
      if (all.some((model) => model.provider.toLowerCase() === provider)) {
        const providerMatches = available.filter(
          (model) =>
            model.provider.toLowerCase() === provider &&
            (model.id.toLowerCase().includes(modelPattern) || model.name?.toLowerCase().includes(modelPattern)),
        );
        if (providerMatches.length === 1) return providerMatches[0];
        if (providerMatches.length > 1) {
          throw new Error(
            `ambiguous model "${pattern}"; use a more specific provider/model: ${this.formatModelChoices(providerMatches)}`,
          );
        }

        const unavailableProviderMatches = all.filter(
          (model) =>
            model.provider.toLowerCase() === provider &&
            (model.id.toLowerCase().includes(modelPattern) || model.name?.toLowerCase().includes(modelPattern)),
        );
        if (unavailableProviderMatches.length > 0) {
          throw new Error(
            `model "${pattern}" is unavailable; configure auth for: ${this.formatModelChoices(unavailableProviderMatches)}`,
          );
        }

        throw new Error(`unknown model "${pattern}"`);
      }
    }

    const exactIdMatches = available.filter((model) => model.id.toLowerCase() === normalizedPattern);
    const unavailablePreferredExactIdMatches = preferredProvider
      ? all.filter(
          (model) =>
            model.id.toLowerCase() === normalizedPattern &&
            model.provider.toLowerCase() === preferredProvider.toLowerCase() &&
            !exactIdMatches.some(
              (availableModel) => availableModel.provider === model.provider && availableModel.id === model.id,
            ),
        )
      : [];
    if (unavailablePreferredExactIdMatches.length > 0) {
      throw new Error(
        `model "${pattern}" is unavailable; configure auth for: ${this.formatModelChoices(unavailablePreferredExactIdMatches)}`,
      );
    }
    if (exactIdMatches.length === 1) return exactIdMatches[0];
    if (exactIdMatches.length > 1) {
      throw new Error(
        `ambiguous model "${pattern}"; use an explicit provider/model: ${this.formatModelChoices(exactIdMatches)}`,
      );
    }

    const unavailableExactIdMatches = all.filter((model) => model.id.toLowerCase() === normalizedPattern);
    if (unavailableExactIdMatches.length > 0) {
      throw new Error(
        `model "${pattern}" is unavailable; configure auth for: ${this.formatModelChoices(unavailableExactIdMatches)}`,
      );
    }

    const partialMatches = available.filter(
      (model) =>
        model.id.toLowerCase().includes(normalizedPattern) || model.name?.toLowerCase().includes(normalizedPattern),
    );
    const preferredMatches = preferredProvider
      ? partialMatches.filter((model) => model.provider.toLowerCase() === preferredProvider.toLowerCase())
      : [];
    const preferredMatch = this.pickBestModel(preferredMatches);
    if (preferredMatch) return preferredMatch;
    const unavailablePreferredPartialMatches = preferredProvider
      ? all.filter(
          (model) =>
            model.provider.toLowerCase() === preferredProvider.toLowerCase() &&
            (model.id.toLowerCase().includes(normalizedPattern) ||
              model.name?.toLowerCase().includes(normalizedPattern)) &&
            !partialMatches.some(
              (availableModel) => availableModel.provider === model.provider && availableModel.id === model.id,
            ),
        )
      : [];
    if (unavailablePreferredPartialMatches.length > 0) {
      throw new Error(
        `model "${pattern}" is unavailable; configure auth for: ${this.formatModelChoices(unavailablePreferredPartialMatches)}`,
      );
    }
    if (partialMatches.length === 1) return partialMatches[0];
    if (partialMatches.length > 1) {
      throw new Error(
        `ambiguous model "${pattern}"; use an explicit provider/model: ${this.formatModelChoices(partialMatches)}`,
      );
    }

    const unavailablePartialMatches = all.filter(
      (model) =>
        model.id.toLowerCase().includes(normalizedPattern) || model.name?.toLowerCase().includes(normalizedPattern),
    );
    if (unavailablePartialMatches.length > 0) {
      throw new Error(
        `model "${pattern}" is unavailable; configure auth for: ${this.formatModelChoices(unavailablePartialMatches)}`,
      );
    }

    throw new Error(`unknown model "${pattern}"`);
  }

  private pickBestModel(matches: Model<any>[]): Model<any> | undefined {
    if (matches.length === 0) return undefined;

    const aliases = matches.filter((model) => model.id.endsWith("-latest") || !/-\d{8}$/.test(model.id));

    return [...(aliases.length > 0 ? aliases : matches)].sort((a, b) => {
      const byId = b.id.localeCompare(a.id, undefined, { numeric: true, sensitivity: "base" });
      return byId !== 0 ? byId : a.provider.localeCompare(b.provider);
    })[0];
  }

  private formatModelChoices(models: Model<any>[], limit = 5): string {
    return [...new Set(models.map((model) => `${model.provider}/${model.id}`))].sort().slice(0, limit).join(", ");
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
    } else {
      parts.push(
        "Final output: your last message must be a text answer (the subagent's return value). Run any tools first, then end with text stating the result; never end on a bare tool call or the caller gets an empty result.",
      );
    }

    return parts.join("\n\n");
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
