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

test("runWorkflow forwards the model option into the agent runner", async () => {
  const calls: any[] = [];
  const capturingAgent = {
    async run(_prompt: string, opts: any): Promise<string> {
      calls.push(opts);
      return "ok";
    },
  };

  await runWorkflow(
    `export const meta = {
  name: 'model_forwarding',
  description: 'Forward the model option'
}

phase('Run')
await agent('do it', { label: 'x', model: 'some-model' })
return { ok: true }
`,
    { agent: capturingAgent },
  );

  assert.equal(calls[0].model, "some-model");
});

test("runWorkflow surfaces the resolved model before agent completion", async () => {
  const modelReportingAgent = {
    async run(_prompt: string, opts: any): Promise<string> {
      opts.onModel?.("anthropic/claude-haiku-4-5");
      return "ok";
    },
  };
  const events: string[] = [];
  const ended: any[] = [];

  await runWorkflow(
    `export const meta = {
  name: 'model_reporting',
  description: 'Report the resolved model'
}

phase('Run')
await agent('do it', { label: 'x', model: 'haiku' })
return { ok: true }
`,
    {
      agent: modelReportingAgent,
      onAgentModel: (event) => events.push(`model:${event.model}`),
      onAgentEnd: (event) => {
        events.push("end");
        ended.push(event);
      },
    },
  );

  assert.deepEqual(events, ["model:anthropic/claude-haiku-4-5", "end"]);
  assert.equal(ended[0].model, "anthropic/claude-haiku-4-5");
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
