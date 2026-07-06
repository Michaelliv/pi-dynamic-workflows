import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTranscriptMessage } from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow times out stuck agent branches", async () => {
  let aborted = false;
  const ended: unknown[] = [];
  const stuckAgent = {
    async run(_prompt: string, options: any): Promise<string> {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'timeout_demo', description: 'Timeout a stuck worker' }
const checks = await parallel([
  () => agent('hang', { label: 'stuck', timeout: '20ms' })
])
return { checks }`,
    {
      agent: stuckAgent,
      onAgentEnd(event) {
        ended.push(event);
      },
    },
  );

  assert.deepEqual((result.result as { checks: unknown[] }).checks, [null]);
  assert.equal(aborted, true);
  assert.match(result.logs.join("\n"), /agent stuck timed out after 20ms/);
  assert.equal((ended[0] as { result?: unknown }).result, null);
});

test("runWorkflow forwards numeric timeoutMs to the agent runner", async () => {
  const seen: unknown[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'timeout_forward', description: 'Forward timeout option' }
const r = await agent('work', { label: 'worker', timeoutMs: 1234 })
return { r }`,
    {
      agent: {
        async run(prompt: string, options: unknown): Promise<string> {
          seen.push(options);
          return `result:${prompt}`;
        },
      },
    },
  );

  assert.equal((result.result as { r: string }).r, "result:work");
  assert.equal((seen[0] as { timeoutMs?: number }).timeoutMs, 1234);
});

test("runWorkflow rejects invalid timeout strings", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'bad_timeout', description: 'Invalid timeout' }
await agent('work', { label: 'worker', timeout: 'later' })
return { ok: true }`,
        { agent: fakeAgent },
      ),
    /agent timeout strings/,
  );
});

test("runWorkflow passes model requests to the agent runner", async () => {
  const seen: unknown[] = [];
  const result = await runWorkflow(
    `export const meta = {
  name: 'model_demo',
  description: 'Pin a model for a worker'
}

const scan = await agent('scan', { label: 'scan', model: 'kimi-coding/k2p7' })
return { scan }
`,
    {
      agent: {
        async run(prompt: string, options: unknown): Promise<string> {
          seen.push(options);
          return `result:${prompt}`;
        },
      },
    },
  );

  assert.equal((result.result as { scan: string }).scan, "result:scan");
  assert.equal((seen[0] as { model?: string }).model, "kimi-coding/k2p7");
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    "result:Catalog Date.now(), Math.random(), and new Date() usage",
  );
});

test("runWorkflow keeps agentType: 'worker' on the in-memory agent when pi/ctx are present", async () => {
  const seen: unknown[] = [];
  const recordingAgent = {
    async run(prompt: string, options: unknown): Promise<string> {
      seen.push(options);
      return `memory:${prompt}`;
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'native_agent', description: 'agentType should stay native' }
const r = await agent('do work', { label: 'work', agentType: 'worker' })
return { r }`,
    {
      agent: recordingAgent,
      pi: {} as ExtensionAPI,
      ctx: {} as ExtensionContext,
    },
  );

  assert.equal((result.result as { r: string }).r, "memory:do work");
  assert.equal(result.logs.length, 0, "no adapter fallback logs when savedAgent is absent");
  const options = seen[0] as { agentType?: string; savedAgent?: string };
  assert.equal(options.agentType, "worker");
  assert.equal(options.savedAgent, undefined);
});

