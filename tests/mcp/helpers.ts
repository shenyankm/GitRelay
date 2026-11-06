import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

export async function connectMcp(
  t: TestContext,
  cwd: string,
  entry = fileURLToPath(new URL("../../dist/mcp/main.js", import.meta.url)),
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--cwd", cwd],
    cwd,
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "git-relay-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`MCP connection failed: ${stderr}`, { cause: error });
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    let result;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (error) {
      throw new Error(`MCP ${name} failed: ${stderr}`, { cause: error });
    }
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as Record<string, any>;
  };
  return { client, transport, call, stderr: () => stderr };
}
