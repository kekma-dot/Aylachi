import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const auditPath = process.argv[2];
const startPath = process.argv[3];
const exitPath = process.argv[4];
if (!auditPath || !startPath || !exitPath) throw new Error("audit, start, and exit marker paths are required");
const audit = (entry) => appendFileSync(auditPath, `${JSON.stringify(entry)}\n`);
writeFileSync(startPath, `${process.pid}\n`);
process.on("exit", () => appendFileSync(exitPath, `${process.pid}\n`));

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  audit({ method: request.method, params: request.params ?? null });
  if (request.id === undefined) continue;

  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "aylachi-safe-echo-fixture", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = { tools: [{
        name: "echo",
        description: "Echo fixed test text; text=fail returns a fixture tool error.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      }] };
      break;
    case "tools/call": {
      if (request.params?.name !== "echo" || typeof request.params?.arguments?.text !== "string") {
        result = { isError: true, content: [{ type: "text", text: "invalid fixture call" }] };
      } else if (request.params.arguments.text === "fail") {
        result = { isError: true, content: [{ type: "text", text: "intentional fixture tool error" }] };
      } else {
        result = { content: [{ type: "text", text: `echo:${request.params.arguments.text}` }] };
      }
      audit({ method: "fixture/result", isError: result.isError === true, content: result.content });
      break;
    }
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
      continue;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
