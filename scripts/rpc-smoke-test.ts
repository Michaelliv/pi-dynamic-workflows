import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const piBin = path.join(root, "node_modules", ".bin", "pi");
const extension = path.join(root, "examples", "structured-output-extension.ts");

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

let sawToolResult = false;
let sawAgentEnd = false;
let commandResponse = false;

attachJsonlReader(proc.stdout, (event) => {
  if (event.type === "response") {
    console.log("response", event.command, event.success, event.error ?? "");
    if (event.id === "smoke") commandResponse = event.success;
  }

  if (event.type === "tool_execution_end" && event.toolName === "structured_output") {
    sawToolResult = true;
    console.log("structured_output details:", JSON.stringify(event.result.details));
  }

  if (event.type === "agent_end") {
    sawAgentEnd = true;
    proc.stdin.end();
    proc.kill("SIGTERM");
  }
});

proc.on("exit", (code, signal) => {
  if (!commandResponse || !sawToolResult || !sawAgentEnd) {
    console.error("Smoke test did not observe expected RPC events", {
      code,
      signal,
      commandResponse,
      sawToolResult,
      sawAgentEnd,
    });
    process.exitCode = 1;
  } else {
    console.log("Smoke test passed");
  }
});

proc.stdin.write(
  JSON.stringify({
    id: "smoke",
    type: "prompt",
    message: "/structured-output-smoke",
  }) + "\n",
);
