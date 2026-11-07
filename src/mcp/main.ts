#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createGitRelayServer } from "./server.ts";
import { diagnosticMessage } from "../core/diagnostics.ts";

let blocked = false;
process.stderr.on("error", () => {
  blocked = true;
});
function diagnostic(error: unknown) {
  if (blocked) return;
  const message = diagnosticMessage(error);
  try {
    if (!process.stderr.write(`git-relay: ${message}\n`)) {
      blocked = true;
      process.stderr.once("drain", () => {
        blocked = false;
      });
    }
  } catch {
    blocked = true;
  }
}

try {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "GitRelay MCP server\n\nUsage: node /path/to/GitRelay/dist/mcp/main.js [--cwd PATH]\n\nServes MCP over stdin/stdout. Configure this command in your MCP host.\n--cwd PATH sets the default worktree; tools can explicitly select another path.\nWORKTREE_SYNC_STATE_DIR selects the shared local state directory.\n",
    );
  } else if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
  } else {
    if (values.cwd === "") throw new TypeError("--cwd must not be empty.");
    const abort = new AbortController();
    let runtime: ReturnType<typeof createGitRelayServer> | undefined;
    let shutdown: Promise<void> | undefined;
    const wire = new StdioServerTransport();
    const transport = serveStdio(
      () => {
        runtime = createGitRelayServer({ cwd: values.cwd, signal: abort.signal, onDiagnostic: diagnostic });
        return runtime.server;
      },
      {
        transport: wire,
        onerror: diagnostic,
      },
    );
    const stop = (code?: number) => {
      if (code !== undefined) process.exitCode = code;
      shutdown ??= (async () => {
        abort.abort();
        await runtime?.close();
        await transport.close();
        process.stdin.destroy();
        process.stdout.destroy();
      })().catch((error) => {
        diagnostic(error);
        process.exitCode = 1;
      });
    };
    const onclose = wire.onclose;
    wire.onclose = () => {
      onclose?.();
      stop();
    };
    process.stdin.once("error", () => stop(1));
    process.stdin.once("end", () => stop());
    process.stdin.once("close", () => stop());
    process.stdout.once("error", () => stop(1));
    process.once("SIGINT", () => stop(130));
    process.once("SIGTERM", () => stop(143));
  }
} catch (error) {
  diagnostic(error);
  process.exitCode = 1;
}
