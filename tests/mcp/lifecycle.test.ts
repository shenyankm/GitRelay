import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "../helpers.ts";
import { connectMcp } from "./helpers.ts";

const entry = fileURLToPath(new URL("../../dist/mcp/main.js", import.meta.url));
async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Monitor state did not converge.");
}

test(
  "a legacy initialize-based MCP client discovers tools and EOF exits without writing state",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const child = spawn(process.execPath, [entry, "--cwd", f.b], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => {
      child.kill("SIGKILL");
    });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "legacy-test", version: "1.0.0" },
          capabilities: {},
        },
      }) + "\n",
    );
    const initialized = JSON.parse((await lines.next()).value!);
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.serverInfo.name, "git-relay");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    const listed = JSON.parse((await lines.next()).value!);
    assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "receive_messages"));
    child.stdin.end();
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(stderr, "");
    await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
    await assert.rejects(access(join(f.main, ".git", ".git-relay-id")), { code: "ENOENT" });
  },
);

test("a modern client retries an unsupported version on the same stdio connection", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [entry, "--cwd", f.b], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (id: number, method: string, version: string) =>
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }) + "\n",
    );

  send(1, "server/discover", "2099-01-01");
  const unsupported = JSON.parse((await lines.next()).value!);
  assert.equal(unsupported.id, 1);
  assert.equal(unsupported.error.code, -32022);
  assert.ok(unsupported.error.data.supported.includes("2026-07-28"));
  send(2, "server/discover", "2026-07-28");
  const discovered = JSON.parse((await lines.next()).value!);
  assert.equal(discovered.id, 2);
  assert.equal(discovered.result.resultType, "complete");
  assert.ok(discovered.result.capabilities.tools);
  send(3, "tools/list", "2026-07-28");
  const listed = JSON.parse((await lines.next()).value!);
  assert.equal(listed.id, 3);
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "receive_messages"));
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.match(stderr, /Unsupported protocol version/);
});

test("a fatal stdio close stops monitoring even while the client keeps stdin open", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [entry, "--cwd", f.b], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const exited = once(child, "exit");
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const call = async (name: string) => {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: {
          name,
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }) + "\n",
    );
    const response = JSON.parse((await lines.next()).value!);
    assert.equal(response.id, id);
    assert.notEqual(response.result.isError, true);
    return response.result.structuredContent;
  };
  await call("join_session");
  await eventually(
    () => call("monitor_status"),
    (value) => value.running,
  );
  child.stdin.write(" ".repeat(10 * 1024 * 1024 + 1));
  const [code, signal] = await exited;
  assert.equal(typeof code, "number");
  assert.equal(signal, null);
  assert.match(stderr, /buffer/i);
  const observer = await connectMcp(t, f.b);
  assert.equal((await observer.call("monitor_status")).running, false);
});

test(
  "monitor ownership transfers between MCP processes and closes with the last participant",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const first = await connectMcp(t, f.b);
    const second = await connectMcp(t, f.a);
    await first.call("join_session");
    await second.call("join_session");
    const before = await eventually(
      () => second.call("monitor_status"),
      (value) => value.running,
    );
    const owner = before.state.pid;
    assert.ok(owner === first.transport.pid || owner === second.transport.pid);
    const closed = owner === first.transport.pid ? first : second;
    const survivor = owner === first.transport.pid ? second : first;
    await closed.client.close();
    const after = await eventually(
      () => survivor.call("monitor_status"),
      (value) => value.running && value.state.pid === survivor.transport.pid,
    );
    assert.notEqual(after.state.pid, owner);
    await survivor.client.close();
    const observer = await connectMcp(t, f.b);
    assert.equal((await observer.call("monitor_status")).running, false);
    assert.equal((await observer.call("list_sessions")).sessions.length, 2);
  },
);
