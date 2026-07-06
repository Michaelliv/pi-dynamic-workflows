import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "../src/display.js";

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: "demo_workflow",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides,
  });
}

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: "scan repo",
    phase: "Scan",
    prompt: "Scan the repo",
    status: "done",
    ...overrides,
  };
}

test("createWorkflowSnapshot does not pre-render declared phases", () => {
  const value = createWorkflowSnapshot({
    name: "demo_workflow",
    description: "A useful workflow",
    phases: [{ title: "Scan" }, { title: "Review" }],
  });

  assert.deepEqual(value.phases, []);
});

test("renderWorkflowLines hides empty phase rows", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan", "Review"],
      agents: [agent()],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Scan 1/1")));
  assert.ok(!lines.some((line) => line.includes("Review 0/0")));
});

test("renderWorkflowLines keeps the current empty phase visible", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      currentPhase: "Scan",
    }),
  );

  assert.ok(lines.some((line) => line.includes("▶ Scan 0/0")));
});

test("renderWorkflowLines groups agents by phase even when the phase was not pre-recorded", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      agents: [agent({ id: 2, label: "review diff", phase: "Review" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Review 1/1")));
  assert.ok(!lines.some((line) => line.trim() === "Unphased"));
});

test("renderWorkflowLines renders runtime-created phases from the phase list", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Inspect API"],
      agents: [agent({ label: "inspect api", phase: "Inspect API" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Inspect API 1/1")));
});

test("renderWorkflowText respects log limits", () => {
  const text = renderWorkflowText(
    snapshot({
      logs: ["first", "second", "third"],
    }),
    true,
    { maxLogs: 1 },
  );

  assert.doesNotMatch(text, /log: first/);
  assert.doesNotMatch(text, /log: second/);
  assert.match(text, /log: third/);
});

test("renderWorkflowLines separates logs from progress", () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent()],
      logs: ["finished scan"],
    }),
  );

  const logIndex = lines.findIndex((line) => line.includes("log: finished scan"));
  assert.ok(logIndex > 0);
  assert.equal(lines[logIndex - 1], "");
});

test("renderWorkflowLines shows subagent model and usage metrics", () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent({ model: "openai/gpt", durationMs: 2300, toolCalls: 2, totalTokens: 1532 })],
    }),
    { showResultPreviews: true },
  );

  assert.ok(lines.some((line) => line.includes("openai/gpt · 2.3s · 2 tools · 1.5k tok")));
});

test("renderWorkflowLines renders title, subtitle, and agent progress preview", () => {
  const lines = renderWorkflowLines(
    snapshot({
      currentPhase: "Scan",
      agents: [
        agent({
          status: "running",
          resultPreview: "grep src for workflow hooks",
          model: "cursor/composer",
          durationMs: 1200,
          toolCalls: 1,
        }),
      ],
    }),
    { showResultPreviews: true },
  );

  assert.match(lines[0], /^Workflow: demo_workflow — 0\/1 done · 1 running$/);
  assert.match(lines[1], /^Phase: Scan · Active: scan repo · grep src for workflow hooks$/);
  assert.ok(lines.some((line) => line.includes("cursor/composer · 1.2s · 1 tools")));
  assert.ok(lines.some((line) => line.includes("grep src for workflow hooks")));
});

test("createToolUpdateWorkflowDisplay with streamToolUpdates does not touch below-editor widget", () => {
  const calls: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget(key: string, value: unknown) {
        calls.push(`${key}:${value === undefined ? "clear" : "set"}`);
      },
      setStatus() {},
    },
  };
  const display = createToolUpdateWorkflowDisplay(undefined, ctx, {
    streamToolUpdates: true,
    key: "workflow",
  });
  const snap = snapshot({ agents: [agent({ status: "running" })] });
  display.update(snap);
  display.complete(snap);
  display.clear();
  assert.equal(calls.length, 0);
});
