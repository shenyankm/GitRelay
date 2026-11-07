import assert from "node:assert/strict";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import {
  eventsIn,
  listSessions,
  publishUpstream,
  sendMessage,
  sessionKey,
  type Notification,
} from "../../src/core/mailbox.ts";
import { readRef, synchronizeRef } from "../../src/core/publisher.ts";
import { hash, readJson, stateDirectory, withLock, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";
const receiver = (cwd: string, session: string) => ({ cwd, ref, adapter: "codex", session, async deliver() {} });

test("GC protects an event received before its ref cursor is committed", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local edit");
  const received: string[] = [];
  const b = {
    ...receiver(f.b, "B"),
    async deliver(batch: { event: { id: string } }[]) {
      received.push(...batch.map(({ event }) => event.id));
    },
  };
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  const next = await f.commit(f.main, "shared.txt", "upstream");
  const token = hash("daemon"),
    now = new Date().toISOString();
  await writeJson(join(stateDirectory(), "daemon.lock"), { pid: process.pid, token });
  await writeJson(join(stateDirectory(), "daemon.json"), {
    pid: process.pid,
    token,
    intervalMs: 5000,
    heartbeatAt: now,
  });
  const refPath = join(repo.directory, "refs", `${hash(ref)}.json`);
  const priorCursor = { ...(await readRef(repo, ref)), daemonToken: token };
  await writeJson(refPath, priorCursor);
  const event = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, ref, f.initial, next, [key]),
  );
  assert.equal((await readRef(repo, ref))?.commit, f.initial);
  await consumeMailbox(b);
  assert.deepEqual(received, [event.id]);
  await writeJson(refPath, priorCursor); // Model a historical receipt before cursor commit.
  const report = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
  assert.ok(report.kept.some((item) => item.id === event.id && item.reason === "publication"));
  await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b));
  await consumeMailbox(b);
  assert.deepEqual(received, [event.id]);
  assert.ok((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).removed.includes(event.id));
});

test("confirmed corrupt pending upstream events cannot be skipped during recovery", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local edit");
  const received: string[] = [];
  const b = {
    ...receiver(f.b, "B"),
    async deliver(batch: { event: { id: string } }[]) {
      received.push(...batch.map(({ event }) => event.id));
    },
  };
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  const next = await f.commit(f.main, "shared.txt", "upstream");
  const token = hash("daemon"),
    now = new Date().toISOString();
  await writeJson(join(stateDirectory(), "daemon.lock"), { pid: process.pid, token });
  await writeJson(join(stateDirectory(), "daemon.json"), {
    pid: process.pid,
    token,
    intervalMs: 5000,
    heartbeatAt: now,
  });
  const cursorPath = join(repo.directory, "refs", `${hash(ref)}.json`);
  const priorCursor = { ...(await readRef(repo, ref)), daemonToken: token };
  await writeJson(cursorPath, priorCursor);
  const event = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, ref, f.initial, next, [key]),
  );
  await consumeMailbox(b);
  assert.deepEqual(received, [event.id]);
  assert.ok(await readJson(join(repo.directory, "receipts", key, `${event.id}.json`)));
  await writeJson(cursorPath, priorCursor); // Restore the historical pending state with its receipt.
  assert.equal((await readRef(repo, ref))?.commit, f.initial);
  const eventPath = join(repo.directory, "events", `${event.id}.json`);
  await writeFile(eventPath, "{}");
  const cursor = await readFile(cursorPath, "utf8");
  // Publication discovery validates even an event previously confirmed by this session.
  await rm(join(stateDirectory(), "daemon.json"));
  await assert.rejects(consumeMailbox(b), /Invalid shared event/);
  assert.equal(await readFile(cursorPath, "utf8"), cursor);
  assert.equal(await readFile(eventPath, "utf8"), "{}");
  await writeJson(eventPath, event);
  await consumeMailbox(b);
  assert.deepEqual(received, [event.id]);
  assert.equal((await readRef(repo, ref))?.commit, next);
});

