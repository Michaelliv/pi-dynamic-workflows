import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export interface SmokeStructuredOutput {
  answer: string;
  confidence: number;
  bullets: string[];
}

const structuredOutput = defineTool({
  name: "structured_output",
  label: "Structured Output",
  description: "Return the final structured answer for the current task.",
  promptSnippet: "Return a final structured answer",
  promptGuidelines: [
    "Use structured_output as your final action when asked for structured output.",
    "After calling structured_output, do not emit another assistant response.",
  ],
  parameters: Type.Object({
    answer: Type.String({ description: "Short direct answer" }),
    confidence: Type.Number({ description: "Confidence from 0 to 1" }),
    bullets: Type.Array(Type.String(), { description: "Supporting bullets" }),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Captured structured answer: ${params.answer}` }],
      details: params satisfies SmokeStructuredOutput,
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(structuredOutput);

  pi.registerCommand("structured-output-smoke", {
    description: "Ask the model to call the structured_output tool with a tiny payload",
    handler: async (_args, _ctx) => {
      pi.sendUserMessage(
        [
          "Call structured_output exactly once with:",
          "answer = 'pi dynamic workflows smoke test'",
          "confidence = 1",
          "bullets = ['extension loaded', 'tool schema accepted']",
          "Do not answer in prose.",
        ].join("\n"),
      );
    },
  });
}
