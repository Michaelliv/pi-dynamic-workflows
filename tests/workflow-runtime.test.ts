import assert from "node:assert/strict";
import test from "node:test";
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

test("runWorkflow passes per-agent model and thinking level to the agent runner", async () => {
  const calls: Array<{ prompt: string; options: { model?: string; thinkingLevel?: string; instructions?: string } }> =
    [];
  const agent = {
    async run(
      prompt: string,
      options: { model?: string; thinkingLevel?: string; instructions?: string },
    ): Promise<string> {
      calls.push({ prompt, options });
      return "ok";
    },
  };

  await runWorkflow(
    `export const meta = {
  name: 'model_demo',
  description: 'Use a per-agent model'
}

phase('Scan')
await agent('scan', { label: 'scan', model: 'haiku', thinkingLevel: 'low' })
`,
    { agent },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.prompt, "scan");
  assert.equal(calls[0]?.options.model, "haiku");
  assert.equal(calls[0]?.options.thinkingLevel, "low");
  assert.doesNotMatch(calls[0]?.options.instructions ?? "", /Requested model/);
});

test("runWorkflow rejects invalid per-agent thinking levels", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_thinking',
  description: 'Use an invalid thinking level'
}

await agent('scan', { label: 'scan', thinkingLevel: 'ludicrous' })
`,
        { agent: fakeAgent },
      ),
    /agent thinkingLevel must be one of: off, minimal, low, medium, high, xhigh/,
  );
});

test("runWorkflow surfaces agent option validation errors before scheduling the run", async () => {
  const logs: string[] = [];
  let started = 0;
  let ran = 0;
  const agent = {
    validateRunOptions() {
      throw new Error(
        'Unknown workflow agent model "sonnet". Use "provider/model-id" or a unique exact model id from the model registry. Did you mean: anthropic/claude-sonnet-4-20250514?',
      );
    },
    async run(): Promise<string> {
      ran++;
      return "ok";
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_model',
  description: 'Use an unknown model'
}

await agent('scan', { label: 'scan', model: 'sonnet' })
`,
        {
          agent,
          onAgentStart() {
            started++;
          },
          onLog(message) {
            logs.push(message);
          },
        },
      ),
    /Unknown workflow agent model "sonnet".*Did you mean: anthropic\/claude-sonnet-4-20250514/,
  );

  assert.equal(started, 0);
  assert.equal(ran, 0);
  assert.deepEqual(logs, []);
});

test("runWorkflow validates literal agent model options before executing the script", async () => {
  let phased = 0;
  let ran = 0;
  const agent = {
    validateRunOptions(options: { model?: string }) {
      if (options.model === "sonnet") throw new Error('Unknown workflow agent model "sonnet"');
    },
    async run(): Promise<string> {
      ran++;
      return "ok";
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'static_bad_model',
  description: 'Use an unknown literal model'
}

phase('Should not run')
await agent('scan', { label: 'scan', model: 'sonnet' })
`,
        {
          agent,
          onPhase() {
            phased++;
          },
        },
      ),
    /Unknown workflow agent model "sonnet"/,
  );

  assert.equal(phased, 0);
  assert.equal(ran, 0);
});

test("runWorkflow leaves dynamic agent model options to runtime validation", async () => {
  const calls: Array<{ model?: string }> = [];
  const agent = {
    validateRunOptions(options: { model?: string }) {
      calls.push(options);
    },
    async run(): Promise<string> {
      return "ok";
    },
  };

  await runWorkflow(
    `export const meta = {
  name: 'dynamic_model',
  description: 'Use a dynamic model'
}

const selected = 'haiku'
await agent('scan', { label: 'scan', model: selected })
`,
    { agent },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, "haiku");
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
