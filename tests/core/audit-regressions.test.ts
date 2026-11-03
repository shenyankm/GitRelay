import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import { inspectChange, pathMatcher } from "../../src/core/changes.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { runDaemon } from "../../src/core/daemon.ts";
import { readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { leaveSession } from "../../src/core/sessions.ts";
import { BusyError, hash, readJson, stateDirectory, withLock, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";

test("ignored local files remain relevant without exposing their contents", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, ".gitignore"), ".env\n");
  await writeFile(join(f.b, ".env"), "LOCAL-SECRET");
  const current = await f.commit(f.main, ".env", "upstream\n");
  const change = await inspectChange({ root: f.b, ref, commit: f.initial }, current);
  assert.deepEqual(change?.files, [".env"]);
  assert.ok(!JSON.stringify(change).includes("LOCAL-SECRET"));
  assert.equal(await readFile(join(f.b, ".env"), "utf8"), "LOCAL-SECRET");
});

for (const localDirectory of [true, false]) {
  test(`upstream and messages detect file/directory overlap: local directory=${localDirectory}`, async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
    await consumeMailbox(receiver);
    if (localDirectory) await mkdir(join(f.b, "foo"));
    else await mkdir(join(f.main, "foo"));
    await writeFile(join(f.b, localDirectory ? "foo/local.txt" : "foo"), "local");
    const file = localDirectory ? "foo" : "foo/upstream.txt";
    const current = await f.commit(f.main, file, "upstream");
    assert.deepEqual((await inspectChange({ root: f.b, ref, commit: f.initial }, current))?.files, [file]);
    const event = await sendMessage({
      cwd: f.main,
      adapter: "test",
      session: "sender",
      text: "overlap",
      files: [file],
    });
    assert.ok((await consumeMailbox(receiver)).some((item) => item.event.id === event.id));
    const matches = await pathMatcher(f.b, new Set(["foobar/local.txt"]));
    assert.equal(matches("foo"), false);
  });
}

test("file messages respect Git case folding and do not require sender-side parent directories", async (t) => {
  const f = await fixture(t);
  git(f.b, "config", "core.ignorecase", "true");
  const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  await writeFile(join(f.b, "shared.txt"), "dirty");
  await writeFile(join(f.a, "foo"), "sender file");
  await mkdir(join(f.b, "foo"));
  await writeFile(join(f.b, "foo/child.txt"), "receiver file");
  for (const file of ["Shared.txt", "foo/child.txt"]) {
    const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: file, files: [file] });
    assert.ok((await consumeMailbox(receiver)).some((item) => item.event.id === event.id));
  }
  git(f.b, "config", "core.ignorecase", "false");
  assert.equal((await pathMatcher(f.b, new Set(["shared.txt"])))("Shared.txt"), false);
});

test("file message relevance resolves the live ref even when the daemon cache is fresh", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  await f.commit(f.main, "shared.txt", "integrated");
  git(f.b, "merge", "--ff-only", "main");
  const token = hash("daemon");
  await writeJson(join(stateDirectory(), "daemon.lock"), { pid: process.pid, token });
  await writeJson(join(stateDirectory(), "daemon.json"), {
    pid: process.pid,
    token,
    intervalMs: 5000,
    heartbeatAt: new Date().toISOString(),
  });
  const event = await sendMessage({
    cwd: f.a,
    adapter: "test",
    session: "sender",
    text: "already integrated",
    files: ["shared.txt"],
  });
  assert.deepEqual(await consumeMailbox(receiver), []);
  const repo = await repository(f.b);
  assert.equal((await readReceipt(repo, sessionKey(repo, receiver, ref), event.id))?.status, "irrelevant");
});

test("removed worktrees can explicitly leave without acknowledging unread messages", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const key = sessionKey(repo, receiver, ref);
  const unread = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "unread" });
  git(f.main, "worktree", "remove", f.b);
  assert.ok((await leaveSession(receiver))?.closedAt);
  assert.equal(await readReceipt(repo, key, unread.id), undefined);
  assert.deepEqual(
    (await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "after leave" })).recipients,
    [],
  );
});

