import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { worktreeFiles } from "../../src/core/changes.ts";
import { daemonStatus } from "../../src/core/daemon-state.ts";
import { removeWorktree, listWorktrees } from "../../src/core/git.ts";
import {
  eventsIn,
  formatNotifications,
  publishUpstream,
  readReceipt,
  readSession,
  registerSession,
  sendMessage,
  sessionKey,
  type Notification,
} from "../../src/core/mailbox.ts";
import { readRef, synchronizeRef } from "../../src/core/publisher.ts";
import { chooseFreshRepository, repository, stateDirectory, withLock, writeJson } from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";

test("legacy directory-style message paths remain readable without becoming broadcasts", async (t) => {
  const f = await fixture(t);
  const b = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver() {
      assert.fail("legacy directory paths must not broadcast");
    },
  };
  await consumeMailbox(b);
  const repo = await repository(f.b);
  const key = sessionKey(repo, b, ref);
  const sender = { cwd: f.a, ref, adapter: "cc", session: "A" };
  // Persist the exact path forms accepted by 733c860's producer.
  for (const file of ["src/", ".", "./", "./C:/x", "src/."]) {
    const event = await sendMessage({ ...sender, text: "legacy", files: ["shared.txt"] });
    await writeJson(join(repo.directory, "events", `${event.id}.json`), { ...event, files: [file] });
    await consumeMailbox(b);
    assert.equal(
      JSON.parse(await readFile(join(repo.directory, "receipts", key, `${event.id}.json`), "utf8")).status,
      "irrelevant",
    );
  }
  assert.equal((await eventsIn(repo)).length, 5);
  await consumeMailbox({
    ...sender,
    async deliver() {
      assert.fail("sender must not receive itself");
    },
  });
  await consumeMailbox({ ...b, session: "new" });
  assert.equal((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).removed.length, 5);
});

test("send rejects existing directories even without a trailing slash, but permits deleted file paths", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.a, "src"));
  const sender = { cwd: f.a, adapter: "cc", session: "A", text: "paths" };
  for (const file of ["src", "./src", "src/.", "src//."]) {
    await assert.rejects(sendMessage({ ...sender, files: [file] }), /file.*director|director.*file/i);
  }
  assert.equal((await eventsIn(await repository(f.a))).length, 0);
  assert.deepEqual((await sendMessage({ ...sender, files: ["deleted.ts"] })).files, ["deleted.ts"]);
  if (process.platform !== "win32") {
    await symlink("src", join(f.a, "linkdir"));
    await symlink("cycle-b", join(f.a, "cycle-a"));
    await symlink("cycle-a", join(f.a, "cycle-b"));
    git(f.a, "add", "linkdir", "cycle-a", "cycle-b");
    for (const file of ["linkdir", "cycle-a"]) {
      assert.deepEqual((await sendMessage({ ...sender, files: [file] })).files, [file]);
    }
    await assert.rejects(
      sendMessage({ ...sender, files: ["cycle-a/child"] }),
      /Cannot inspect message file path.*cycle-a\/child.*ELOOP/,
    );
  }
});

test("corrupt daemon liveness hints never prevent local fallback", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  let delivered = 0;
  const b = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver() {
      delivered++;
    },
  };
  await consumeMailbox(b);
  for (const name of ["daemon.lock", "daemon.json"]) {
    for (const data of ["", "{broken"]) {
      await writeFile(join(stateDirectory(), name), data);
      assert.deepEqual(await daemonStatus(), { running: false });
      await f.commit(f.main, "shared.txt", `update ${name} ${data}\n`);
      await consumeMailbox(b);
      await rm(join(stateDirectory(), name));
    }
  }
  assert.equal(delivered, 4);
});

test("send-first legacy sessions retain the pre-publication migration baseline", async (t) => {
  const f = await fixture(t);
  const observer = { cwd: f.c, ref, adapter: "opencode", session: "observer", async deliver() {} };
  await consumeMailbox(observer);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const received: Notification[] = [];
  const b = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver(batch: Notification[]) {
      received.push(...batch);
    },
  };
  const repo = await repository(f.b);
  const key = sessionKey(repo, b, ref);
  await mkdir(join(repo.common, "worktree-agent-sync"));
  await writeJson(join(repo.common, "worktree-agent-sync", `${key}.json`), { root: f.b, ref, commit: f.initial });
  // Model an older producer: current send intentionally does not subscribe.
  await registerSession(repo, b, ref);
  const first = await f.commit(f.main, "shared.txt", "first\n");
  await consumeMailbox(observer);
  const second = await f.commit(f.main, "shared.txt", "second\n");
  await consumeMailbox(observer);
  await consumeMailbox(b);
  await consumeMailbox(b);
  assert.equal((await readSession(repo, key))!.baseline, f.initial);
  assert.deepEqual(
    received.map((n) => (n.kind === "upstream" ? [n.event.previous, n.event.commit] : [])),
    [
      [f.initial, first],
      [first, second],
    ],
  );
});

