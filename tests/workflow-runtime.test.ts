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

test("runWorkflow blocks aliased Math.random at runtime", async () => {
  for (const expression of ["const f = Math.random; f()", "const r = Math['ra' + 'ndom']; r()"]) {
    await assert.rejects(
      () =>
        runWorkflow(`export const meta = { name: 'math_alias', description: 'Alias Math.random' }\n${expression}`, {
          agent: fakeAgent,
        }),
      /must be deterministic/,
      expression,
    );
  }
});

test("runWorkflow keeps deterministic Math methods working", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'math_ok', description: 'Use deterministic Math' }
return Math.max(1, 2) + Math.floor(1.5)
`,
    { agent: fakeAgent },
  );

  assert.equal(result.result, 3);
});

test("runWorkflow supports deterministic Date.parse and Date.UTC", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'date_ok', description: 'Use deterministic Date statics' }
return { parsed: Date.parse('2020-01-01T00:00:00Z'), utc: Date.UTC(2020, 0, 1) }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(structuredClone(result.result), { parsed: 1577836800000, utc: 1577836800000 });
});

test("runWorkflow drains pending agents when the script throws", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'throwing_script',
  description: 'Start an agent then throw'
}

agent('scan', { label: 'scan' })
throw new Error('boom')
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /boom/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow parallel preserves input order and maps failures to null", async () => {
  // Gate, not a timer: "slow" is released exactly when "fast" starts, so
  // completion order differs from input order deterministically.
  const gate = Promise.withResolvers<void>();
  const result = await runWorkflow(
    `export const meta = { name: 'parallel_demo', description: 'Check parallel ordering' }
const results = await parallel([
  () => agent('slow', { label: 'slow' }),
  () => agent('fail', { label: 'fail' }),
  () => agent('fast', { label: 'fast' }),
])
return { results }
`,
    {
      concurrency: 3,
      agent: {
        async run(prompt: string): Promise<string> {
          if (prompt === "fail") throw new Error("subagent exploded");
          if (prompt === "slow") await gate.promise;
          if (prompt === "fast") gate.resolve();
          return `result:${prompt}`;
        },
      },
    },
  );

  assert.deepEqual((result.result as { results: unknown[] }).results, ["result:slow", null, "result:fast"]);
  assert.ok(result.logs.some((line) => line.includes("agent fail failed: subagent exploded")));
});

test("runWorkflow pipeline passes (previous, original, index) and maps failures to null", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'pipeline_demo', description: 'Check pipeline semantics' }
const seen = []
const results = await pipeline(
  ['a', 'b', 'c'],
  (item, original, index) => {
    seen.push([item, original, index])
    return item + '1'
  },
  (prev, original, index) => agent(prev + '|' + original + '|' + index, { label: 'stage2 ' + original }),
)
return { results, seen }
`,
    {
      agent: {
        async run(prompt: string): Promise<string> {
          if (prompt.startsWith("b1|")) throw new Error("stage exploded");
          return `result:${prompt}`;
        },
      },
    },
  );

  // result.result was built inside the vm realm; structuredClone reifies it
  // into host-realm objects so deepStrictEqual prototype checks pass.
  assert.deepEqual(structuredClone(result.result), {
    results: ["result:a1|a|0", null, "result:c1|c|2"],
    seen: [
      ["a", "a", 0],
      ["b", "b", 1],
      ["c", "c", 2],
    ],
  });
  // stage 2 delegates to agent(), which catches its own failure and yields
  // the null the pipeline item resolves to
  assert.ok(result.logs.some((line) => line.includes("agent stage2 b failed: stage exploded")));
});