test("GC preserves uncertain publication and recovers interrupted trash with receipts", async (t) => {
  const f = await fixture(t),
    b = receiver(f.b, "B");
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  const next = await f.commit(f.main, "shared.txt", "upstream");
  const event = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, ref, f.initial, next, [key]),
  );
  const receiptPath = join(repo.directory, "receipts", key, `${event.id}.json`);
  await writeJson(receiptPath, { eventId: event.id, status: "delivered", at: new Date(0).toISOString() });
  const eventPath = join(repo.directory, "events", `${event.id}.json`),
    trash = join(repo.directory, "trash", `${event.id}.json`);
  const cursorPath = join(repo.directory, "refs", `${hash(ref)}.json`),
    cursor = await readFile(cursorPath);
  await rm(cursorPath);
  assert.ok(
    (await collectGarbage(f.b, { apply: true, retentionDays: 0 })).kept.some(
      (item) => item.id === event.id && item.reason === "publication",
    ),
  );
  await writeFile(cursorPath, "null");
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /Invalid ref cursor/);
  assert.equal(await readFile(cursorPath, "utf8"), "null");
  await writeFile(cursorPath, cursor);
  await rename(eventPath, trash);
  assert.ok(
    (await collectGarbage(f.b, { apply: true, retentionDays: 0 })).kept.some(
      (item) => item.id === event.id && item.reason === "publication",
    ),
  );
  const trashed = await readFile(trash);
  await writeFile(eventPath, trashed);
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /both events and trash/);
  assert.deepEqual(await readFile(eventPath), trashed);
  assert.deepEqual(await readFile(trash), trashed);
  await rm(eventPath);
  const receipt = await readFile(receiptPath);
  await rm(receiptPath);
  await assert.rejects(
    withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b)),
    /missing receipt/,
  );
  assert.ok(await readJson(trash));
  await writeFile(receiptPath, receipt);
  await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b));
  assert.equal(await readJson(trash), undefined);
  assert.ok(await readJson(eventPath));
  assert.ok((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).removed.includes(event.id));
});

test("GC distinguishes reset cycles and independent ref publication chains", async (t) => {
  const f = await fixture(t),
    b = receiver(f.b, "B");
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  git(f.main, "branch", "other");
  const sync = (name: string) => withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, name, b));
  await sync("refs/heads/other");
  const next = await f.commit(f.main, "shared.txt", "upstream");
  await sync(ref);
  const first = (await readRef(repo, ref))!.eventId!;
  git(f.main, "reset", "--hard", f.initial);
  await sync(ref);
  const reset = (await readRef(repo, ref))!.eventId!;
  const current = (await readRef(repo, ref))!;
  git(f.main, "reset", "--hard", next);
  const pending = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, ref, f.initial, next, [key], current.eventId),
  );
  const other = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, "refs/heads/other", f.initial, next, [key]),
  );
  assert.notEqual(first, pending.id);
  for (const event of await eventsIn(repo))
    for (const recipient of event.recipients)
      await writeJson(join(repo.directory, "receipts", recipient, `${event.id}.json`), {
        eventId: event.id,
        status: "delivered",
        at: new Date(0).toISOString(),
      });
  const report = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
  assert.ok(report.removed.includes(first));
  assert.ok(report.removed.includes(reset));
  assert.ok(report.kept.some((item) => item.id === pending.id && item.reason === "publication"));
  assert.ok(report.kept.some((item) => item.id === other.id && item.reason === "publication"));
  await sync(ref);
  assert.ok((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).removed.includes(pending.id));
  assert.ok((await eventsIn(repo)).some(({ id }) => id === other.id));
});

test("recovery commits a pending event before notifying about a newer head", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local edit");
  const received: Notification[] = [];
  const b = {
    ...receiver(f.b, "B"),
    async deliver(batch: typeof received) {
      received.push(...batch);
    },
  };
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  const firstCommit = await f.commit(f.main, "shared.txt", "first");
  const token = hash("daemon"),
    now = new Date().toISOString();
  await writeJson(join(stateDirectory(), "daemon.lock"), { pid: process.pid, token });
  await writeJson(join(stateDirectory(), "daemon.json"), {
    pid: process.pid,
    token,
    intervalMs: 5000,
    heartbeatAt: now,
  });
  const cursorPath = join(repo.directory, "refs", `${hash(ref)}.json`);
  const priorCursor = { ...(await readRef(repo, ref)), daemonToken: token };
  await writeJson(cursorPath, priorCursor);
  const pending = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, b, ref, f.initial, firstCommit, [key]),
  );
  await consumeMailbox(b);
  assert.ok(await readJson(join(repo.directory, "receipts", key, `${pending.id}.json`)));
  await writeJson(cursorPath, priorCursor); // Restore the historical pending state with its receipt.
  assert.equal((await readRef(repo, ref))?.commit, f.initial);
  const lastCommit = await f.commit(f.main, "shared.txt", "second");
  await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b));
  await consumeMailbox(b);
  assert.equal(received.length, 2);
  assert.equal(received[0].event.id, pending.id);
  assert.equal(received[1].kind, "upstream");
  if (received[1].kind !== "upstream") throw new Error("Expected upstream notification");
  assert.equal(received[1].event.previous, firstCommit);
  assert.equal(received[1].event.commit, lastCommit);
});