test("retry after event publication includes new subscribers without replaying existing receipts", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  await writeFile(join(f.c, "shared.txt"), "C local\n");
  const b = { cwd: f.b, ref, adapter: "codex", session: "B", async deliver() {} };
  await consumeMailbox(b);
  const repo = await repository(f.b);
  const next = await f.commit(f.main, "shared.txt", "upstream\n");
  // Model a crash after publishing the event but before committing the ref cursor.
  const key = sessionKey(repo, b, ref);
  const event = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, ref, f.initial, next, [key]),
  );
  const receipt = { eventId: event.id, status: "delivered", at: new Date().toISOString() };
  await writeJson(join(repo.directory, "receipts", key, `${event.id}.json`), receipt);
  assert.equal((await readRef(repo, ref))!.commit, f.initial);
  const c = { cwd: f.c, ref, adapter: "opencode", session: "C", async deliver() {} };
  await registerSession(await repository(f.c), c, ref);
  await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b));
  const retried = (await eventsIn(repo)).find((item) => item.id === event.id)!;
  assert.ok(retried.recipients.includes(sessionKey(await repository(f.c), c, ref)));
  const delivered = await consumeMailbox(c);
  assert.equal(delivered.filter((n) => n.kind === "upstream").length, 1);
  assert.equal(delivered[0].event.id, event.id);
  assert.deepEqual(await consumeMailbox(c), []);
  assert.deepEqual(await consumeMailbox({ ...b, upstreamOnly: true }), []);
  assert.deepEqual(await readReceipt(repo, key, event.id), receipt);
});

test("retry refuses corrupted upstream events without advancing the ref or acknowledging them", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local edit\n");
  const b = { cwd: f.b, ref, adapter: "codex", session: "B", async deliver() {} };
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  const next = await f.commit(f.main, "shared.txt", "upstream\n");
  const event = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, ref, f.initial, next, [key]),
  );
  const c = { cwd: f.c, ref, adapter: "opencode", session: "C" };
  await registerSession(await repository(f.c), c, ref);
  const cursor = await readRef(repo, ref),
    path = join(repo.directory, "events", `${event.id}.json`);
  const invalid = [
    { ...event, ref: "refs/heads/other" },
    { ...event, previous: next },
    { ...event, commit: f.initial },
    { ...event, kind: "message", text: "wrong kind", files: [] },
    null,
    false,
    0,
    "",
  ];
  for (const value of invalid) {
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    await assert.rejects(consumeMailbox(b), /Invalid|Expected upstream|does not match/);
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.deepEqual(await readRef(repo, ref), cursor);
    assert.equal(await readReceipt(repo, key, event.id), undefined);
  }
  await writeJson(path, event);
  const delivered = await consumeMailbox(b);
  assert.equal(delivered.length, 1);
  assert.deepEqual([delivered[0].event.kind, delivered[0].event.id], ["upstream", event.id]);
  assert.ok(
    (await eventsIn(repo))
      .find((item) => item.id === event.id)
      ?.recipients.includes(sessionKey(await repository(f.c), c, ref)),
  );
});

test("unborn and unrelated worktree histories give actionable errors and preserve pending events", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const b = { cwd: f.b, ref, adapter: "codex", session: "B", async deliver() {} };
  await consumeMailbox(b);
  await f.commit(f.main, "shared.txt", "upstream\n");
  git(f.b, "restore", "--", "shared.txt");
  git(f.b, "switch", "--orphan", "unrelated");
  await assert.rejects(consumeMailbox(b), /HEAD.*commit|HEAD.*commit/);
  await f.commit(f.b, "shared.txt", "orphan commit\n");
  await assert.rejects(worktreeFiles(f.b, f.initial), /common ancestor|common ancestor/);
  await assert.rejects(consumeMailbox(b), /common ancestor|common ancestor/);
  const repo = await repository(f.b);
  assert.equal((await eventsIn(repo)).filter((event) => event.kind === "upstream").length, 1);
  assert.deepEqual(await readdir(join(repo.directory, "receipts", sessionKey(repo, b, ref))), []);
  git(f.b, "switch", "feature/b");
  await writeFile(join(f.b, "shared.txt"), "local again\n");
  assert.equal((await consumeMailbox(b)).length, 1);
});

test("concurrent consumers all receive every broadcast rather than losing the publish-lock race", async (t) => {
  const f = await fixture(t);
  const received = Array.from({ length: 10 }, () => [] as string[]);
  const consumers = received.map((ids, index) => ({
    cwd: f.b,
    ref,
    adapter: "test",
    session: `receiver-${index}`,
    async deliver(batch: Notification[]) {
      ids.push(...batch.map((notification) => notification.event.id));
    },
  }));
  await Promise.all(consumers.map(consumeMailbox));
  const expected: string[] = [];
  for (let round = 0; round < 3; round++) {
    expected.push((await sendMessage({ cwd: f.a, adapter: "cli", session: "send-only", text: `round ${round}` })).id);
    await Promise.all(consumers.map(consumeMailbox));
    for (const ids of received) assert.deepEqual(ids, expected);
  }
});

