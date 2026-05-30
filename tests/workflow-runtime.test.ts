import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

interface StubResult {
  prompts: string[];
  fn: (prompt: string) => Promise<unknown>;
}

const stubAgent = (handler?: (prompt: string) => unknown | Promise<unknown>): StubResult => {
  const prompts: string[] = [];
  return {
    prompts,
    fn: async (prompt: string) => {
      prompts.push(prompt);
      return handler ? handler(prompt) : `echo: ${prompt}`;
    },
  };
};

const makeRunner = (handler?: (prompt: string) => unknown | Promise<unknown>) => {
  const stub = stubAgent(handler);
  return { runner: { run: stub.fn }, prompts: stub.prompts };
};

// --- security: vm sandbox prevents host-realm escape ---

test("sandbox blocks host escape via log.constructor.constructor", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'esc1', description: 'log escape' }
  let leaked = null;
  try {
    const F = log.constructor.constructor;
    const proc = F("return process")();
    leaked = proc && proc.pid;
  } catch (e) {
    leaked = "blocked:" + (e && e.message ? e.message : String(e));
  }
  await agent("probe");
  return leaked;
  `;
  const result = await runWorkflow(script, { agent: runner });
  assert.match(String(result.result), /^blocked:/);
});

test("sandbox blocks host escape via async-function-prototype.constructor", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'esc2', description: 'async escape' }
  let leaked = null;
  try {
    const AF = Object.getPrototypeOf(async function(){}).constructor;
    const proc = AF("return process")();
    leaked = proc && proc.pid;
  } catch (e) {
    leaked = "blocked:" + (e && e.message ? e.message : String(e));
  }
  await agent("probe");
  return leaked;
  `;
  const result = await runWorkflow(script, { agent: runner });
  assert.match(String(result.result), /^blocked:/);
});

test("sandbox blocks new Function and eval", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'esc3', description: 'no eval' }
  const out = [];
  try { out.push(new Function('return 42')()); } catch (e) { out.push('blocked-Function:' + (e && e.message ? e.message : String(e))); }
  try { out.push(eval('42')); } catch (e) { out.push('blocked-eval:' + (e && e.message ? e.message : String(e))); }
  await agent("probe");
  return out;
  `;
  const result = await runWorkflow(script, { agent: runner });
  const out = result.result as string[];
  assert.match(String(out[0]), /^blocked-Function:/);
  assert.match(String(out[1]), /^blocked-eval:/);
});

test("sandbox blocks host escape via budget.spent.constructor", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'esc4', description: 'budget escape' }
  let leaked = null;
  try {
    const F = budget.spent.constructor.constructor;
    const proc = F("return process")();
    leaked = proc && proc.pid;
  } catch (e) {
    leaked = "blocked:" + (e && e.message ? e.message : String(e));
  }
  await agent("probe");
  return leaked;
  `;
  const result = await runWorkflow(script, { agent: runner });
  assert.match(String(result.result), /^blocked:/);
});

test("sandbox cannot reach __bridge through globalThis", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'esc5', description: 'no bridge' }
  await agent("probe");
  return {
    bridgeOnGlobal: typeof globalThis.__bridge,
    bridgeDirect: typeof (typeof __bridge === "undefined" ? undefined : __bridge),
  };
  `;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal((result.result as Record<string, unknown>).bridgeOnGlobal, "undefined");
  assert.equal((result.result as Record<string, unknown>).bridgeDirect, "undefined");
});

test("sandbox process.cwd() returns configured path and cannot reach host env", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'esc6', description: 'no env' }
  await agent("probe");
  const out = { cwd: process.cwd(), envType: typeof process.env, mainModule: typeof process.mainModule };
  return out;
  `;
  const result = await runWorkflow(script, { agent: runner, cwd: "/tmp/configured" });
  assert.equal((result.result as Record<string, unknown>).cwd, "/tmp/configured");
  assert.equal((result.result as Record<string, unknown>).envType, "undefined");
  assert.equal((result.result as Record<string, unknown>).mainModule, "undefined");
});

test("agent error is normalized to sandbox-realm Error and cannot leak host", async () => {
  const erroringRunner = {
    run: async () => {
      throw new Error("boom from host");
    },
  };
  const script = `export const meta = { name: 'esc7', description: 'error normalization' }
  let leaked = null;
  try {
    await agent("probe");
  } catch (e) {
    // agent() catches its own errors and returns null, so this catch never fires.
    leaked = "caught:" + (e && e.message ? e.message : String(e));
  }
  // parallel rethrow path also normalizes:
  let parallelLeak = null;
  try {
    parallelLeak = await parallel([() => { throw new Error("inner-host"); }]);
  } catch (e) {
    parallelLeak = "thrown:" + e.message;
  }
  return { leaked, parallelLeak };
  `;
  const result = await runWorkflow(script, { agent: erroringRunner });
  // agent() swallows and returns null, so leaked stays null
  assert.equal((result.result as Record<string, unknown>).leaked, null);
  // parallel catches and returns [null] without throwing host error
  assert.deepEqual((result.result as Record<string, unknown>).parallelLeak, [null]);
});

