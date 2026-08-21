import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";

/**
 * Persistent run records for workflow executions.
 *
 * Layout (per the persistence epic):
 *
 *   <root>/workflow-runs/<runId>/script.js   the inline script, persisted verbatim
 *   <root>/workflow-runs/<runId>/task.json   the run record (status + embedded snapshot)
 *
 * `task.json` is rewritten atomically (tmp + rename) on every snapshot update
 * and once more at terminal, so an external reader always sees a complete JSON
 * document whose `lastWriteAt` reflects the newest write. Persistence is
 * best-effort by design: a store failure must never fail a running workflow.
 */

export type WorkflowRunStatus = "running" | "completed" | "failed" | "killed";

export interface RunStoreOptions {
  /** Master switch. Defaults to enabled; config and env can also disable. */
  enabled?: boolean;
  /** Store root; records land at `<root>/workflow-runs/<runId>/`. Defaults to the host agent dir. */
  root?: string;
  /** Host stamp ("pi" | "omp"). Defaults to detection from the agent dir path. */
  harness?: string;
}

export interface ResolvedRunStoreConfig {
  enabled: boolean;
  root: string;
  harness: string;
  dialect: string;
}

export interface WorkflowRunRecordAgent extends WorkflowAgentSnapshot {
  /** Full agent result, untruncated (resultPreview stays display-sized). */
  result?: unknown;
}

export interface WorkflowRunRecord {
  schema: number;
  runId: string;
  name: string;
  dialect: string;
  harness: string;
  writer: string;
  scriptPath: string;
  cwd: string;
  args: unknown;
  status: WorkflowRunStatus;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  lastWriteAt: string;
  error: string | null;
  result: unknown;
  snapshot: Omit<WorkflowSnapshot, "agents"> & { agents: WorkflowRunRecordAgent[] };
  totals: {
    agents: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalTokens: number | null;
    toolCalls: number | null;
    cost: number | null;
    durationMs: number | null;
  };
}

export interface RunRecordWriter {
  readonly runId: string;
  readonly dir: string;
  /** Remember an agent's full result for the record (display keeps its preview). */
  recordAgentResult(agentId: number, result: unknown): void;
  /** Persist an in-flight snapshot (status stays "running"). */
  write(snapshot: WorkflowSnapshot): void;
  /** Persist the terminal record. */
  finish(snapshot: WorkflowSnapshot, outcome: { status: Exclude<WorkflowRunStatus, "running">; error?: string }): void;
}

const RUN_DIR_NAME = "workflow-runs";
const CONFIG_RELATIVE_PATH = ["extensions", "pi-dynamic-workflows", "config.json"];
const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

function writerVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { name?: string; version?: string };
    return `${pkg.name ?? "pi-dynamic-workflows"}@${pkg.version ?? "unknown"}`;
  } catch {
    return "pi-dynamic-workflows@unknown";
  }
}

function safeAgentDir(): string {
  try {
    return getAgentDir();
  } catch {
    return path.join(process.cwd(), ".pi-agent");
  }
}

/**
 * Detect the host from the agent dir path: pi's agent dir lives under `.pi`
 * and omp's under `.omp`. Config (`runStore.harness`), the
 * PI_DYNAMIC_WORKFLOWS_HARNESS env var, or programmatic options override
 * detection for exotic layouts.
 */
export function detectHarness(agentDir: string): string {
  const segments = agentDir.split(/[\\/]/);
  if (segments.includes(".omp")) return "omp";
  if (segments.includes(".pi")) return "pi";
  return "pi";
}

function readConfigFile(agentDir: string): RunStoreOptions {
  try {
    const file = path.join(agentDir, ...CONFIG_RELATIVE_PATH);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { runStore?: RunStoreOptions };
    const section = parsed?.runStore;
    if (!section || typeof section !== "object") return {};
    return {
      enabled: typeof section.enabled === "boolean" ? section.enabled : undefined,
      root: typeof section.root === "string" && section.root ? section.root : undefined,
      harness: typeof section.harness === "string" && section.harness ? section.harness : undefined,
    };
  } catch {
    return {};
  }
}

function readEnv(env: NodeJS.ProcessEnv): RunStoreOptions {
  const store = env.PI_DYNAMIC_WORKFLOWS_RUN_STORE?.trim();
  const harness = env.PI_DYNAMIC_WORKFLOWS_HARNESS?.trim();
  const options: RunStoreOptions = {};
  if (store !== undefined && store !== "") {
    if (DISABLE_VALUES.has(store.toLowerCase())) options.enabled = false;
    else options.root = store;
  }
  if (harness) options.harness = harness;
  return options;
}

