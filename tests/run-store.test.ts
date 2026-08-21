import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { createWorkflowSnapshot, recomputeWorkflowSnapshot } from "../src/display.js";
import {
  detectHarness,
  mintRunId,
  openRunRecord,
  resolveRunStoreConfig,
  type WorkflowRunRecord,
} from "../src/run-store.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

const RUN_ID_RE = /^wf_[0-9a-f]{16}$/;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "run-store-"));
}

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionFile: undefined,
    sessionId: "session-test",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 2,
    tokens: { input: 70, output: 30, cacheRead: 10, cacheWrite: 1, total: 111 },
    cost: 0.0042,
    ...overrides,
  };
}

const statsAgent = {
  async run(prompt: string, options: { onStats?: (stats: SessionStats) => void } = {}): Promise<string> {
    options.onStats?.(makeStats());
    return `full result for ${prompt}: ${"detail ".repeat(30)}`;
  },
};

const DEMO_SCRIPT = `export const meta = { name: 'store_demo', description: 'exercise the run store' }

phase('Gather')
const inventory = await agent('collect the inventory', { label: 'inventory' })
phase('Write')
const summary = await agent('write the summary', { label: 'summary' })
return { ok: true, inventory, summary }
`;

async function runDemoWorkflow(root: string): Promise<{ record: WorkflowRunRecord; result: any; runDir: string }> {
  const tool = createWorkflowTool({
    cwd: root,
    agent: statsAgent,
    runStore: { enabled: true, root, harness: "pi" },
  });
  const result = await (tool as any).execute(
    "call-1",
    { script: DEMO_SCRIPT, args: { area: "test" } },
    undefined,
    undefined,
    { cwd: root },
  );
  const runsDir = path.join(root, "workflow-runs");
  const entries = fs.readdirSync(runsDir);
  assert.equal(entries.length, 1);
  const runDir = path.join(runsDir, entries[0]);
  const record = JSON.parse(fs.readFileSync(path.join(runDir, "task.json"), "utf8")) as WorkflowRunRecord;
  return { record, result, runDir };
}

test("mintRunId mints unique wf_<hex> ids", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const id = mintRunId();
    assert.match(id, RUN_ID_RE);
    ids.add(id);
  }
  assert.equal(ids.size, 1000);
});

test("detectHarness reads the host from the agent dir path", () => {
  assert.equal(detectHarness("/Users/x/.pi/agent"), "pi");
  assert.equal(detectHarness("/Users/x/.omp/agent"), "omp");
  assert.equal(detectHarness("/srv/agents/home"), "pi");
});

test("resolveRunStoreConfig defaults to an enabled store rooted at the agent dir", () => {
  const resolved = resolveRunStoreConfig({}, "/Users/x/.pi/agent", {});
  assert.deepEqual(resolved, { enabled: true, root: "/Users/x/.pi/agent", harness: "pi", dialect: "pi-js" });

  const omp = resolveRunStoreConfig({}, "/Users/x/.omp/agent", {});
  assert.deepEqual(omp, { enabled: true, root: "/Users/x/.omp/agent", harness: "omp", dialect: "omp-js" });
});

test("resolveRunStoreConfig honors env overrides", () => {
  const custom = resolveRunStoreConfig({}, "/Users/x/.pi/agent", { PI_DYNAMIC_WORKFLOWS_RUN_STORE: "/tmp/custom" });
  assert.equal(custom.root, "/tmp/custom");
  assert.equal(custom.enabled, true);

  const disabled = resolveRunStoreConfig({}, "/Users/x/.pi/agent", { PI_DYNAMIC_WORKFLOWS_RUN_STORE: "0" });
  assert.equal(disabled.enabled, false);

  const stamped = resolveRunStoreConfig({}, "/Users/x/.pi/agent", { PI_DYNAMIC_WORKFLOWS_HARNESS: "omp" });
  assert.equal(stamped.harness, "omp");
  assert.equal(stamped.dialect, "omp-js");
});

