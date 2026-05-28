import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createWorkflowTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool();
  pi.registerTool(workflowTool);

  function ensureWorkflowToolActive() {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    ensureWorkflowToolActive();
    ctx.ui.notify("Dynamic workflow tool registered and enabled", "info");
  });

  pi.registerCommand("workflow-status", {
    description: "Show whether the dynamic workflow tool is registered and active",
    handler: async (_args, ctx) => {
      const all = pi.getAllTools().map((tool) => tool.name);
      const active = pi.getActiveTools();
      const registered = all.includes(workflowTool.name);
      const enabled = active.includes(workflowTool.name);
      ctx.ui.notify(`workflow registered=${registered} active=${enabled}`, enabled ? "info" : "warning");
      if (!enabled) ensureWorkflowToolActive();
    },
  });
}
