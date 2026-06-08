import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkflowAgentTranscript } from "./agent.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowMeta, type WorkflowRunResult } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script, with no Markdown fences. Provide exactly one of script or scriptPath.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. agent opts include label, schema, phase, model, and thinkingLevel. The workflow must call agent() at least once.",
        "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
      ].join(" "),
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Path to a JavaScript workflow script file. Relative paths resolve from the current Pi working directory. Provide exactly one of script or scriptPath.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  transcriptDir: Type.Optional(
    Type.String({
      description:
        "Optional override for persisted subagent transcripts. By default, transcripts are written to args.outputDir/transcripts when args.outputDir is present, otherwise to .pi/workflow-transcripts/<workflow-name> under the current working directory.",
    }),
  ),
});

export type WorkflowToolInput = {
  script?: string;
  scriptPath?: string;
  args?: unknown;
  transcriptDir?: string;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "Provide exactly one of script (raw JavaScript) or scriptPath (path to a workflow file). The script must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
      "Subagent transcripts are persisted by default and a manifest is returned in the tool result details.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, pass exactly one of script or scriptPath. Use scriptPath when the user names an existing workflow file; use script only when writing a new one inline. Do not include Markdown fences or prose around inline script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status, transcript manifests, and error reporting readable.",
      "For workflow, subagent transcripts are persisted by default. If args.outputDir is provided, transcripts are saved under args.outputDir/transcripts; otherwise they are saved under .pi/workflow-transcripts/<workflow-name> in the current working directory.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = options.cwd ?? ctx.cwd;
      const script = await loadWorkflowScript(params, cwd);
      const parsed = parseWorkflowScript(script);
      const transcriptDir = resolveWorkflowTranscriptDir(params, cwd, parsed.meta);
      const transcripts: WorkflowAgentTranscript[] = [];
      let transcriptManifestPath: string | undefined;
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult | undefined;
      try {
        result = await runWorkflow(script, {
          cwd,
          args: params.args,
          signal,
          concurrency: options.concurrency,
          transcriptDir,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
          onTranscript(info) {
            transcripts.push(info);
          },
          onLog(message) {
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            recordPhase(title);
            update();
          },
          onAgentStart(event) {
            if (signal?.aborted) throw new Error("Workflow was aborted");
            recordPhase(event.phase);
            snapshot.agents.push({
              id: snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
            });
            update();
          },
          onAgentEnd(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
              agent.resultPreview = preview(event.result);
            }
            update();
          },
        });
      } catch (error) {
        transcriptManifestPath = await writeWorkflowTranscriptManifest(transcriptDir, parsed.meta, transcripts, {
          status: signal?.aborted || isAbortError(error) ? "aborted" : "error",
          error: error instanceof Error ? error.message : String(error),
        });
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      transcriptManifestPath = await writeWorkflowTranscriptManifest(transcriptDir, parsed.meta, transcripts, {
        status: "success",
      });

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      return {
        content: [
          {
            type: "text",
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nTranscripts:\n${transcriptManifestPath}\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          transcriptDir,
          transcriptManifestPath,
          transcripts,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") {
    throw new Error("workflow requires an object argument with exactly one of `script` or `scriptPath`");
  }
  const value = args as Record<string, unknown>;
  const hasScript = value.script !== undefined;
  const hasScriptPath = value.scriptPath !== undefined;
  if (hasScript === hasScriptPath) {
    throw new Error("workflow requires exactly one of `script` or `scriptPath`");
  }
  if (hasScript && typeof value.script !== "string") throw new Error("workflow `script` must be a string");
  if (hasScriptPath && typeof value.scriptPath !== "string") {
    throw new Error("workflow `scriptPath` must be a string");
  }
  if (value.transcriptDir !== undefined && typeof value.transcriptDir !== "string") {
    throw new Error("workflow `transcriptDir` must be a string");
  }

  if (hasScript) {
    return {
      ...value,
      script: normalizeWorkflowScript(value.script as string),
      transcriptDir: typeof value.transcriptDir === "string" ? value.transcriptDir.trim() : undefined,
    } as WorkflowToolInput;
  }
  return {
    ...value,
    scriptPath: (value.scriptPath as string).trim(),
    transcriptDir: typeof value.transcriptDir === "string" ? value.transcriptDir.trim() : undefined,
  } as WorkflowToolInput;
}

async function loadWorkflowScript(params: WorkflowToolInput, cwd: string): Promise<string> {
  const hasScript = params.script !== undefined;
  const hasScriptPath = params.scriptPath !== undefined;
  if (hasScript === hasScriptPath) throw new Error("workflow requires exactly one of `script` or `scriptPath`");
  if (hasScript) return normalizeWorkflowScript(params.script as string);
  if (!params.scriptPath) throw new Error("workflow requires exactly one of `script` or `scriptPath`");

  const workflowPath = path.isAbsolute(params.scriptPath) ? params.scriptPath : path.resolve(cwd, params.scriptPath);
  try {
    return normalizeWorkflowScript(await readFile(workflowPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read workflow scriptPath ${workflowPath}: ${message}`);
  }
}

export function resolveWorkflowTranscriptDir(params: WorkflowToolInput, cwd: string, meta: WorkflowMeta): string {
  if (params.transcriptDir) {
    return path.isAbsolute(params.transcriptDir) ? params.transcriptDir : path.resolve(cwd, params.transcriptDir);
  }

  const outputDir = getOutputDirArg(params.args);
  if (outputDir) {
    const resolvedOutputDir = path.isAbsolute(outputDir) ? outputDir : path.resolve(cwd, outputDir);
    return path.join(resolvedOutputDir, "transcripts");
  }

  return path.join(cwd, ".pi", "workflow-transcripts", safePathSegment(meta.name));
}

async function writeWorkflowTranscriptManifest(
  transcriptDir: string,
  meta: WorkflowMeta,
  transcripts: WorkflowAgentTranscript[],
  outcome: { status: "success" | "error" | "aborted"; error?: string },
): Promise<string> {
  await mkdir(transcriptDir, { recursive: true });
  const manifestPath = path.join(transcriptDir, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        workflow: {
          name: meta.name,
          description: meta.description,
        },
        transcriptDir,
        createdAt: new Date().toISOString(),
        outcome,
        transcripts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return manifestPath;
}

function getOutputDirArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const outputDir = (args as Record<string, unknown>).outputDir;
  return typeof outputDir === "string" && outputDir.trim() ? outputDir.trim() : undefined;
}

function safePathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
