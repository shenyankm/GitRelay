import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "../tests/helpers.ts";
import { repository } from "../src/core/repository.ts";
import { sessionsIn, eventsIn, readReceipt } from "../src/core/mailbox.ts";
import { trackRepository } from "../src/core/coordination.ts";

const cleanup = [];
const f = await fixture({
  after(fn) {
    cleanup.unshift(fn);
  },
});
const entry = fileURLToPath(new URL("../dist/mcp/main.js", import.meta.url));
const summary = { startedAt: new Date().toISOString(), passed: false, remoteWrites: false };
let child;
try {
  await writeFile(join(f.b, "shared.txt"), "Codex receiver unfinished work\n");
  await trackRepository(f.b);
  const prompt =
    "This is a bounded gitbeacon MCP acceptance test in a disposable local repository. Do not edit any files or call other servers. Using only gitbeacon MCP tools and a shell sleep if needed: join_session (tracking was already explicitly enabled by the test operator); then wait for a peer to modify a conflicting branch. Check coordination_status/receive_messages at two-second intervals, at most 12 attempts. Once you receive an automatic coordination report with a conflict finding, explicitly acknowledge the complete batch using its deliveryId, then leave_session and report the conflicting path. Do not synchronize, merge, reset, stash, push or call cleanup. Do not claim a server notification woke you: this test only establishes native tool/model consumption and acknowledgement.";
  child = spawn(
    "codex",
    [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "--sandbox",
      "read-only",
      "-C",
      f.b,
      "-c",
      'mcp_servers.gitbeacon.command="node"',
      "-c",
      `mcp_servers.gitbeacon.args=${JSON.stringify([entry, "--cwd", f.b])}`,
      "-c",
      `mcp_servers.gitbeacon.env.GITBEACON_STATE_DIR=${JSON.stringify(join(f.root, "state"))}`,
      prompt,
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    diagnostics = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  finished.catch(() => {});
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  let repo;
  try {
    const deadline = performance.now() + 120_000;
    while (performance.now() < deadline && child.exitCode === null) {
      try {
        repo = await repository(f.b, undefined, false);
        if ((await sessionsIn(repo)).some((session) => !session.closedAt)) break;
      } catch {
        /* The host has not joined yet. */
      }
      await delay(500);
    }
    assert.ok(
      repo && (await sessionsIn(repo)).length,
      `Native Codex never joined. ${diagnostics}\n${output.slice(-4096)}`,
    );
    await f.commit(f.a, "shared.txt", "Native acceptance peer conflict\n");
    const code = await finished;
    assert.equal(code, 0, `Codex failed: ${diagnostics}`);
    const sessions = await sessionsIn(repo);
    const events = (await eventsIn(repo)).filter(
      (event) =>
        event.sender.adapter === "gitbeacon" && event.kind === "message" && event.text.includes('"level":"conflict"'),
    );
    assert.ok(events.length, `No automatic conflict was published. ${output.slice(-4096)}`);
    let accepted = false;
    for (const event of events)
      for (const session of sessions)
        if ((await readReceipt(repo, session.key, event.id))?.status === "delivered") accepted = true;
    assert.ok(accepted, `Native model did not acknowledge the actual conflict. ${output.slice(-4096)}`);
    assert.ok(sessions.every((session) => session.closedAt));
    summary.passed = true;
    summary.nativeHost = "codex exec (real authenticated model turn)";
    summary.automaticConflictPublished = true;
    summary.explicitlyAcknowledged = true;
    summary.subscriptionClosed = true;
    summary.idleModelWakeUpTested = false;
    summary.lastEvents = output
      .split("\n")
      .filter(Boolean)
      .slice(-2)
      .map((line) => JSON.parse(line));
  } finally {
    clearTimeout(timer);
  }
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  for (const fn of cleanup) await fn();
  summary.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
