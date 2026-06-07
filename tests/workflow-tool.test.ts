import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkflowTool, resolveWorkflowTranscriptDir } from "../src/workflow-tool.js";

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name: 'short_snake_case', description:/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases: \[/);
  assert.ok(tool.description.includes("scriptPath"));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("meta.phases is optional metadata")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Phase names may be conditional or built in a loop")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("exactly one of script or scriptPath")));
});

test("createWorkflowTool accepts scriptPath relative to cwd", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-script-path-"));
  try {
    await writeFile(
      path.join(dir, "tiny.workflow.js"),
      `export const meta = { name: 'tiny_file_workflow', description: 'Loaded from a file' }\nreturn { ok: true }\n`,
      "utf8",
    );

    const tool = createWorkflowTool();
    await assert.rejects(
      () => tool.execute("tool-call-id", { scriptPath: "tiny.workflow.js" }, undefined, undefined, { cwd: dir } as any),
      /workflow scripts must call agent\(\) at least once/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createWorkflowTool rejects missing or ambiguous workflow script inputs", () => {
  const tool = createWorkflowTool();

  assert.throws(() => tool.prepareArguments?.({}), /exactly one of `script` or `scriptPath`/);
  assert.throws(
    () => tool.prepareArguments?.({ script: "export const meta = {}", scriptPath: "workflow.js" }),
    /exactly one of `script` or `scriptPath`/,
  );
  assert.throws(() => tool.prepareArguments?.({ scriptPath: 42 }), /workflow `scriptPath` must be a string/);
  assert.throws(
    () => tool.prepareArguments?.({ script: "export const meta = {}", transcriptDir: 42 }),
    /workflow `transcriptDir` must be a string/,
  );
});

test("resolveWorkflowTranscriptDir defaults to args.outputDir transcripts", () => {
  assert.equal(
    resolveWorkflowTranscriptDir({ script: "", args: { outputDir: "/tmp/review-output/run-1" } }, "/repo", {
      name: "content_review",
      description: "Review content",
    }),
    "/tmp/review-output/run-1/transcripts",
  );
});

test("resolveWorkflowTranscriptDir supports overrides and generic workflow defaults", () => {
  assert.equal(
    resolveWorkflowTranscriptDir({ script: "", transcriptDir: "custom-transcripts" }, "/repo", {
      name: "Content Review!",
      description: "Review content",
    }),
    "/repo/custom-transcripts",
  );

  assert.equal(
    resolveWorkflowTranscriptDir({ script: "" }, "/repo", { name: "Content Review!", description: "Review content" }),
    "/repo/.pi/workflow-transcripts/content-review",
  );
});
