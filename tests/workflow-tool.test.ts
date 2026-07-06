import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "../src/workflow-tool.js";

const fakePi = {} as ExtensionAPI;

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool(fakePi);

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name: 'short_snake_case', description:/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases: \[/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("meta.phases is optional metadata")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Phase names may be conditional or built in a loop")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("opts.timeout")));
});