/**
 * Resolve the effective run-store configuration. Precedence, highest first:
 * programmatic options, environment (PI_DYNAMIC_WORKFLOWS_RUN_STORE holds a
 * root path or a falsy value like "0"/"off" to disable;
 * PI_DYNAMIC_WORKFLOWS_HARNESS stamps the host), the host config file at
 * `<agentDir>/extensions/pi-dynamic-workflows/config.json` (`runStore`
 * section), then defaults (enabled, rooted at the agent dir, harness detected
 * from that dir's path).
 */
export function resolveRunStoreConfig(
  options: RunStoreOptions = {},
  agentDir: string = safeAgentDir(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRunStoreConfig {
  const fromEnv = readEnv(env);
  const fromFile = readConfigFile(agentDir);
  const enabled = options.enabled ?? fromEnv.enabled ?? fromFile.enabled ?? true;
  const root = options.root ?? fromEnv.root ?? fromFile.root ?? agentDir;
  const harness = options.harness ?? fromEnv.harness ?? fromFile.harness ?? detectHarness(agentDir);
  const dialect = harness === "omp" ? "omp-js" : "pi-js";
  return { enabled, root, harness, dialect };
}

export function mintRunId(): string {
  return `wf_${randomBytes(8).toString("hex")}`;
}

function atomicWriteFileSync(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Keep a value JSON-serializable; anything that refuses stringification is stringified as text. */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

function computeTotals(snapshot: WorkflowSnapshot): WorkflowRunRecord["totals"] {
  const totals: WorkflowRunRecord["totals"] = {
    agents: snapshot.agents.length,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    toolCalls: null,
    cost: null,
    durationMs: snapshot.durationMs ?? null,
  };
  for (const agent of snapshot.agents) {
    if (agent.tokens) {
      totals.inputTokens = (totals.inputTokens ?? 0) + agent.tokens.input;
      totals.outputTokens = (totals.outputTokens ?? 0) + agent.tokens.output;
      totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + agent.tokens.cacheRead;
      totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + agent.tokens.cacheWrite;
      totals.totalTokens = (totals.totalTokens ?? 0) + agent.tokens.total;
    }
    if (typeof agent.toolCalls === "number") totals.toolCalls = (totals.toolCalls ?? 0) + agent.toolCalls;
    if (typeof agent.cost === "number") totals.cost = (totals.cost ?? 0) + agent.cost;
  }
  return totals;
}

export interface OpenRunRecordInput {
  script: string;
  name: string;
  cwd: string;
  args?: unknown;
  options?: RunStoreOptions;
}

/**
 * Open a run record for one workflow execution. Returns null when the store is
 * disabled or the record cannot be created — persistence never fails a run.
 */
export function openRunRecord(input: OpenRunRecordInput): RunRecordWriter | null {
  let config: ResolvedRunStoreConfig;
  try {
    config = resolveRunStoreConfig(input.options);
  } catch {
    return null;
  }
  if (!config.enabled) return null;

  const runId = mintRunId();
  const dir = path.join(config.root, RUN_DIR_NAME, runId);
  const scriptPath = path.join(dir, "script.js");
  const taskPath = path.join(dir, "task.json");
  const createdAt = new Date().toISOString();
  const writer = writerVersion();
  const agentResults = new Map<number, unknown>();
  let finished = false;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(scriptPath, input.script);
  } catch {
    return null;
  }

  const serialize = (snapshot: WorkflowSnapshot, status: WorkflowRunStatus, error?: string): void => {
    const record: WorkflowRunRecord = {
      schema: 1,
      runId,
      name: input.name,
      dialect: config.dialect,
      harness: config.harness,
      writer,
      scriptPath,
      cwd: input.cwd,
      args: jsonSafe(input.args ?? null),
      status,
      createdAt,
      startedAt: createdAt,
      finishedAt: status === "running" ? null : new Date().toISOString(),
      lastWriteAt: new Date().toISOString(),
      error: error ?? null,
      result: status === "completed" ? jsonSafe(snapshot.result ?? null) : null,
      snapshot: {
        ...snapshot,
        result: jsonSafe(snapshot.result ?? null),
        agents: snapshot.agents.map((agent) => ({
          ...agent,
          result: jsonSafe(agentResults.get(agent.id) ?? null),
        })),
      },
      totals: computeTotals(snapshot),
    };
    try {
      atomicWriteFileSync(taskPath, `${JSON.stringify(record, null, 2)}\n`);
    } catch {
      // Best-effort: a full disk or revoked permission must not kill the run.
    }
  };

  return {
    runId,
    dir,
    recordAgentResult(agentId, result) {
      agentResults.set(agentId, result);
    },
    write(snapshot) {
      if (finished) return;
      serialize(snapshot, "running");
    },
    finish(snapshot, outcome) {
      if (finished) return;
      finished = true;
      serialize(snapshot, outcome.status, outcome.error);
    },
  };
}