test("recovery delivers upstream events in chain order after a clock rollback", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local edit");
  const received: Notification[] = [];
  const b = {
    ...receiver(f.b, "B"),
    async deliver(batch: Notification[]) {
      received.push(...batch);
    },
  };
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  const first = await f.commit(f.main, "shared.txt", "first");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  try {
    await withLock(join(repo.directory, "publish.lock"), () => publishUpstream(repo, b, ref, f.initial, first, [key]));
  } finally {
    t.mock.timers.reset();
  }
  const second = await f.commit(f.main, "shared.txt", "second");
  await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b));
  await consumeMailbox(b);
  assert.equal(received.length, 2);
  const transitions = received.map((item) => {
    assert.equal(item.kind, "upstream");
    if (item.kind !== "upstream") throw new Error("Expected upstream notification");
    return [item.event.previous, item.event.commit];
  });
  assert.deepEqual(
    transitions.map((pair) => pair.join(":")).sort(),
    [`${f.initial}:${first}`, `${first}:${second}`].sort(),
  );
  assert.deepEqual(transitions, [
    [f.initial, first],
    [first, second],
  ]);
});

test("recovery handles a reset to the original head and rejects ambiguous pending events", async (t) => {
  const f = await fixture(t),
    b = receiver(f.b, "B");
  await consumeMailbox(b);
  const repo = await repository(f.b),
    key = sessionKey(repo, b, ref);
  const first = await f.commit(f.main, "shared.txt", "first");
  const second = await f.commit(f.main, "shared.txt", "second");
  const publish = (commit: string) =>
    withLock(join(repo.directory, "publish.lock"), () => publishUpstream(repo, b, ref, f.initial, commit, [key]));
  const pending = await publish(first),
    conflicting = await publish(second);
  const cursor = await readRef(repo, ref);
  await assert.rejects(
    withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b)),
    /Ambiguous pending/,
  );
  assert.deepEqual(await readRef(repo, ref), cursor);
  assert.ok((await eventsIn(repo)).some(({ id }) => id === pending.id));
  assert.ok((await eventsIn(repo)).some(({ id }) => id === conflicting.id));
  await rm(join(repo.directory, "events", `${conflicting.id}.json`));
  git(f.main, "reset", "--hard", f.initial);
  await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b));
  const events = await eventsIn(repo);
  assert.ok(
    events.some((event) => event.kind === "upstream" && event.previous === first && event.commit === f.initial),
  );
  assert.equal((await readRef(repo, ref))?.commit, f.initial);
});

test("GC revalidates subscription metadata on every run and still checks each receipt", async (t) => {
  const f = await fixture(t);
  const b = receiver(f.b, "B");
  await consumeMailbox(b);
  const first = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "first" });
  const second = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "second" });
  await consumeMailbox(b);
  const repo = await repository(f.b);
  const key = first.recipients[0];
  const path = join(repo.directory, "sessions", `${key}.json`);
  const session = (await readJson(path)) as object;
  assert.equal((await collectGarbage(f.b, { retentionDays: 0 })).eligible.length, 2);
  await rm(path);
  const unregistered = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
  assert.equal(unregistered.kept.length, 2);
  assert.ok(unregistered.kept.every(({ reason }) => reason === "subscription"));
  await writeJson(path, { key });
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /Invalid session/);
  await rm(path);
  assert.equal((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).kept.length, 2);
  await writeJson(path, session);
  await rm(join(repo.directory, "receipts", key, `${second.id}.json`));
  const applied = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
  assert.deepEqual(applied.removed, [first.id]);
  assert.deepEqual(applied.kept, [{ id: second.id, reason: "unconfirmed" }]);
  assert.deepEqual(
    (await eventsIn(repo)).map(({ id }) => id),
    [second.id],
  );
});