test("send-only identities do not subscribe or prevent consumers from collecting each other's broadcasts", async (t) => {
  const f = await fixture(t);
  const b = { cwd: f.b, ref, adapter: "codex", session: "B", async deliver() {} };
  const c = { cwd: f.c, ref, adapter: "opencode", session: "C", async deliver() {} };
  await consumeMailbox(b);
  await consumeMailbox(c);
  const first = await sendMessage({
    cwd: f.a,
    ref: "refs/heads/mian",
    adapter: "cli",
    session: "one-off",
    text: "send without subscribing",
  });
  const senderRepo = await repository(f.a);
  const senderKey = sessionKey(senderRepo, { adapter: "cli", session: "one-off" }, "refs/heads/mian");
  assert.equal(await readSession(senderRepo, senderKey), undefined);
  await consumeMailbox(b);
  await consumeMailbox(c);
  const second = await sendMessage({ ...b, text: "B to C" });
  const third = await sendMessage({ ...c, text: "C to B" });
  assert.equal(second.recipients.length, 1);
  assert.equal(third.recipients.length, 1);
  await consumeMailbox(b);
  await consumeMailbox(c);
  assert.deepEqual(
    new Set((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).removed),
    new Set([first.id, second.id, third.id]),
  );
});

test("pruned Git objects become an acknowledged history-gap notification, not an inbox barrier", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const b = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(b);
  const lost = await f.commit(f.main, "shared.txt", "pruned commit\n");
  await consumeMailbox({
    ...b,
    async deliver() {
      return false;
    },
  });
  git(f.main, "reset", "--hard", f.initial);
  git(f.main, "reflog", "expire", "--expire=now", "--all");
  git(f.main, "gc", "--prune=now");
  assert.throws(() => git(f.main, "cat-file", "-e", lost));
  await f.commit(f.main, "shared.txt", "new history\n");
  const message = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "must get past old history" });
  const repo = await repository(f.b);
  const key = sessionKey(repo, b, ref);
  const queued = await consumeMailbox({
    ...b,
    acknowledgeUnavailableHistory: true,
    async deliver() {
      return false;
    },
  });
  const gaps = queued.filter((item) => item.kind === "upstream" && item.change.unavailable);
  assert.equal(gaps.length, 2, "both a missing range end and a missing range start are diagnosed");
  assert.match(formatNotifications(gaps), /history unavailable/);
  for (const item of queued) assert.equal(await readReceipt(repo, key, item.event.id), undefined);
  const accepted = await consumeMailbox({ ...b, acknowledgeUnavailableHistory: true });
  assert.ok(accepted.some((item) => item.event.id === message.id));
  for (const item of accepted) assert.equal((await readReceipt(repo, key, item.event.id))?.status, "delivered");
  assert.deepEqual(await consumeMailbox(b), []);
  await f.commit(f.main, "shared.txt", "normal update\n");
  const next = await consumeMailbox(b);
  assert.equal(next.length, 1);
  assert.ok(next[0].kind === "upstream" && !next[0].change.unavailable);
});

test("recreating an unrelated repository at the same path keeps old messages isolated", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.main, ref, adapter: "test", session: "same-path", async deliver() {} };
  await consumeMailbox(receiver);
  const oldRepo = await repository(f.main);
  const oldMessage = await sendMessage({
    cwd: f.main,
    adapter: "cli",
    session: "old-sender",
    text: "old repository secret",
  });
  const oldEvent = join(oldRepo.directory, "events", `${oldMessage.id}.json`);
  const original = await readFile(oldEvent);
  await rm(join(f.main, ".git"), { recursive: true });
  git(f.main, "init", "-b", "main");
  await f.commit(f.main, "shared.txt", "replacement repository\n");
  await assert.rejects(consumeMailbox(receiver), /Earlier GitRelay state exists/);
  assert.deepEqual(await readFile(oldEvent), original, "refusal must preserve unread old state");
  await chooseFreshRepository(f.main);
  const replacement = await repository(f.main);
  assert.notEqual(replacement.directory, oldRepo.directory);
  assert.deepEqual(await consumeMailbox(receiver), []);
  const message = await sendMessage({ cwd: f.main, adapter: "cli", session: "send-only", text: "new repo note" });
  const batch = await consumeMailbox(receiver);
  assert.ok(batch.some((item) => item.event.id === message.id));
  assert.ok(!batch.some((item) => item.event.id === oldMessage.id));
  assert.deepEqual(await readFile(oldEvent), original, "unread old state must remain unchanged");
  assert.deepEqual(await consumeMailbox(receiver), []);
});

test("a prunable worktree registration is retained while automatic removal is unavailable", async (t) => {
  const f = await fixture(t);
  await rm(f.a, { recursive: true });
  assert.notEqual((await listWorktrees(f.main)).find((tree) => tree.path === f.a)!.prunable, undefined);
  await assert.rejects(removeWorktree(f.main, f.a), /Automatic worktree removal is temporarily unavailable/);
  assert.equal(
    (await listWorktrees(f.main)).some((tree) => tree.path === f.a),
    true,
  );
  assert.equal(git(f.main, "rev-parse", "feature/a").trim(), f.initial);
});
