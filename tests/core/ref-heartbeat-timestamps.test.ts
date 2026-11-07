import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { daemonStatus } from "../../src/core/daemon-state.ts";
import { hash } from "../../src/core/store.ts";
import { type Repository } from "../../src/core/repository.ts";
import { readRef, synchronizeRef } from "../../src/core/publisher.ts";

const ref = "refs/heads/main",
  token = "a".repeat(64),
  commit = "b".repeat(40);

test("daemon status skips the heartbeat without a readable lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "heartbeat-no-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.GITBEACON_STATE_DIR,
    originalOpen = fs.promises.open,
    heartbeat = join(root, "daemon.json");
  process.env.GITBEACON_STATE_DIR = root;
  let heartbeatReads = 0;
  fs.promises.open = async function (path, ...args) {
    if (String(path) === heartbeat) heartbeatReads++;
    return originalOpen(path, ...args);
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    for (const content of [undefined, "{broken", "null"]) {
      if (content !== undefined) await writeFile(join(root, "daemon.lock"), content);
      assert.deepEqual(await daemonStatus(), { running: false });
    }
    assert.equal(heartbeatReads, 0);
    await writeFile(join(root, "daemon.lock"), JSON.stringify({ pid: process.pid, token }));
    assert.deepEqual(await daemonStatus(), { running: false });
    assert.equal(heartbeatReads, 1);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = previous;
  }
});

test("ref cursor accepts valid legacy timestamps and rejects non-string values without modifying state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-types-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "refs"));
  const path = join(root, "refs", `${hash(ref)}.json`);
  const repo = { directory: root } as Repository;
  for (const value of [null, 0, true, [new Date().toISOString()], { date: "2026-01-01" }, "not-a-date"]) {
    const content = JSON.stringify({ ref, commit, checkedAt: value, daemonToken: token });
    await writeFile(path, content);
    await assert.rejects(readRef(repo, ref), /Invalid ref cursor/);
    assert.equal(await readFile(path, "utf8"), content);
  }
  for (const value of [undefined, new Date().toISOString(), "Mon, 01 Jan 2024 00:00:00 GMT"]) {
    await writeFile(path, JSON.stringify({ ref, commit, checkedAt: value, daemonToken: token }));
    assert.equal((await readRef(repo, ref))?.checkedAt, value);
  }
  await writeFile(path, "{broken");
  await assert.rejects(readRef(repo, ref), SyntaxError);
  assert.equal(await readFile(path, "utf8"), "{broken");
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await assert.rejects(
    synchronizeRef(repo, ref, { adapter: "test", session: "test" }, controller.signal),
    /already cancelled/,
  );
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("daemon heartbeat non-string and malformed values fall back without trusting the PID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "heartbeat-types-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prior = process.env.GITBEACON_STATE_DIR;
  process.env.GITBEACON_STATE_DIR = root;
  try {
    await writeFile(join(root, "daemon.lock"), JSON.stringify({ pid: process.pid, token }));
    const file = join(root, "daemon.json"),
      now = new Date().toISOString();
    for (const value of [null, 0, true, [now], { date: now }, "not-a-date"]) {
      const content = JSON.stringify({ pid: process.pid, token, intervalMs: 5000, heartbeatAt: value });
      await writeFile(file, content);
      assert.equal((await daemonStatus()).running, false);
      assert.equal(await readFile(file, "utf8"), content);
    }
    await writeFile(file, JSON.stringify({ pid: process.pid, token, intervalMs: 5000, heartbeatAt: now }));
    assert.equal((await daemonStatus()).running, true);
    await writeFile(file, "{broken");
    assert.equal((await daemonStatus()).running, false);
    assert.equal(await readFile(file, "utf8"), "{broken");
  } finally {
    if (prior === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = prior;
  }
});

test("invalid array heartbeat does not mask an advanced ref", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { realpath, readdir } = await import("node:fs/promises");
  const { consumeMailbox } = await import("../../src/core/consumer.ts");
  const { sessionKey } = await import("../../src/core/mailbox.ts");
  const base = await mkdtemp(join(tmpdir(), "heartbeat-real-git-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const template = join(base, "template"),
    raw = join(base, "repo"),
    state = join(base, "state");
  await mkdir(template);
  execFileSync("git", ["init", "--template", template, "-b", "main", raw], { stdio: "pipe" });
  const root = await realpath(raw),
    common = await realpath(join(root, ".git"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${template}`,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  await writeFile(join(root, "shared"), "first\n");
  git("add", "shared");
  git("commit", "-m", "first");
  const first = git("rev-parse", "HEAD");
  await writeFile(join(root, "shared"), "second\n");
  git("add", "shared");
  git("commit", "-m", "second");
  const second = git("rev-parse", "HEAD");
  const identity = "c".repeat(64),
    id = hash([common, identity]),
    dir = join(state, "repos", id),
    agent = { adapter: "test", session: "receiver" },
    now = new Date().toISOString();
  const repo = { root, common, id, directory: dir, identity, identitySource: "marker" as const },
    key = sessionKey(repo, agent, ref);
  await writeFile(join(common, ".gitbeacon-id"), `${identity}\n`);
  for (const name of ["sessions", "events", "receipts", "refs", "trash"])
    await mkdir(join(dir, name), { recursive: true });
  for (const name of ["identity-owner.json", "identity-ready.json"])
    await writeFile(join(dir, name), JSON.stringify({ id }));
  await writeFile(
    join(dir, "sessions", `${key}.json`),
    JSON.stringify({ ...agent, key, root, ref, createdAt: now, lastSeen: now, baseline: first }),
  );
  await writeFile(
    join(dir, "refs", `${hash(ref)}.json`),
    JSON.stringify({ ref, commit: first, checkedAt: now, daemonToken: token }),
  );
  await writeFile(join(state, "daemon.lock"), JSON.stringify({ pid: process.pid, token }));
  await writeFile(
    join(state, "daemon.json"),
    JSON.stringify({ pid: process.pid, token, intervalMs: 5000, heartbeatAt: [now] }),
  );
  const prior = process.env.GITBEACON_STATE_DIR;
  process.env.GITBEACON_STATE_DIR = state;
  try {
    await consumeMailbox({
      cwd: root,
      ...agent,
      ref,
      async deliver() {
        assert.fail("clean worktree has no relevant notification");
      },
    });
    assert.equal((await readRef(repo, ref))?.commit, second);
    assert.equal((await readdir(join(dir, "events"))).length, 1);
  } finally {
    if (prior === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = prior;
  }
});
