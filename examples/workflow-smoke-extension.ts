import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  createWorkflowSnapshot,
  createWidgetWorkflowDisplay,
  createWorkflowTool,
  preview,
  recomputeWorkflowSnapshot,
  runWorkflow,
  type WorkflowSnapshot,
} from "../src/index.js";

const Finding = Type.Object({
  id: Type.Number(),
  ok: Type.Boolean(),
  note: Type.String(),
});

const workflowScript = `export const meta = {
  name: 'rpc-smoke-workflow',
  description: 'Exercise pi dynamic workflow runtime through RPC mode',
  phases: [
    { title: 'Find', detail: 'fan out mock subagents' },
    { title: 'Verify', detail: 'pipeline verification' },
  ],
}

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    ok: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['id', 'ok', 'note'],
}

phase('Find')
log('starting find phase')
const found = await parallel([1, 2, 3].map(id => () =>
  agent('make finding ' + id, { label: 'find:' + id, schema: FINDING_SCHEMA })
))

phase('Verify')
const verified = await pipeline(
  found.filter(Boolean),
  (finding) => agent('verify ' + finding.id, { label: 'verify:' + finding.id, phase: 'Verify', schema: FINDING_SCHEMA })
)

return { found, verified: verified.filter(Boolean), count: verified.filter(Boolean).length }
`;

export default function extension(pi: ExtensionAPI) {
  pi.registerTool(createWorkflowTool());

  pi.registerCommand("workflow-smoke", {
    description: "Run a dynamic workflow runtime smoke test",
    handler: async (_args, ctx) => {
      let calls = 0;
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot({
        name: "rpc-smoke-workflow",
        description: "Exercise pi dynamic workflow runtime through RPC mode",
        phases: [{ title: "Find" }, { title: "Verify" }],
      });
      const display = createWidgetWorkflowDisplay(ctx, { key: "workflow-smoke", placement: "belowEditor" });
      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const result = await runWorkflow(workflowScript, {
        concurrency: 2,
        onLog(message) {
          snapshot.logs.push(message);
          update();
        },
        onPhase(title) {
          snapshot.currentPhase = title;
          if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
          update();
        },
        onAgentStart(event) {
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
          const agent = [...snapshot.agents].reverse().find((item) => item.label === event.label && item.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            agent.resultPreview = preview(event.result);
          }
          update();
        },
        agent: {
          async run(prompt: string) {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 25));
            const id = Number(prompt.match(/(\d+)/)?.[1] ?? calls);
            return { id, ok: true, note: prompt };
          },
        },
      });

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      pi.sendUserMessage(JSON.stringify({
        meta: result.meta.name,
        phases: result.phases,
        logs: result.logs,
        agentCount: result.agentCount,
        result: result.result,
        schemaName: Finding.type,
      }));
    },
  });
}
