import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const temporary = await mkdtemp(join(tmpdir(), "git-relay-mcp-benchmark-"));
const env = { ...process.env, WORKTREE_SYNC_STATE_DIR: join(temporary, "state") };
const entry = fileURLToPath(new URL("../dist/mcp/main.js", import.meta.url));
const clients = [];
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { env, encoding: "utf8" },
  ).trim();
async function connect(cwd) {
  const client = new Client({ name: "gitrelay-benchmark", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--cwd", cwd], cwd, env }));
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.content));
    return result.structuredContent;
  };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 100) / 100;
try {
  const main = join(temporary, "main"),
    receiver = join(temporary, "receiver");
  git(temporary, "init", "-b", "main", main);
  await writeFile(join(main, "shared.txt"), "baseline\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "baseline");
  git(main, "worktree", "add", "-b", "receiver", receiver);
  const start = performance.now();
  const send = await connect(main),
    receive = await connect(receiver);
  const startupMs = round(performance.now() - start);
  const sender = await send("join_session"),
    reader = await receive("join_session");
  const samples = [];
  for (let index = 0; index < 6; index++) {
    const started = performance.now();
    const event = await send("send_message", { sessionToken: sender.sessionToken, text: `BENCH_EVENT_${index}` });
    const sent = performance.now();
    const batch = await receive("receive_messages", { sessionToken: reader.sessionToken });
    const received = performance.now();
    assert.equal(batch.notifications.length, 1);
    assert.equal(batch.notifications[0].event.id, event.eventId);
    await receive("acknowledge_messages", { sessionToken: reader.sessionToken, deliveryId: batch.deliveryId });
    samples.push({
      sendMs: round(sent - started),
      receiveMs: round(received - sent),
      acknowledgeMs: round(performance.now() - received),
      endToEndMs: round(performance.now() - started),
    });
  }
  assert.deepEqual((await receive("receive_messages", { sessionToken: reader.sessionToken })).notifications, []);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        git: git(main, "--version"),
        platform: process.platform,
        arch: process.arch,
        startupMs,
        samples,
        medianEndToEndMs: median(samples.slice(1).map((sample) => sample.endToEndMs)),
        workload:
          "two persistent stdio MCP clients; linked worktrees; explicit receive and acknowledgement; shared monitor; first sample excluded from median",
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