test("GC previews by default, keeps any unconfirmed recipient, and only removes event/receipts", async (t) => {
  const f = await fixture(t);
  const b = receiver(f.b, "B");
  const c = receiver(f.c, "C");
  await consumeMailbox(b);
  await consumeMailbox(c);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "broadcast" });
  await consumeMailbox(b);
  const partial = await collectGarbage(f.a, { apply: true, retentionDays: 0 });
  assert.ok(partial.kept.some((item) => item.id === event.id && item.reason === "unconfirmed"));
  await consumeMailbox(c);
  const repo = await repository(f.a);
  const sessions = await listSessions(f.a);
  const refBefore = await readJson(join(repo.directory, "refs", `${hash(ref)}.json`));
  const preview = await collectGarbage(f.a, { retentionDays: 0 });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.eligible, [event.id]);
  assert.equal((await eventsIn(repo)).length, 1);
  const applied = await collectGarbage(f.a, { apply: true, retentionDays: 0 });
  assert.deepEqual(applied.removed, [event.id]);
  assert.equal((await eventsIn(repo)).length, 0);
  for (const key of event.recipients)
    assert.equal(await readJson(join(repo.directory, "receipts", key, `${event.id}.json`)), undefined);
  assert.deepEqual(await listSessions(f.a), sessions);
  assert.deepEqual(await readJson(join(repo.directory, "refs", `${hash(ref)}.json`)), refBefore);
  assert.deepEqual((await collectGarbage(f.a, { apply: true, retentionDays: 0 })).removed, []);
});

test("retention starts after the latest confirmation, not merely an old event timestamp", async (t) => {
  const f = await fixture(t);
  const b = receiver(f.b, "B");
  await consumeMailbox(b);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "old event, recent delivery" });
  await consumeMailbox(b);
  const repo = await repository(f.b);
  const eventPath = join(repo.directory, "events", `${event.id}.json`);
  const receiptPath = join(repo.directory, "receipts", event.recipients[0], `${event.id}.json`);
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await writeJson(eventPath, { ...event, createdAt: old });
  assert.ok((await collectGarbage(f.b, { apply: true })).kept.some((item) => item.reason === "retention"));
  const receipt = (await readJson(receiptPath)) as object;
  await writeJson(receiptPath, { ...receipt, at: old });
  assert.deepEqual((await collectGarbage(f.b, { apply: true })).removed, [event.id]);
  await assert.rejects(collectGarbage(f.b, { retentionDays: -1 }), /retentionDays/);
  await assert.rejects(collectGarbage(f.b, { retentionDays: Infinity }), /retentionDays/);
});

test("GC skips a busy consumer instead of deleting a cached event or deadlocking", async (t) => {
  const f = await fixture(t);
  const b = receiver(f.b, "B");
  await consumeMailbox(b);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "confirmed" });
  await consumeMailbox(b);
  const repo = await repository(f.b);
  await withLock(join(repo.directory, "sessions", `${event.recipients[0]}.lock`), async () => {
    const report = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
    assert.ok(report.kept.some((item) => item.id === event.id && item.reason === "busy"));
    assert.equal((await eventsIn(repo)).length, 1);
  });
  assert.deepEqual((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).removed, [event.id]);
});

test("GC resumes its committed trash journal after a partial deletion", async (t) => {
  const f = await fixture(t);
  const b = receiver(f.b, "B");
  const c = receiver(f.c, "C");
  await consumeMailbox(b);
  await consumeMailbox(c);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "fully confirmed" });
  await consumeMailbox(b);
  await consumeMailbox(c);
  const repo = await repository(f.b);
  await rename(join(repo.directory, "events", `${event.id}.json`), join(repo.directory, "trash", `${event.id}.json`));
  await rm(join(repo.directory, "receipts", event.recipients[0], `${event.id}.json`));
  const preview = await collectGarbage(f.b);
  assert.deepEqual(preview.eligible, [event.id]);
  assert.deepEqual((await collectGarbage(f.b, { apply: true })).removed, [event.id]);
  assert.equal(await readJson(join(repo.directory, "trash", `${event.id}.json`)), undefined);
  for (const key of event.recipients)
    assert.equal(await readJson(join(repo.directory, "receipts", key, `${event.id}.json`)), undefined);
});

test("GC fails closed on malformed receipts and honors cancellation", async (t) => {
  const f = await fixture(t);
  const b = receiver(f.b, "B");
  await consumeMailbox(b);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "must survive" });
  await consumeMailbox(b);
  const repo = await repository(f.b);
  await writeJson(join(repo.directory, "receipts", event.recipients[0], `${event.id}.json`), {
    eventId: event.id,
    status: "unknown",
    at: new Date().toISOString(),
  });
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /Invalid receipt/);
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0, signal: AbortSignal.abort() }), /abort/i);
  assert.equal((await eventsIn(repo)).length, 1);
});
