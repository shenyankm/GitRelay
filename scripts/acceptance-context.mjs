import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixture } from "../tests/helpers.ts";
import { connectMcp } from "../tests/mcp/helpers.ts";
import { readReceipt, readSession, sendMessage, sessionKey } from "../src/core/mailbox.ts";
import { mcpIdentity } from "../src/core/mcp-mailbox.ts";
import { repository } from "../src/core/repository.ts";

const home = process.env.GITBEACON_TEST_CODEX_HOME;
if (!home || !resolve(home).startsWith(join(tmpdir(), "gitbeacon-plugin-codex-")))
  throw new Error(
    "Use an authenticated, normally hook-trusted temporary GITBEACON_TEST_CODEX_HOME (gitbeacon-plugin-codex-*).",
  );
const cleanup = [],
  t = {
    after(fn) {
      cleanup.unshift(fn);
    },
  };
const f = await fixture(t);
const summary = { startedAt: new Date().toISOString(), passed: false, remoteWrites: false };
try {
  const { client, call } = await connectMcp(t, f.b);
  const reader = await call("join_session");
  for (let n = 0; n < 100; n++)
    await sendMessage({
      cwd: f.a,
      adapter: "fixture",
      session: "peer",
      text: `Coordination notice ${n}: src/shared.ts changed; review the overlapping implementation before continuing.`,
    });
  const compact = await call("repository_status");
  const detailed = await call("repository_status", { includeEvents: true });
  assert.equal(compact.retainedEvents, 100);
  assert.equal(compact.eventsIncluded, false);
  assert.equal(compact.events.length, 0);
  assert.equal(detailed.events.length, 100);
  summary.status = { compact, detailed };
  await call("leave_session", { sessionToken: reader.sessionToken });

  const market = join(f.root, "marketplace");
  await cp(fileURLToPath(new URL("../build/local-plugin/", import.meta.url)), market, { recursive: true });
  const configPath = join(market, "plugins/gitbeacon/.mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.mcpServers.gitbeacon.env = { GITBEACON_STATE_DIR: join(f.root, "state") };
  await writeFile(configPath, JSON.stringify(config));
  const env = { ...process.env, CODEX_HOME: home };
  const host = (args) => execFileSync("codex", args, { env, stdio: "pipe", timeout: 60000 });
  host(["plugin", "marketplace", "remove", "gitbeacon-local"]);
  host(["plugin", "marketplace", "add", market]);
  host(["plugin", "add", "gitbeacon@gitbeacon-local"]);
  const run = promisify(execFile);
  async function model(request) {
    const execution = run("codex", ["exec", "--json", "--sandbox", "read-only", "-C", f.b, request], {
      env,
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024,
    });
    execution.child.stdin.end();
    const { stdout } = await execution;
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const id = events.find((event) => event.type === "thread.started").thread_id;
    const paths = await readdir(join(home, "sessions"), { recursive: true });
    const log = (
      await readFile(
        join(
          home,
          "sessions",
          paths.find((p) => p.endsWith(id + ".jsonl")),
        ),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const scripts = log
      .filter(
        (entry) =>
          entry.type === "response_item" && entry.payload.type === "custom_tool_call" && entry.payload.name === "exec",
      )
      .map((entry) => entry.payload.input);
    return { events, scripts, log, usage: events.find((event) => event.type === "turn.completed")?.usage };
  }
  const setup = await model(
    "Use $gitbeacon:gitbeacon-setup to diagnose this local worktree's plugin connection without changing configuration.",
  );
  assert.ok(
    setup.scripts.some((script) => script.includes("structuredContent")),
    "Setup did not forward structured output",
  );
  summary.setupStructuredForwarding = true;
  summary.setupUsage = setup.usage;

  const joined = await call("join_session");
  const markers = ["begin-context-7f9c", "middle-context-2ba1", "complete-context-93d0"];
  const text =
    `ACCEPTANCE_MARKER=${markers[0]}\n` +
    Array.from(
      { length: 600 },
      (_, n) =>
        `Observation ${n}: shared implementation overlaps with peer work; inspect the full note before acceptance.\n` +
        (n === 320 ? `ACCEPTANCE_MARKER=${markers[1]}\n` : ""),
    ).join("") +
    `ACCEPTANCE_MARKER=${markers[2]}`;
  assert.ok(Buffer.byteLength(text) > 60 * 1024 && Buffer.byteLength(text) <= 64 * 1024);
  const event = await sendMessage({ cwd: f.a, adapter: "fixture", session: "peer", text });
  const batch = await call("receive_messages", { sessionToken: joined.sessionToken });
  assert.equal(batch.detailsRequired, true);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 8192);
  await assert.rejects(
    call("acknowledge_messages", { sessionToken: joined.sessionToken, deliveryId: batch.deliveryId }),
    /Read all/,
  );
  await client.close();
  const request = `Use $gitbeacon:gitbeacon-coordination to resume this existing participant in this disposable worktree (private sessionToken ${joined.sessionToken}, ref ${joined.session.ref}). Inspect its pending note, report all ACCEPTANCE_MARKER values, accept it, then end this collaboration. Do not change files or synchronize Git. Never expose the private token.`;
  const result = await model(request);
  const response = result.events
    .filter((entry) => entry.item?.type === "agent_message")
    .map((entry) => entry.item.text)
    .join("\n");
  for (const marker of markers) assert.ok(response.includes(marker), "Model did not read all note markers");
  const detailCalls = new Set(
    result.log
      .filter(
        (entry) =>
          entry.payload?.type === "custom_tool_call" &&
          entry.payload.input?.includes("tools.mcp__gitbeacon__read_message_details("),
      )
      .map((entry) => entry.payload.call_id),
  );
  const detailOutputs = result.log.filter(
    (entry) => entry.payload?.type === "custom_tool_call_output" && detailCalls.has(entry.payload.call_id),
  );
  assert.ok(detailOutputs.length > 1, "Details were not exposed incrementally");
  assert.ok(
    detailOutputs.every((entry) => !String(entry.payload.output).slice(0, 300).includes("truncated")),
    "Host truncated detail output",
  );
  assert.ok(!response.includes(joined.sessionToken), "Model exposed the private token");
  const repo = await repository(f.b);
  const key = sessionKey(repo, mcpIdentity(joined.sessionToken), joined.session.ref);
  assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
  const delivery = JSON.parse(await readFile(join(repo.directory, "receipts", key, "mcp-delivery.json"), "utf8"));
  assert.equal(delivery.details.readOffset, Buffer.byteLength(delivery.details.text));
  assert.ok((await readSession(repo, key))?.closedAt, "Model did not end collaboration");
  summary.largeDelivery = {
    bytes: Buffer.byteLength(text),
    descriptorBytes: Buffer.byteLength(JSON.stringify(batch)),
    allDetailsRead: true,
    subscriptionClosed: true,
    detailOutputGroups: detailOutputs.length,
    detailOutputsNotTruncated: true,
    earlyAckBlocked: true,
    explicitlyAcknowledged: true,
    response,
    usage: result.usage,
  };
  summary.passed = true;
} catch (error) {
  summary.error = error.message.replace(/[a-f0-9]{64}/g, "<private-handle-or-id>");
  process.exitCode = 1;
} finally {
  for (const fn of cleanup) await fn();
  summary.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
