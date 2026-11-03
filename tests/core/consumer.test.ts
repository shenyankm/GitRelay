import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeChanges, consumeMailbox } from "../../src/core/consumer.ts";
import { eventsIn, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { readJson, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

test("persistent per-session checkpoints deduplicate, resume and retry failed delivery", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  let delivered = 0;
  let fail = false;
  const options = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "one",
    async deliver() {
      if (fail) throw new Error("offline");
      delivered++;
    },
  };
  await consumeChanges(options);
  assert.equal(delivered, 0);
  await f.commit(f.main, "shared.txt", "upstream 1\n");
  fail = true;
  await assert.rejects(consumeChanges(options), /offline/);
  fail = false;
  await consumeChanges(options);
  await consumeChanges({ ...options });
  assert.equal(delivered, 1);
  await consumeChanges({ ...options, session: "two" }); // New conversations start at the current main.
  await f.commit(f.main, "shared.txt", "upstream 2\n");
  await consumeChanges(options);
  await consumeChanges({ ...options, session: "two" });
  assert.equal(delivered, 3);
  await assert.rejects(consumeChanges({ ...options, session: "" }), /session ID/);
});

test("upstream-only compatibility consumer preserves pi events with unresolved proofs", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  let calls = 0;
  const receiver = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "pi",
    session: "compat",
    async deliver() {
      calls++;
    },
  };
  const publisher = { cwd: f.a, ref: receiver.ref, adapter: "test", session: "publisher", async deliver() {} };
  await consumeChanges(receiver);
  await consumeMailbox(publisher);
  await f.commit(f.main, "shared.txt", "upstream\n");
  await consumeMailbox(publisher);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, receiver.ref);
  const event = (await eventsIn(repo)).find((item) => item.kind === "upstream" && item.recipients.includes(key));
  assert.ok(event);
  const dir = join(repo.directory, "receipts", key),
    digest = "a".repeat(64);
  await writeJson(join(dir, `${event.id}.${digest}.pi-proof`), { eventId: event.id, digest });
  await assert.rejects(consumeChanges(receiver), /Pi delivery outcome is unknown/);
  assert.equal(calls, 0);
  assert.equal(await readJson(join(dir, `${event.id}.json`)), undefined);
});

test("compatibility delivery retains receipts for successful callbacks before a later failure", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const attempts: string[] = [];
  let fail = true;
  const receiver = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "receiver",
    async deliver(change: { eventId?: string }) {
      attempts.push(change.eventId!);
      if (fail && attempts.length === 2) throw new Error("offline");
    },
  };
  const publisher = { cwd: f.a, ref: receiver.ref, adapter: "test", session: "publisher", async deliver() {} };
  await consumeChanges(receiver);
  await consumeMailbox(publisher);
  await f.commit(f.main, "shared.txt", "first\n");
  await consumeMailbox(publisher);
  await f.commit(f.main, "shared.txt", "second\n");
  await consumeMailbox(publisher);
  await assert.rejects(consumeChanges(receiver), /offline/);
  assert.equal(attempts.length, 2);
  fail = false;
  await consumeChanges(receiver);
  assert.deepEqual(attempts, [attempts[0], attempts[1], attempts[1]]);
  await consumeChanges(receiver);
  assert.equal(attempts.length, 3);
});

test("individual delivery commits each successful callback before cancellation", async (t) => {
  const f = await fixture(t);
  const ref = "refs/heads/main";
  const abort = new AbortController();
  const seen: string[] = [];
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "individual",
    deliverIndividually: true,
    signal: abort.signal,
    async deliver(batch: { event: { id: string } }[]) {
      assert.equal(batch.length, 1);
      seen.push(batch[0].event.id);
      if (seen.length === 2) abort.abort();
    },
  };
  await consumeMailbox(receiver);
  const first = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "first" });
  const second = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "second" });
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  await writeJson(join(repo.directory, "events", `${first.id}.json`), {
    ...first,
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  await writeJson(join(repo.directory, "events", `${second.id}.json`), {
    ...second,
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  await assert.rejects(consumeMailbox(receiver), /abort/i);
  assert.deepEqual(seen, [first.id, second.id]);
  assert.ok(await readJson(join(repo.directory, "receipts", key, `${first.id}.json`)));
  assert.equal(await readJson(join(repo.directory, "receipts", key, `${second.id}.json`)), undefined);
  const retry: string[] = [];
  await consumeMailbox({
    ...receiver,
    signal: undefined,
    async deliver(batch) {
      retry.push(...batch.map((item) => item.event.id));
    },
  });
  assert.deepEqual(retry, [second.id]);
});

test("host-pending events are skipped without receipts and do not block later events", async (t) => {
  const f = await fixture(t);
  let pending = true;
  let held = "";
  const delivered: string[] = [];
  const options = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "pending",
    isPending(id: string) {
      return pending && id === held;
    },
    async deliver(batch: { event: { id: string } }[]) {
      delivered.push(...batch.map((item) => item.event.id));
    },
  };
  await consumeMailbox(options);
  const first = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "first" });
  const second = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "second" });
  held = first.id;
  await consumeMailbox(options);
  assert.deepEqual(delivered, [second.id]);
  const repo = await repository(f.b);
  const key = sessionKey(repo, options, options.ref);
  assert.equal(await readJson(join(repo.directory, "receipts", key, `${first.id}.json`)), undefined);
  pending = false;
  await consumeMailbox(options);
  assert.deepEqual(delivered, [second.id, first.id]);
});

test("abandoned locks are reported without deleting another process's state", async (t) => {
  const f = await fixture(t);
  const options = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "stale", async deliver() {} };
  await consumeChanges(options);
  const directory = join((await repository(f.b)).directory, "sessions");
  const cursor = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
  await writeFile(join(directory, cursor.replace(/\.json$/, ".lock")), JSON.stringify({ pid: 2_000_000_000 }));
  await assert.rejects(consumeChanges(options), /Stale git-relay lock/);
  assert.ok((await readdir(directory)).includes(cursor));
});

test("concurrent checks on one session do not double-deliver", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  let delivered = 0;
  const options = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "concurrent",
    async deliver() {
      delivered++;
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  };
  await consumeChanges(options);
  await f.commit(f.main, "shared.txt", "new\n");
  await Promise.all([consumeChanges(options), consumeChanges(options)]);
  assert.equal(delivered, 1);
});
