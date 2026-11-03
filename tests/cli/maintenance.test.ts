import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { eventsIn, registerSession } from "../../src/core/mailbox.ts";
import { readJson, stateDirectory } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const exec = promisify(execFile);
const run = (...args: string[]) => exec(process.execPath, [cli, ...args]);
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("CLI daemon acceptance timed out");
    await delay(25);
  }
}

test("CLI acceptance: leave preserves unread messages, join restores them, GC requires explicit apply", async (t) => {
  const f = await fixture(t);
  const b = ["--cwd", f.b, "--agent", "codex", "--session", "B"];
  const c = ["--cwd", f.c, "--agent", "cli", "--session", "C"];
  const sender = ["--cwd", f.a, "--agent", "codex", "--session", "A"];
  await run("check", ...b);
  await run("check", ...c);
  const pending = JSON.parse((await run("send", ...sender, "--message", "must survive leave")).stdout);
  assert.ok(JSON.parse((await run("leave", ...c)).stdout).session.closedAt);
  assert.equal(JSON.parse((await run("send", ...sender, "--message", "exclude closed C")).stdout).recipients, 1);
  await run("check", ...b);
  const report = JSON.parse((await run("gc", "--cwd", f.a, "--apply", "--retention-days", "0")).stdout);
  assert.ok(report.kept.some((entry: any) => entry.id === pending.eventId && entry.reason === "unconfirmed"));
  assert.equal((await run("check", ...c)).stdout, "");
  await run("join", ...c);
  const restored = JSON.parse((await run("check", ...c)).stdout);
  assert.equal(restored.eventId, pending.eventId);
  const preview = JSON.parse((await run("gc", "--cwd", f.a, "--retention-days", "0")).stdout);
  assert.equal(preview.dryRun, true);
  assert.ok(preview.eligible.includes(pending.eventId));
  assert.equal(preview.removed.length, 0);
  const applied = JSON.parse((await run("gc", "--cwd", f.a, "--apply", "--retention-days", "0")).stdout);
  assert.ok(applied.removed.includes(pending.eventId));
  await assert.rejects(run("gc", "--cwd", f.a, "--apply", "--dry-run"), /not both/);
  await assert.rejects(run("gc", "--cwd", f.a, "--retention-days", "-1"), /retention-days/);
  await assert.rejects(run("gc", "--cwd", f.a, "--retention-days", ""), /retention-days/);
});

test("daemon output failure exits without leaving its lock or heartbeat", async (t) => {
  await fixture(t);
  const child = spawn(process.execPath, [cli, "daemon"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  child.stdout.destroy();
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    assert.equal(await closed, 1, stderr);
  } finally {
    clearTimeout(force);
  }
  assert.equal(await readJson(join(stateDirectory(), "daemon.lock")), undefined);
  assert.equal(await readJson(join(stateDirectory(), "daemon.json")), undefined);
});

test("daemon SIGTERM exits even when stdout is an unread full pipe", async (t) => {
  const f = await fixture(t);
  await run("check", "--cwd", f.a, "--session", "healthy");
  await registerSession(await repository(f.a), { adapter: "cc", session: "bad" }, "refs/heads/missing");
  const repo = await repository(f.a);
  const script = `
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, callback) => {
      if (chunk.includes('"type":"daemon.error"')) {
        chunk += "x".repeat(4 * 1024 * 1024);
        process.stderr.write("blocking-output\\n");
      }
      return write(chunk, callback);
    };
    process.argv = [process.execPath, "daemon", "--interval-ms", "50"];
    await import(${JSON.stringify(pathToFileURL(cli).href)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdout.destroy();
    await exited;
  });
  // Do not read stdout; one enlarged diagnostic fills the real OS pipe.
  await waitFor(() => stderr.includes("blocking-output"));
  await delay(50);
  assert.equal(await readJson(join(repo.directory, "publish.lock")), undefined);
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    assert.equal(await exited, 0, stderr);
  } finally {
    clearTimeout(force);
  }
  assert.equal(await readJson(join(stateDirectory(), "daemon.lock")), undefined);
  assert.equal(await readJson(join(stateDirectory(), "daemon.json")), undefined);
});

test("CLI daemon acceptance: singleton, automatic confirmed-only GC, central publishing, SIGTERM and fallback", async (t) => {
  let child: ChildProcess | undefined;
  let closed: Promise<number | null> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => child?.kill("SIGKILL"), 3000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  });
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  await writeFile(join(f.c, "shared.txt"), "C local\n");
  const b = ["--cwd", f.b, "--agent", "codex", "--session", "B"];
  const c = ["--cwd", f.c, "--agent", "cli", "--session", "C"];
  await run("check", ...b);
  const old = JSON.parse(
    (await run("send", "--cwd", f.a, "--agent", "cc", "--session", "A", "--message", "already confirmed")).stdout,
  );
  await run("check", ...b);
  await run("check", ...c);
  const repo = await repository(f.b);
  const logs: any[] = [];
  let buffered = "";
  let stderr = "";
  child = spawn(process.execPath, [cli, "daemon", "--interval-ms", "100", "--retention-days", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = new Promise((resolve, reject) => {
    child!.once("close", resolve);
    child!.once("error", reject);
  });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (data: string) => {
    buffered += data;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      logs.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (data: string) => {
    stderr = (stderr + data).slice(-8000);
  });
  await waitFor(() => logs.some((event) => event.type === "daemon.ready"));
  assert.equal(JSON.parse((await run("daemon", "status")).stdout).running, true);
  await assert.rejects(run("daemon", "--interval-ms", "100"), /busy/);
  await waitFor(() => logs.some((event) => event.type === "daemon.cleanup" && event.removed === 1));
  assert.equal(
    (await eventsIn(repo)).some((event) => event.id === old.eventId),
    false,
  );
  const mainCommit = await f.commit(f.main, "shared.txt", "upstream via daemon\n");
  await waitFor(async () =>
    (await eventsIn(repo)).some((event) => event.kind === "upstream" && event.commit === mainCommit),
  );
  async function receive(args: string[]) {
    let notification: any;
    await waitFor(async () => {
      const result = (await run("check", ...args)).stdout.trim();
      if (result) notification = JSON.parse(result);
      return notification !== undefined;
    });
    return notification;
  }
  const first = await receive(b);
  const second = await receive(c);
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.commit, mainCommit);
  assert.ok(first.message.includes("upstream via daemon"));
  child.kill("SIGTERM");
  assert.equal(await closed, 0, stderr);
  assert.equal(JSON.parse((await run("daemon", "status")).stdout).running, false);
  assert.equal(await readJson(join(stateDirectory(), "daemon.lock")), undefined);
  assert.equal(await readJson(join(stateDirectory(), "daemon.json")), undefined);
  const next = await f.commit(f.main, "shared.txt", "fallback without daemon\n");
  assert.equal(JSON.parse((await run("check", ...b)).stdout).commit, next);
  assert.ok(!logs.some((event) => event.type === "daemon.error"), JSON.stringify(logs));
});
