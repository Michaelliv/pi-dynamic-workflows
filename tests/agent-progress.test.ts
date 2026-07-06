import assert from "node:assert/strict";
import test from "node:test";
import { formatProgressTranscriptMessage, inferToolActivity } from "../src/agent.js";
import { cheapProgressPreview } from "../src/workflow-tool.js";

test("inferToolActivity counts native tool calls and cursor thinking traces", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "read" },
        { type: "thinking", text: "grep: search src for hooks" },
        { type: "text", text: "Tool call (shell, cd repo && npm test)" },
      ],
    },
    { role: "toolResult", toolName: "read", content: "ok" },
  ];

  const activity = inferToolActivity(messages);
  assert.equal(activity.toolCalls, 3);
  assert.equal(activity.lastToolLabel, "shell");
});

test("formatProgressTranscriptMessage includes thinking traces", () => {
  const text = formatProgressTranscriptMessage({
    role: "assistant",
    provider: "cursor",
    model: "composer",
    content: [{ type: "thinking", text: "grep: search src for hooks" }],
  });

  assert.match(text, /\[tool_trace grep: search src for hooks\]/);
});

test("cheapProgressPreview prefers cursor traces over prose", () => {
  const preview = cheapProgressPreview({
    metrics: {
      durationMs: 1,
      tokensPerSecond: null,
      toolCalls: 2,
      toolResults: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    transcript: [
      "[Assistant cursor/composer]",
      "[tool_trace grep: search src for hooks]",
      "still working on the repo",
    ].join("\n"),
  });

  assert.equal(preview, "grep…");
});

test("cheapProgressPreview handles Tool call (name, text", () => {
  const preview = cheapProgressPreview({
    metrics: {
      durationMs: 1,
      tokensPerSecond: null,
      toolCalls: 1,
      toolResults: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    transcript: "[Assistant cursor/composer]\nTool call (Shell, npm test)",
  });

  assert.equal(preview, "Shell…");
});