test("runWorkflow threads savedAgent through as the legacy escape hatch", async () => {
  const seen: unknown[] = [];
  const recordingAgent = {
    async run(prompt: string, options: unknown): Promise<string> {
      seen.push(options);
      return `memory:${prompt}`;
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'legacy_agent', description: 'savedAgent escape hatch' }
const r = await agent('do work', { label: 'work', savedAgent: 'legacy' })
return { r }`,
    {
      agent: recordingAgent,
      pi: {} as ExtensionAPI,
      ctx: {} as ExtensionContext,
    },
  );

  assert.equal((result.result as { r: string }).r, "memory:do work");
  const options = seen[0] as { savedAgent?: string };
  assert.equal(options.savedAgent, "legacy");
});

test("formatTranscriptMessage filters thinking and reasoning parts", () => {
  const text = formatTranscriptMessage({
    role: "assistant",
    provider: "test",
    model: "model",
    content: [
      { type: "Thinking", thinking: "secret" },
      { type: "reasoning_delta", text: "secret" },
      { type: "text", text: "visible" },
    ],
  });

  assert.equal(text, "[Assistant test/model]\nvisible");
});

test("runWorkflow records subagent reports with transcript and metrics", async () => {
  const ended: unknown[] = [];
  const recordingAgent = {
    async run(prompt: string, options: any): Promise<string> {
      options.onRunComplete?.({
        label: options.label,
        phase: options.phase,
        metrics: {
          provider: "test-provider",
          model: prompt,
          durationMs: 1000,
          tokensPerSecond: 12,
          toolCalls: prompt === "first" ? 1 : 2,
          toolResults: 0,
          tokens: { input: 1, output: 12, cacheRead: 0, cacheWrite: 0, total: prompt === "first" ? 13 : 14 },
          cost: 0,
        },
        transcript: `[User]\n${prompt}`,
      });
      return `result:${prompt}`;
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'reports', description: 'collect reports' }
phase('Verify')
const checks = await parallel([
  () => agent('first', { label: 'one' }),
  () => agent('second', { label: 'two' })
])
return { checks }`,
    {
      agent: recordingAgent,
      onAgentEnd(event) {
        ended.push(event);
      },
    },
  );

  assert.equal(result.agents.length, 2);
  assert.deepEqual(
    result.agents.map((agent) => agent.label),
    ["one", "two"],
  );
  assert.equal(result.agents[0].metrics.model, "first");
  assert.equal(result.agents[1].metrics.toolCalls, 2);
  assert.match(result.agents[0].transcript, /\[User\]\nfirst/);
  assert.equal((ended[0] as { report?: unknown }).report, result.agents[0]);
});

test("runWorkflow forwards live agent progress callbacks", async () => {
  const progress: unknown[] = [];
  const recordingAgent = {
    async run(_prompt: string, options: any): Promise<string> {
      options.onProgress?.({
        label: options.label,
        phase: options.phase,
        metrics: {
          provider: "test-provider",
          model: "worker",
          durationMs: 500,
          tokensPerSecond: 10,
          toolCalls: 1,
          toolResults: 1,
          tokens: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0, total: 6 },
          cost: 0,
        },
        transcript: "[Assistant test/model]\n[tool_call read] {}",
      });
      options.onRunComplete?.({
        label: options.label,
        phase: options.phase,
        metrics: {
          provider: "test-provider",
          model: "worker",
          durationMs: 1000,
          tokensPerSecond: 10,
          toolCalls: 2,
          toolResults: 2,
          tokens: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0, total: 12 },
          cost: 0,
        },
        transcript: "[Assistant test/model]\ndone",
      });
      return "result";
    },
  };

  await runWorkflow(
    `export const meta = { name: 'progress', description: 'live progress' }
const r = await agent('work', { label: 'worker' })
return { r }`,
    {
      agent: recordingAgent,
      onAgentProgress(event) {
        progress.push(event);
      },
    },
  );

  assert.equal(progress.length, 1);
  assert.equal((progress[0] as { label?: string }).label, "worker");
  assert.equal((progress[0] as { report?: { metrics?: { toolCalls?: number } } }).report?.metrics?.toolCalls, 1);
});

test("runWorkflow accepts multiple live progress callbacks before agent completion", async () => {
  const progress: unknown[] = [];
  const recordingAgent = {
    async run(_prompt: string, options: any): Promise<string> {
      options.onProgress?.({
        label: options.label,
        metrics: {
          durationMs: 100,
          tokensPerSecond: 10,
          toolCalls: 1,
          toolResults: 0,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          cost: 0,
        },
        transcript: "[Assistant test/model]\n[tool_trace grep: search src]",
      });
      options.onProgress?.({
        label: options.label,
        metrics: {
          durationMs: 200,
          tokensPerSecond: 10,
          toolCalls: 2,
          toolResults: 1,
          tokens: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, total: 4 },
          cost: 0,
        },
        transcript: "[Assistant test/model]\n[tool_call read] {}",
      });
      return "result";
    },
  };

  await runWorkflow(
    `export const meta = { name: 'progress', description: 'live progress' }
const r = await agent('work', { label: 'worker' })
return { r }`,
    {
      agent: recordingAgent,
      onAgentProgress(event) {
        progress.push(event);
      },
    },
  );

  assert.equal(progress.length, 2);
  assert.equal((progress[1] as { report?: { metrics?: { toolCalls?: number } } }).report?.metrics?.toolCalls, 2);
});
