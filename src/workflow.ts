import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";

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
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; prompt: string }) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  spent: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

type BridgeMessage =
  | { type: "log"; message: string }
  | { type: "phase"; title: string }
  | { type: "agentStart"; label: string; phase?: string; prompt: string }
  | { type: "agentEnd"; label: string; phase?: string; result: unknown }
  | { type: "agent"; prompt: string; label: string; phase?: string; opts?: AgentOptions };

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0 };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const tokenBudget = options.tokenBudget ?? null;
  const cwd = options.cwd ?? process.cwd();

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("workflow aborted");
  };

  // Single host-realm bridge function. Every cross-realm call goes through here.
  // For sync message types (log/phase/agentStart/agentEnd) it returns synchronously.
  // For async (agent) it returns a host Promise whose resolved value is a JSON string.
  // Any host error is wrapped as `new Error(message)` at the sandbox boundary so the
  // sandbox never receives a host-realm Error (which would expose host Function via
  // `error.constructor.constructor`).
  const __bridge = (msg: BridgeMessage): unknown => {
    if (msg.type === "log") {
      const text = String(msg.message);
      state.logs.push(text);
      options.onLog?.(text);
      return undefined;
    }
    if (msg.type === "phase") {
      const title = String(msg.title);
      state.currentPhase = title;
      if (!state.phases.includes(title)) state.phases.push(title);
      options.onPhase?.(title);
      return undefined;
    }
    if (msg.type === "agentStart") {
      state.agentCount += 1;
      options.onAgentStart?.({ label: msg.label, phase: msg.phase, prompt: msg.prompt });
      return undefined;
    }
    if (msg.type === "agentEnd") {
      options.onAgentEnd?.({ label: msg.label, phase: msg.phase, result: msg.result });
      return undefined;
    }
    if (msg.type === "agent") {
      // Async path: return a Promise that resolves to a JSON string.
      return (async () => {
        throwIfAborted();
        const opts = msg.opts ?? {};
        const result = await agentRunner.run(msg.prompt, {
          label: msg.label,
          schema: opts.schema,
          signal: options.signal,
          instructions: buildAgentInstructions(msg.phase, opts),
        } as any);
        throwIfAborted();
        const tokensSpent = estimateTokens(result);
        // Always return a string so the sandbox can JSON.parse with sandbox-realm JSON
        // and never holds a host-realm object reference.
        return JSON.stringify({ result: result === undefined ? null : result, tokensSpent });
      })();
    }
    throw new Error(`unknown bridge message type: ${(msg as { type: string }).type}`);
  };

  // Empty vm context. The sandbox uses its own realm intrinsics — passing host JSON,
  // Math, Array, Object, etc. would expose host-realm Function via `.constructor`
  // (e.g. `JSON.constructor.constructor("return process")()` reaches host process).
  // `codeGeneration.strings: false` blocks eval / new Function / new AsyncFunction
  // even via sandbox intrinsics, so the script cannot synthesize new code.
  const context = vm.createContext(
    { __bridge },
    {
      name: meta.name || "workflow",
      codeGeneration: { strings: false, wasm: false },
    },
  );

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );

  // Bootstrap runs in the sandbox realm and defines all workflow globals as
  // sandbox-realm closures that capture __bridge in local scope. The script body
  // sees only sandbox-realm values and cannot reach __bridge through `globalThis`.
  const bootstrapSource = `
"use strict";
const __b = __bridge;
delete globalThis.__bridge;

const __aborted = { value: false };
const __state = { spent: 0, agentCount: 0, currentPhase: undefined };
const __tokenBudget = ${JSON.stringify(tokenBudget)};
const __cwd = ${JSON.stringify(cwd)};
const __args = ${JSON.stringify(options.args === undefined ? null : options.args)};
const __concurrency = ${JSON.stringify(concurrency)};

const __sanitizeError = (e) => {
  const msg = (e && typeof e === "object" && "message" in e) ? String(e.message) : String(e);
  return new Error(msg);
};

const __callBridgeSync = (msg) => {
  try {
    __b(msg);
  } catch (e) {
    throw __sanitizeError(e);
  }
};

const __callBridgeAsync = async (msg) => {
  let s;
  try {
    s = await __b(msg);
  } catch (e) {
    throw __sanitizeError(e);
  }
  return s;
};

const __jsonClone = (v) => {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (e) {
    throw __sanitizeError(e);
  }
};

const __createLimiter = (limit) => {
  let active = 0;
  const queue = [];
  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return async (fn) => {
    if (active >= limit) {
      await new Promise((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
};

const __defaultLabel = (phase, index) =>
  phase ? phase + " agent " + index : "agent " + index;

const __limiter = __createLimiter(__concurrency);

globalThis.log = function log(message) {
  __callBridgeSync({ type: "log", message: String(message) });
};

globalThis.phase = function phase(title) {
  const t = String(title);
  __state.currentPhase = t;
  __callBridgeSync({ type: "phase", title: t });
};

globalThis.agent = async function agent(prompt, agentOptions) {
  if (__aborted.value) throw new Error("workflow aborted");
  if (__tokenBudget !== null && __tokenBudget - __state.spent <= 0) {
    throw new Error("workflow token budget exhausted");
  }
  const opts = agentOptions || {};
  const assignedPhase = (opts.phase !== undefined && opts.phase !== null)
    ? String(opts.phase)
    : __state.currentPhase;
  const requested = (opts.label !== undefined && opts.label !== null)
    ? String(opts.label).trim()
    : "";
  return __limiter(async () => {
    __state.agentCount += 1;
    const label = requested || __defaultLabel(assignedPhase, __state.agentCount);
    const promptStr = String(prompt);
    // Round-trip opts so host receives sandbox-realm-cloned primitives only.
    const safeOpts = __jsonClone({
      label: opts.label,
      phase: opts.phase,
      schema: opts.schema,
      model: opts.model,
      isolation: opts.isolation,
      agentType: opts.agentType,
    });
    __callBridgeSync({ type: "agentStart", label, phase: assignedPhase, prompt: promptStr });
    try {
      const s = await __callBridgeAsync({
        type: "agent",
        prompt: promptStr,
        label,
        phase: assignedPhase,
        opts: safeOpts,
      });
      // s is a host-realm string; JSON.parse with sandbox-realm JSON produces a sandbox-realm value.
      const parsed = (s === null || s === undefined) ? { result: null, tokensSpent: 0 } : JSON.parse(String(s));
      __state.spent += (parsed && typeof parsed.tokensSpent === "number") ? parsed.tokensSpent : 0;
      __callBridgeSync({ type: "agentEnd", label, phase: assignedPhase, result: parsed.result });
      return parsed.result;
    } catch (error) {
      const sanitized = __sanitizeError(error);
      __callBridgeSync({ type: "agentEnd", label, phase: assignedPhase, result: null });
      if (__aborted.value) throw sanitized;
      __callBridgeSync({ type: "log", message: "agent " + label + " failed: " + sanitized.message });
      return null;
    }
  });
};

globalThis.parallel = async function parallel(thunks) {
  if (__aborted.value) throw new Error("workflow aborted");
  if (!Array.isArray(thunks)) {
    throw new TypeError("parallel() expects an array of functions");
  }
  for (const thunk of thunks) {
    if (typeof thunk !== "function") {
      throw new TypeError(
        "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
      );
    }
  }
  return Promise.all(
    thunks.map(async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        const sanitized = __sanitizeError(error);
        if (__aborted.value) throw sanitized;
        __callBridgeSync({ type: "log", message: "parallel[" + index + "] failed: " + sanitized.message });
        return null;
      }
    }),
  );
};

globalThis.pipeline = async function pipeline(items, ...stages) {
  if (__aborted.value) throw new Error("workflow aborted");
  if (!Array.isArray(items)) {
    throw new TypeError("pipeline() expects an array as the first argument");
  }
  for (const stage of stages) {
    if (typeof stage !== "function") {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
  }
  return Promise.all(
    items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          if (__aborted.value) throw new Error("workflow aborted");
          value = await stage(value, item, index);
          if (__aborted.value) throw new Error("workflow aborted");
        } catch (error) {
          const sanitized = __sanitizeError(error);
          if (__aborted.value) throw sanitized;
          __callBridgeSync({
            type: "log",
            message: "pipeline[" + index + "] failed: " + sanitized.message,
          });
          return null;
        }
      }
      return value;
    }),
  );
};

globalThis.budget = Object.freeze({
  total: __tokenBudget,
  spent: () => __state.spent,
  remaining: () => __tokenBudget === null ? Infinity : Math.max(0, __tokenBudget - __state.spent),
});

globalThis.args = __args;
globalThis.cwd = __cwd;
globalThis.process = Object.freeze({ cwd: () => __cwd });
globalThis.console = Object.freeze({
  log: (m) => __callBridgeSync({ type: "log", message: String(m) }),
  info: (m) => __callBridgeSync({ type: "log", message: String(m) }),
  warn: (m) => __callBridgeSync({ type: "log", message: "[warn] " + String(m) }),
  error: (m) => __callBridgeSync({ type: "log", message: "[error] " + String(m) }),
});

globalThis.__setAborted = () => { __aborted.value = true; };
`;

  new vm.Script(bootstrapSource, { filename: "__workflow_bootstrap__.js" }).runInContext(context);

  const onAbort = () => {
    try {
      new vm.Script("__setAborted();", { filename: "__workflow_abort__.js" }).runInContext(context);
    } catch {
      // context may already be torn down; ignore.
    }
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let result: unknown;
  try {
    // Wrap the body in an inner async IIFE and JSON.stringify the result inside the
    // sandbox so the value reaching the host is a primitive string. This both
    // (a) yields host-realm output for callers and (b) prevents the sandbox from
    // handing the host a reference whose prototype chain leads back into the sandbox.
    const wrapped = `(async () => {
  const __r = await (async () => {
${body}
  })();
  return JSON.stringify(__r === undefined ? null : __r);
})()`;
    const serialized = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(
      context,
    );
    result = serialized == null ? null : JSON.parse(String(serialized));
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // Remove the abort hook from the context so it can be safely garbage-collected
    // and so a leaked reference can't be used after the workflow returns.
    try {
      new vm.Script("delete globalThis.__setAborted;", { filename: "__workflow_cleanup__.js" }).runInContext(context);
    } catch {
      // ignore
    }
  }

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new Error("Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable");
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description, phases }` must be the first statement in the script");
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

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  if (options.model) lines.push(`Requested model: ${options.model}`);
  return lines.length ? lines.join("\n") : undefined;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}
