import vm from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import {
  resolveAgentModelSpec,
  WorkflowAgent,
  type WorkflowAgentOptions,
  type WorkflowAgentRunReport,
} from "./agent.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  concurrency?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; prompt: string; model?: string }) => void;
  onAgentEnd?: (event: {
    label: string;
    phase?: string;
    result: unknown;
    report?: WorkflowAgentRunReport;
  }) => void | Promise<void>;
  onAgentProgress?: (event: { label: string; phase?: string; report: WorkflowAgentRunReport }) => void | Promise<void>;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  agents: WorkflowAgentRunReport[];
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string;
  pool?: string;
  isolation?: "worktree";
  agentType?: string;
  context?: "fresh" | "fork";
  acceptance?: unknown;
  async?: boolean;
  savedAgent?: string;
  /** Per-agent wall-clock timeout. Number values are milliseconds; strings accept 5s/10m/1h. */
  timeout?: number | string;
  /** Per-agent wall-clock timeout in milliseconds. Overrides timeout. */
  timeoutMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  spent: number;
  agents: WorkflowAgentRunReport[];
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const MAX_WORKFLOW_AGENTS = 1000;
const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0, agents: [] };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const poolSource = agentRunner instanceof WorkflowAgent ? agentRunner : new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent)),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("workflow aborted");
  };

  const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted();
    if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
    const taskPrompt = requireString(prompt, "agent prompt");
    const normalizedOptions = normalizeAgentOptions(agentOptions);
    const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
    const requestedLabel = normalizedOptions.label?.trim();
    if (state.agentCount >= MAX_WORKFLOW_AGENTS)
      throw new Error(`workflow agent limit exceeded: max ${MAX_WORKFLOW_AGENTS} agents per run`);
    const agentNumber = ++state.agentCount;
    const run = limiter(async () => {
      const label = requestedLabel || defaultAgentLabel(assignedPhase, agentNumber);
      let report: WorkflowAgentRunReport | undefined;
      try {
        throwIfAborted();
        const timeoutMs = normalizedOptions.timeoutMs;
        const timeoutLabel = timeoutMs ? formatDuration(timeoutMs) : undefined;
        const childAbort = createLinkedAbortController(options.signal);
        const runOptions = {
          label,
          phase: assignedPhase,
          schema: normalizedOptions.schema,
          signal: childAbort.signal,
          model: normalizedOptions.model,
          pool: normalizedOptions.pool,
          instructions: buildAgentInstructions(assignedPhase, normalizedOptions),
          agentType: normalizedOptions.agentType,
          context: normalizedOptions.context,
          acceptance: normalizedOptions.acceptance,
          async: normalizedOptions.async,
          savedAgent: normalizedOptions.savedAgent,
          timeoutMs: normalizedOptions.timeoutMs,
          onRunComplete: (value: WorkflowAgentRunReport) => {
            report = value;
            state.agents[agentNumber - 1] = value;
          },
          onProgress: options.onAgentProgress
            ? (value: WorkflowAgentRunReport) =>
                options.onAgentProgress?.({ label, phase: assignedPhase, report: value })
            : undefined,
        };
        const resolvedModel = resolveAgentModelSpec(runOptions, poolSource.modelPools, options.session?.modelRegistry);
        if (resolvedModel) runOptions.model = resolvedModel;
        options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt, model: resolvedModel });
        try {
          const agentPromise = agentRunner.run(taskPrompt, runOptions);
          const result = await withTimeout(
            agentPromise,
            timeoutMs,
            () => {
              childAbort.abort(new Error(`workflow agent ${label} timed out after ${timeoutLabel}`));
            },
            `agent ${label} timed out after ${timeoutLabel}`,
          );
          throwIfAborted();
          state.spent += estimateTokens(result);
          await options.onAgentEnd?.({ label, phase: assignedPhase, result, report });
          return result;
        } finally {
          childAbort.cleanup();
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        await options.onAgentEnd?.({ label, phase: assignedPhase, result: null, report });
        return null;
      }
    });
    pendingAgentRuns.add(run);
    run.then(
      () => pendingAgentRuns.delete(run),
      () => pendingAgentRuns.delete(run),
    );
    return run;
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted) throw error;
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  });

  const wrapped = `(async () => {\n${body}\n})()`;
  const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
  await Promise.allSettled([...pendingAgentRuns]);
  assertStructuredCloneable(result, "workflow result");
  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
    agents: state.agents.filter((agent): agent is WorkflowAgentRunReport => Boolean(agent)),
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function assertDeterministicAst(node: AnyNode): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }

  for (const child of astChildren(node)) assertDeterministicAst(child);
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode));
    else if (isAstNode(value)) children.push(value);
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
  return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date";
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier" || node.object.name !== objectName) {
    return false;
  }
  return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringOf(node.left);
    const right = staticStringOf(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
    throw new Error("meta.whenToUse must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function normalizeTimeoutMs(timeoutMs: unknown, timeout: unknown): number | undefined {
  const raw = timeoutMs ?? timeout;
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0)
      throw new TypeError("agent timeout must be a positive number of milliseconds");
    return Math.ceil(raw);
  }
  if (typeof raw !== "string") throw new TypeError("agent timeout must be a number or duration string");
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) throw new TypeError("agent timeout strings must look like 500ms, 30s, 5m, or 1h");
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.ceil(value * scale);
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function createLinkedAbortController(parent?: AbortSignal): {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  cleanup(): void;
} {
  const controller = new AbortController();
  let cleanup = () => {};
  if (parent?.aborted) {
    controller.abort(parent.reason);
  } else if (parent) {
    const onAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onAbort, { once: true });
    cleanup = () => parent.removeEventListener("abort", onAbort);
  }
  return { signal: controller.signal, abort: (reason?: unknown) => controller.abort(reason), cleanup };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  if (!timeoutMs) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: "ETIMEOUT" }));
      onTimeout();
    }, timeoutMs);
  });
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as AgentOptions;
  return {
    ...options,
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    model: optionalString(options.model, "agent model"),
    pool: optionalString(options.pool, "agent pool"),
    isolation: options.isolation,
    agentType: optionalString(options.agentType, "agent type"),
    context: options.context === "fresh" || options.context === "fork" ? options.context : undefined,
    acceptance: options.acceptance,
    async: options.async === true,
    savedAgent: optionalString((options as { savedAgent?: unknown }).savedAgent, "saved agent"),
    timeoutMs: normalizeTimeoutMs(
      (options as { timeout?: unknown; timeoutMs?: unknown }).timeoutMs,
      (options as { timeout?: unknown }).timeout,
    ),
  };
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    );
  }
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow agent type: ${options.agentType}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  if (options.pool) lines.push(`Requested model pool: ${options.pool}`);
  if (options.model) lines.push(`Requested model: ${options.model}`);
  if (options.context) lines.push(`Requested context: ${options.context}`);
  if (options.async) lines.push(`Requested async execution`);
  if (options.timeoutMs) lines.push(`Wall-clock timeout: ${formatDuration(options.timeoutMs)}`);
  return lines.length ? lines.join("\n") : undefined;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}
