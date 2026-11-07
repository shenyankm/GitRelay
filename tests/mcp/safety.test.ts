import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { diagnosticMessage } from "../../src/core/diagnostics.ts";
import { createGitbeaconServer } from "../../src/mcp/server.ts";
import { fixture } from "../helpers.ts";

async function connect(t: TestContext, cwd: string) {
  const runtime = createGitbeaconServer({ cwd });
  const client = new Client({ name: "safety-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await runtime.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("diagnostics remove terminal sequences and controls, preserve Unicode and bound output", () => {
  assert.equal(diagnosticMessage(new Error("\x1b[31m失败\x1b[0m\0\r\x7f\x85\n\t路径\u00a0")), "失败    \n\t路径\u00a0");
  assert.equal(diagnosticMessage("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), "link");
  assert.equal(diagnosticMessage("x".repeat(5000)), "x".repeat(4096));
  assert.equal(diagnosticMessage(null), "null");
});

test("MCP shares a bounded call budget across tools and refills it using monotonic time", async (t) => {
  const f = await fixture(t);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const client = await connect(t, f.b);
  for (let i = 0; i < 60; i++) {
    const failure = await client.callTool({ name: "branch_status", arguments: { repo: "owner/repo" } });
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure.content), /requires github/);
  }
  const poll = () => client.callTool({ name: "monitor_status", arguments: {} });
  assert.match(JSON.stringify((await poll()).content), /Tool call limit reached/);
  now = 999;
  assert.equal((await poll()).isError, true);
  now = 1000;
  assert.notEqual((await poll()).isError, true);
  assert.equal((await poll()).isError, true);
  now = 1_000_000;
  for (let i = 0; i < 60; i++) assert.notEqual((await poll()).isError, true);
  assert.equal((await poll()).isError, true);
  assert.ok((await client.listTools()).tools.length > 0);
});

test(
  "MCP caps concurrent work without queuing rejected calls and releases slots after completion",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const client = await connect(t, f.b);
    let entered = 0;
    const open = fs.promises.open;
    const mocked = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
      if (args[0] === join(f.root, "state", "daemon.lock")) {
        if (++entered === 8) started.resolve();
        await release.promise;
      }
      return open(...args);
    });
    syncBuiltinESMExports();
    const poll = () => client.callTool({ name: "monitor_status", arguments: {} });
    const pending = Array.from({ length: 8 }, poll);
    try {
      await started.promise;
      const rejected = await poll();
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.content), /Tool call limit reached/);
      assert.equal(entered, 8);
      release.resolve();
      assert.ok((await Promise.all(pending)).every((result) => !result.isError));
      assert.notEqual((await poll()).isError, true);
      assert.equal(entered, 9);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test("MCP cleans diagnostic text before returning tool errors and releases failed calls", async (t) => {
  const f = await fixture(t);
  const client = await connect(t, f.b);
  const lstat = fs.promises.lstat;
  const mocked = t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof lstat>) => {
    if (args[0] === join(f.root, "state", "repos"))
      throw new Error("external: \x1b[31m失败\x1b[0m\0" + "x".repeat(5000));
    return lstat(...args);
  });
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 9; i++) {
      const result = await client.callTool({ name: "list_sessions", arguments: {} });
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, [{ type: "text", text: ("external: 失败 " + "x".repeat(5000)).slice(0, 4096) }]);
    }
    assert.notEqual((await client.callTool({ name: "monitor_status", arguments: {} })).isError, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
