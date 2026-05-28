# pi-dynamic-workflows

Prototype building blocks for Claude-Code-style dynamic workflows on top of Pi.

Implemented so far:

- `WorkflowAgent` — spawns an in-memory Pi SDK session as a subagent.
- `createStructuredOutputTool()` — creates a terminating `structured_output` tool from a TypeBox schema and captures the validated result.

## Example

```ts
import { Type } from "typebox";
import { WorkflowAgent } from "./src/index.js";

const Result = Type.Object({
  summary: Type.String(),
  files: Type.Array(Type.String()),
});

const agent = new WorkflowAgent({ cwd: process.cwd() });

const result = await agent.run("Inspect this project and summarize it.", {
  label: "project-summary",
  schema: Result,
});

// result is typed as Static<typeof Result>
console.log(result.summary, result.files);
```

Without `schema`, `agent.run()` returns the last assistant text.

## Notes

- Structured output is implemented as a normal Pi custom tool with `terminate: true`.
- Pi validates tool arguments against the TypeBox schema before `execute()` runs.
- The subagent gets an instruction requiring its final action to be `structured_output`.
- The default subagent tools are Pi's coding tools for the configured `cwd`.