test(
  "removed worktree leave requires its registered canonical path",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const alias = join(f.root, "alias");
    await symlink(f.root, alias);
    const receiver = { cwd: join(alias, basename(f.b)), ref, adapter: "test", session: "B", async deliver() {} };
    await consumeMailbox(receiver);
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const unread = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "unread" });
    git(f.main, "worktree", "remove", f.b);
    await assert.rejects(leaveSession(receiver), /Cannot uniquely locate/);
    assert.ok((await leaveSession({ ...receiver, cwd: repo.root }))?.closedAt);
    assert.equal(await readReceipt(repo, key, unread.id), undefined);
    assert.deepEqual(
      (await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "after leave" })).recipients,
      [],
    );
  },
);

for (const kind of ["metadata", "sessions", "repository"] as const)
  test(`removed worktree leave ignores unrelated corrupt ${kind}`, async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
    await consumeMailbox(receiver);
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const unread = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "unread" });
    const unrelated = join(stateDirectory(), "repos", "f".repeat(64));
    if (kind !== "repository") await mkdir(unrelated);
    const corrupt = kind === "repository" ? unrelated : join(unrelated, kind === "metadata" ? "repo.json" : "sessions");
    await writeFile(corrupt, "{corrupt");
    git(f.main, "worktree", "remove", f.b);
    assert.ok((await leaveSession(receiver))?.closedAt);
    assert.equal(await readReceipt(repo, key, unread.id), undefined);
    assert.equal(await readFile(corrupt, "utf8"), "{corrupt");
  });

test("removed worktree leave rejects corrupt metadata for its own session", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b),
    path = join(repo.directory, "sessions", `${sessionKey(repo, receiver, ref)}.json`);
  const before = await readFile(path);
  git(f.main, "worktree", "remove", f.b);
  await writeFile(join(repo.directory, "repo.json"), "{corrupt");
  await assert.rejects(leaveSession(receiver), SyntaxError);
  assert.deepEqual(await readFile(path), before);
});

test("dangling lock symlinks fail immediately for ordinary operations and daemon", async (t) => {
  const f = await fixture(t);
  await repository(f.b);
  const path = join(stateDirectory(), "daemon.lock");
  await symlink(join(f.root, "missing"), path);
  await assert.rejects(
    withLock(path, async () => assert.fail(), { waitMs: 200 }),
    /not a regular file/,
  );
  await assert.rejects(runDaemon({ signal: new AbortController().signal }), /not a regular file/);
});

test("lock handoff cannot diagnose the replacement using the previous PID", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "handoff.lock");
  await writeJson(path, { pid: 2147483647 });
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, JSON.stringify({ pid: process.pid }));
  t.mock.method(process, "kill", () => {
    renameSync(replacement, path);
    throw Object.assign(new Error("old owner gone"), { code: "ESRCH" });
  });
  await assert.rejects(
    withLock(path, async () => assert.fail()),
    BusyError,
  );
  assert.equal(((await readJson(path)) as { pid: number }).pid, process.pid);
});

test("lock release leaves an externally replaced lock intact", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "replaced.lock");
  await withLock(path, async () => {
    await rm(path);
    await writeJson(path, { pid: process.pid, token: "replacement" });
  });
  assert.equal(((await readJson(path)) as { token: string }).token, "replacement");
});

test("missing repositories warn once, retain unread state and collect confirmed events", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const confirmed = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "confirmed" });
  await consumeMailbox(receiver);
  const unread = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "unread" });
  const repo = await repository(f.b);
  await rm(repo.common, { recursive: true });
  const abort = new AbortController();
  const events: any[] = [];
  const timer = setTimeout(() => abort.abort(), 350);
  try {
    await runDaemon({
      signal: abort.signal,
      intervalMs: 50,
      retentionDays: 0,
      onEvent(event) {
        events.push(event);
      },
    });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(events.filter((event) => event.type === "daemon.repository-missing").length, 1);
  assert.equal(events.filter((event) => event.type === "daemon.error").length, 0);
  assert.equal(await readJson(join(repo.directory, "events", `${confirmed.id}.json`)), undefined);
  assert.ok(await readJson(join(repo.directory, "events", `${unread.id}.json`)));
});