// --- functional: existing API surface preserved ---

test("runWorkflow runs agent + parallel + pipeline + log + phase + budget", async () => {
  const logs: string[] = [];
  const phases: string[] = [];
  const { runner, prompts } = makeRunner((p) => `echo: ${p}`);
  const script = `export const meta = { name: 'happy', description: 'verify api', phases: [{ title: 'A' }, { title: 'B' }] }
  phase('A')
  log('starting')
  const r1 = await agent('one', { label: 'first' })
  const r2 = await parallel([() => agent('two'), () => agent('three')])
  const r3 = await pipeline(['x', 'y'], (item) => agent('p:' + item))
  phase('B')
  log('budget total: ' + String(budget.total))
  return { r1, r2, r3, agentCount: budget.spent() > 0 ? 'spent' : 'zero' }
  `;
  const result = await runWorkflow(script, {
    agent: runner,
    onLog: (m) => logs.push(m),
    onPhase: (t) => phases.push(t),
  });
  const out = result.result as Record<string, unknown>;
  assert.equal(out.r1, "echo: one");
  assert.deepEqual(out.r2, ["echo: two", "echo: three"]);
  assert.deepEqual(out.r3, ["echo: p:x", "echo: p:y"]);
  assert.deepEqual(phases, ["A", "B"]);
  assert.equal(logs.includes("starting"), true);
  assert.equal(result.phases.length, 2);
  assert.equal(result.agentCount, 5);
  // Each prompt was passed verbatim
  assert.deepEqual(prompts, ["one", "two", "three", "p:x", "p:y"]);
});

test("runWorkflow exposes args and cwd to the script", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'arg', description: 'args + cwd' }
  await agent('probe')
  return { args, cwd }
  `;
  const result = await runWorkflow(script, {
    agent: runner,
    args: { mode: "test", count: 3, nested: { k: "v" } },
    cwd: "/var/work",
  });
  const out = result.result as Record<string, unknown>;
  assert.deepEqual(out.args, { mode: "test", count: 3, nested: { k: "v" } });
  assert.equal(out.cwd, "/var/work");
});

test("token budget exhaustion blocks further agent calls", async () => {
  // Each stubbed agent result JSON-serialized to a long-ish string drives budget usage.
  const { runner } = makeRunner((p) => `result for ${p} `.repeat(50));
  const script = `export const meta = { name: 'budget', description: 'budget guard' }
  const results = []
  for (let i = 0; i < 10; i++) {
    if (budget.remaining() <= 0) break;
    results.push(await agent('q' + i))
  }
  return { count: results.length, spent: budget.spent(), remaining: budget.remaining() }
  `;
  const result = await runWorkflow(script, { agent: runner, tokenBudget: 200 });
  const out = result.result as Record<string, number>;
  assert.ok(out.count >= 1, "at least one agent ran");
  assert.ok(out.count < 10, "budget capped further calls");
  assert.equal(out.remaining, 0);
});

test("parallel() rejects non-function thunks", async () => {
  const { runner } = makeRunner();
  const script = `export const meta = { name: 'pe', description: 'parallel type-check' }
  let caught = null;
  try { await parallel([Promise.resolve(1)]); } catch (e) { caught = e.message; }
  await agent('probe')
  return caught;
  `;
  const result = await runWorkflow(script, { agent: runner });
  assert.match(String(result.result), /array of functions/);
});

test("abort signal halts further agent calls", async () => {
  const controller = new AbortController();
  let runs = 0;
  const slowRunner = {
    run: async (_prompt: string) => {
      runs += 1;
      if (runs === 1) {
        controller.abort();
        return "first";
      }
      return "should-not-reach";
    },
  };
  const script = `export const meta = { name: 'abr', description: 'abort propagation' }
  const r1 = await agent('one')
  // After the first agent call, signal is aborted; agent() should throw.
  let err = null;
  try { await agent('two'); } catch (e) { err = e.message; }
  return { r1, err };
  `;
  let caught: Error | null = null;
  try {
    await runWorkflow(script, { agent: slowRunner, signal: controller.signal });
  } catch (e) {
    caught = e as Error;
  }
  // Either the workflow throws "workflow aborted" before returning, or it returns
  // with the second agent call's error captured. Both prove abort propagation.
  if (caught) {
    assert.match(caught.message, /abort/i);
  }
  assert.equal(runs, 1);
});