test("resolveRunStoreConfig reads the host config file, and options win over it", () => {
  const agentDir = tmpRoot();
  const configDir = path.join(agentDir, "extensions", "pi-dynamic-workflows");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ runStore: { root: "/data/workflow-store", harness: "omp" } }),
  );

  const fromFile = resolveRunStoreConfig({}, agentDir, {});
  assert.equal(fromFile.root, "/data/workflow-store");
  assert.equal(fromFile.harness, "omp");
  assert.equal(fromFile.dialect, "omp-js");

  const overridden = resolveRunStoreConfig({ root: "/elsewhere", harness: "pi" }, agentDir, {});
  assert.equal(overridden.root, "/elsewhere");
  assert.equal(overridden.harness, "pi");
});

test("openRunRecord writes script.js and an atomic task.json pointer record", () => {
  const root = tmpRoot();
  const run = openRunRecord({
    script: "export const meta = { name: 'atomic_demo', description: 'd' }\nreturn 1",
    name: "atomic_demo",
    cwd: root,
    options: { enabled: true, root, harness: "pi" },
  });
  assert.ok(run);
  assert.match(run.runId, RUN_ID_RE);

  let snapshot = createWorkflowSnapshot({ name: "atomic_demo", description: "d" });
  run.write(snapshot);

  const taskPath = path.join(run.dir, "task.json");
  assert.ok(fs.existsSync(path.join(run.dir, "script.js")));
  assert.ok(fs.existsSync(taskPath));
  assert.ok(!fs.existsSync(`${taskPath}.tmp`), "tmp file must not survive a write");

  const running = JSON.parse(fs.readFileSync(taskPath, "utf8")) as WorkflowRunRecord;
  assert.equal(running.status, "running");
  assert.equal(running.finishedAt, null);
  assert.ok(Date.parse(running.lastWriteAt) > 0);

  snapshot.agents.push({ id: 1, label: "only", prompt: "p", status: "done" });
  snapshot.result = { ok: true };
  snapshot = recomputeWorkflowSnapshot(snapshot);
  run.finish(snapshot, { status: "completed" });

  const finished = JSON.parse(fs.readFileSync(taskPath, "utf8")) as WorkflowRunRecord;
  assert.equal(finished.status, "completed");
  assert.ok(finished.finishedAt);
  assert.deepEqual(finished.result, { ok: true });

  // The writer is terminal-once: later writes must not resurrect the record.
  run.write(snapshot);
  const after = JSON.parse(fs.readFileSync(taskPath, "utf8")) as WorkflowRunRecord;
  assert.equal(after.status, "completed");
});

test("workflow tool persists a completed record with stamps, timestamps, and real tokens", async () => {
  const root = tmpRoot();
  const { record, result } = await runDemoWorkflow(root);

  assert.match(record.runId, RUN_ID_RE);
  assert.equal(record.schema, 1);
  assert.equal(record.name, "store_demo");
  assert.equal(record.harness, "pi");
  assert.equal(record.dialect, "pi-js");
  assert.match(record.writer, /^pi-dynamic-workflows@/);
  assert.equal(record.status, "completed");
  assert.equal(record.cwd, root);
  assert.deepEqual(record.args, { area: "test" });
  assert.ok(record.finishedAt && Date.parse(record.finishedAt) >= Date.parse(record.startedAt));
  assert.ok(Date.parse(record.lastWriteAt) > 0);
  assert.equal(record.error, null);
  assert.deepEqual(record.snapshot.phases, ["Gather", "Write"]);

  assert.equal(record.snapshot.agents.length, 2);
  for (const agent of record.snapshot.agents) {
    assert.equal(agent.status, "done");
    assert.ok(agent.startedAt && Date.parse(agent.startedAt) > 0);
    assert.ok(agent.endedAt && Date.parse(agent.endedAt) >= Date.parse(agent.startedAt));
    assert.deepEqual(agent.tokens, { input: 70, output: 30, cacheRead: 10, cacheWrite: 1, total: 111 });
    assert.equal(agent.cost, 0.0042);
    assert.equal(agent.toolCalls, 3);
    // The record keeps the full result; the display preview stays truncated.
    assert.ok(typeof agent.result === "string" && agent.result.length > 80);
    assert.ok((agent.resultPreview ?? "").length <= 80);
  }

  assert.equal(record.totals.agents, 2);
  assert.equal(record.totals.totalTokens, 222);
  assert.equal(record.totals.inputTokens, 140);
  assert.equal(record.totals.toolCalls, 6);
  assert.ok(typeof record.totals.durationMs === "number");

  // The persisted script matches what ran, and the run id is surfaced.
  assert.equal(fs.readFileSync(record.scriptPath, "utf8"), DEMO_SCRIPT.trim());
  assert.equal(result.details.runId, record.runId);
  assert.ok(result.content[0].text.includes(`Run: ${record.runId}`));
});

