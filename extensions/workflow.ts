import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool(pi);
  pi.registerTool(workflowTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });
}
