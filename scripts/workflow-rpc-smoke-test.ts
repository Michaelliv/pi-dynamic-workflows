import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const piBin = path.join(root, "node_modules", ".bin", "pi");
const extension = path.join(root, "examples", "workflow-smoke-extension.ts");

function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (value: any) => void) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      onLine(JSON.parse(line));
    }
  });
}

const proc = spawn(
  piBin,
  ["--mode", "rpc", "--no-session", "--no-extensions", "--no-builtin-tools", "-e", extension],
  { cwd: root, stdio: ["pipe", "pipe", "inherit"] },
);

let commandResponse = false;
let sawAgentEnd = false;
let parsed: any;
let sawWidget = false;

attachJsonlReader(proc.stdout, (event) => {
  if (event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey === "workflow-smoke") {
    sawWidget = true;
    console.log("workflow widget:", JSON.stringify(event.widgetLines));
  }


  if (event.type === "response") {
    console.log("response", event.command, event.success, event.error ?? "");
    if (event.id === "workflow-smoke") commandResponse = event.success;
  }

  if (event.type === "agent_message_delta" && typeof event.delta === "string") {
    // Not all Pi versions emit command text here; keep parser tolerant.
  }

  if (event.type === "agent_end") {
    for (const message of event.messages ?? []) {
      const text = message.content?.find?.((part: any) => part.type === "text")?.text;
      if (!text) continue;
      try {
        parsed = JSON.parse(text);
        console.log("workflow result:", JSON.stringify(parsed));
        break;
      } catch {}
    }
    sawAgentEnd = true;
    proc.stdin.end();
    proc.kill("SIGTERM");
  }
});

proc.on("exit", (code, signal) => {
  const ok = commandResponse && sawAgentEnd && sawWidget && parsed?.agentCount === 6 && parsed?.result?.count === 3;
  if (!ok) {
    console.error("Workflow RPC smoke test failed", { code, signal, commandResponse, sawAgentEnd, sawWidget, parsed });
    process.exitCode = 1;
  } else {
    console.log("Workflow RPC smoke test passed");
  }
});

proc.stdin.write(
  JSON.stringify({
    id: "workflow-smoke",
    type: "prompt",
    message: "/workflow-smoke",
  }) + "\n",
);