test("an aborted workflow leaves a killed record", async () => {
  const root = tmpRoot();
  const controller = new AbortController();
  const abortingAgent = {
    async run(): Promise<string> {
      controller.abort();
      throw new Error("aborted");
    },
  };
  const tool = createWorkflowTool({
    cwd: root,
    agent: abortingAgent,
    runStore: { enabled: true, root, harness: "omp" },
  });

  await assert.rejects(
    (tool as any).execute(
      "call-2",
      { script: "export const meta = { name: 'kill_demo', description: 'd' }\nawait agent('x', { label: 'x' })" },
      controller.signal,
      undefined,
      { cwd: root },
    ),
    /aborted/i,
  );

  const runsDir = path.join(root, "workflow-runs");
  const [entry] = fs.readdirSync(runsDir);
  const record = JSON.parse(fs.readFileSync(path.join(runsDir, entry, "task.json"), "utf8")) as WorkflowRunRecord;
  assert.equal(record.status, "killed");
  assert.equal(record.error, "aborted");
  assert.equal(record.harness, "omp");
  assert.equal(record.dialect, "omp-js");
  assert.ok(record.finishedAt);
});

test("a workflow that never calls agent() leaves a failed record", async () => {
  const root = tmpRoot();
  const tool = createWorkflowTool({
    cwd: root,
    agent: statsAgent,
    runStore: { enabled: true, root, harness: "pi" },
  });

  await assert.rejects(
    (tool as any).execute(
      "call-3",
      { script: "export const meta = { name: 'no_agents', description: 'd' }\nreturn { ok: true }" },
      undefined,
      undefined,
      { cwd: root },
    ),
    /must call agent\(\) at least once/,
  );

  const runsDir = path.join(root, "workflow-runs");
  const [entry] = fs.readdirSync(runsDir);
  const record = JSON.parse(fs.readFileSync(path.join(runsDir, entry, "task.json"), "utf8")) as WorkflowRunRecord;
  assert.equal(record.status, "failed");
  assert.match(record.error ?? "", /must call agent\(\) at least once/);
});

test("runStore: false disables persistence", async () => {
  const root = tmpRoot();
  const tool = createWorkflowTool({ cwd: root, agent: statsAgent, runStore: false });
  const result = await (tool as any).execute(
    "call-4",
    { script: "export const meta = { name: 'quiet', description: 'd' }\nreturn await agent('x', { label: 'x' })" },
    undefined,
    undefined,
    { cwd: root },
  );
  assert.ok(!fs.existsSync(path.join(root, "workflow-runs")));
  assert.equal(result.details.runId, undefined);
});

test("the committed fixture matches the writer's record shape", async () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "fixtures", "run-record.json"), "utf8"),
  ) as WorkflowRunRecord;
  const { record } = await runDemoWorkflow(tmpRoot());

  const keyShape = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.length ? [keyShape(value[0])] : [];
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, keyShape((value as Record<string, unknown>)[key])]),
      );
    }
    return typeof value;
  };

  assert.deepEqual(keyShape(record), keyShape(fixture));
  assert.match(fixture.runId, RUN_ID_RE);
  assert.equal(fixture.status, "completed");
});
