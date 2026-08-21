# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

```bash
pi install npm:pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers a `workflow` tool and activates it on session start.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Press `Esc` to cancel a running workflow. Active subagents are aborted and surfaced as skipped.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, and `budget` for TypeScript-aware editors.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text or, with `opts.schema`, a validated object. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Determinism rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, template interpolation, function calls inside `meta`

This keeps `meta` parseable, runs reproducible, and the surface area small.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs script in a vm sandbox
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an in-memory Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal Pi turn.

## Run store

Every workflow execution persists a run record (first slice of the
persisted/resumable-workflows epic):

```text
<root>/workflow-runs/<runId>/script.js   the inline script, persisted verbatim
<root>/workflow-runs/<runId>/task.json   the run record
```

- `runId` is `wf_<16 hex chars>`, minted per execution and surfaced in the
  tool's final text (`Run: wf_…`) and result details.
- `task.json` is rewritten atomically (tmp + rename) on every snapshot update
  and once more at terminal, so external readers always see complete JSON with
  a fresh `lastWriteAt`. Status vocabulary: `running`, `completed`, `failed`,
  `killed` (aborted).
- The record embeds the full workflow snapshot enriched at source: per-agent
  wall-clock `startedAt`/`endedAt`, real token usage and cost from
  `AgentSession.getSessionStats()` (read before the session is disposed), and
  each agent's full result text — the 80-char preview remains display-only.
- The record carries explicit `harness` (`pi` | `omp`) and `dialect`
  (`pi-js` | `omp-js`) stamps. The host is detected from the agent dir path
  (`~/.pi/...` vs `~/.omp/...`) and can be overridden.

Configuration (highest precedence first):

1. `createWorkflowTool({ runStore: { enabled, root, harness } })`, or
   `runStore: false` to disable persistence entirely.
2. Environment: `PI_DYNAMIC_WORKFLOWS_RUN_STORE` (a store root path, or
   `0`/`false`/`off` to disable) and `PI_DYNAMIC_WORKFLOWS_HARNESS`.
3. Host config file `<agentDir>/extensions/pi-dynamic-workflows/config.json`:
   `{ "runStore": { "enabled": true, "root": "/path", "harness": "pi" } }`.
4. Defaults: enabled, rooted at the host agent dir (`getAgentDir()`), harness
   detected from that dir.

Persistence is best-effort: a store failure never fails a running workflow.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and sandboxed workflow runtime. |
| `src/workflow-tool.ts` | The Pi `workflow` tool, prompt guidelines, rendering, abort handling. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory Pi subagent runner. |
| `src/run-store.ts` | Persistent run records under `workflow-runs/<runId>/`. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `extensions/workflow.ts` | The Pi extension entrypoint. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

Parser unit tests live in `tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## Status

This is a prototype. It implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) and persists a run record per execution, but does not yet implement resumable runs or a `/workflows` manager.

## License

MIT
