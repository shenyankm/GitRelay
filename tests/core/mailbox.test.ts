import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { eventsIn, listSessions, sendMessage, sessionKey, type Notification } from "../../src/core/mailbox.ts";
import { synchronizeRef } from "../../src/core/publisher.ts";
import { repository, withLock } from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";

test("invalid UTF-8 in an event or receipt cannot silently acknowledge a message", async (t) => {
  const f = await fixture(t);
  const delivered: string[] = [];
  const recipient = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "recipient",
    async deliver(batch: Notification[]) {
      delivered.push(...batch.map((item) => item.event.id));
    },
  };
  await consumeMailbox(recipient);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "ABCZZZDEF" });
  const repo = await repository(f.b),
    key = sessionKey(repo, recipient, ref);
  const eventPath = join(repo.directory, "events", `${event.id}.json`),
    receiptPath = join(repo.directory, "receipts", key, `${event.id}.json`);
  const original = await readFile(eventPath),
    corrupt = Buffer.from(original);
  const offset = corrupt.indexOf(Buffer.from("ZZZ"));
  assert.notEqual(offset, -1);
  corrupt[offset] = 0xff;
  await writeFile(eventPath, corrupt);
  await assert.rejects(consumeMailbox(recipient), /Invalid UTF-8 in state file/);
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /Invalid UTF-8 in state file/);
  assert.deepEqual(await readFile(eventPath), corrupt);
  await assert.rejects(stat(receiptPath), { code: "ENOENT" });
  assert.deepEqual(delivered, []);

  await writeFile(eventPath, original);
  const invalidReceipt = Buffer.concat([
    Buffer.from(`{"eventId":"${event.id}","status":"delivered","at":"${new Date().toISOString()}","note":"`),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  await writeFile(receiptPath, invalidReceipt);
  await assert.rejects(consumeMailbox(recipient), /Invalid UTF-8 in state file/);
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /Invalid UTF-8 in state file/);
  assert.deepEqual(await readFile(eventPath), original);
  assert.deepEqual(await readFile(receiptPath), invalidReceipt);
  assert.deepEqual(delivered, []);
  await rm(receiptPath);
  await consumeMailbox(recipient);
  assert.deepEqual(delivered, [event.id]);
});

test("Claude Code publishes one message; Codex and OpenCode receive independent copies", async (t) => {
  const f = await fixture(t);
  const b: Notification[] = [];
  const c: Notification[] = [];
  const codex = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "same-native-id",
    async deliver(batch: Notification[]) {
      b.push(...batch);
    },
  };
  const opencode = {
    cwd: f.c,
    ref,
    adapter: "opencode",
    session: "same-native-id",
    async deliver(batch: Notification[]) {
      c.push(...batch);
    },
  };
  await consumeMailbox(codex);
  await consumeMailbox(opencode);
  const event = await sendMessage({
    cwd: f.a,
    adapter: "codex",
    session: "A",
    text: "The interface has changed; check its callers.",
  });
  assert.equal(event.recipients.length, 2);
  await consumeMailbox(codex);
  assert.equal(b[0].event.id, event.id);
  assert.equal(c.length, 0);
  await consumeMailbox(opencode);
  assert.equal(c[0].event.id, event.id);
  await consumeMailbox(codex);
  await consumeMailbox(opencode);
  assert.equal(b.length, 1);
  assert.equal(c.length, 1);
  const repo = await repository(f.a);
  assert.equal((await eventsIn(repo)).length, 1);
  assert.equal((await readdir(join(repo.directory, "receipts"))).length, 2);
  assert.equal((await listSessions(f.a)).length, 2);
  if (process.platform !== "win32") {
    assert.equal((await stat(repo.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(repo.directory, "events", `${event.id}.json`))).mode & 0o777, 0o600);
  }
});

test("a shared main event is published once; one agent's failed delivery does not consume another's message", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  await writeFile(join(f.c, "shared.txt"), "C local\n");
  const deliveries: string[] = [];
  let fail = false;
  const a = {
    cwd: f.a,
    ref,
    adapter: "codex",
    session: "A",
    async deliver() {
      assert.fail("clean source should not be notified");
    },
  };
  const b = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver(batch: Notification[]) {
      if (fail) throw new Error("offline");
      deliveries.push(...batch.map((n) => n.event.id));
    },
  };
  const c = {
    cwd: f.c,
    ref,
    adapter: "opencode",
    session: "C",
    async deliver(batch: Notification[]) {
      deliveries.push(...batch.map((n) => n.event.id));
    },
  };
  await consumeMailbox(a);
  await consumeMailbox(b);
  await consumeMailbox(c);
  await f.commit(f.a, "shared.txt", "upstream A\n");
  git(f.main, "merge", "--no-ff", "feature/a", "-m", "merge A");
  await consumeMailbox(a);
  fail = true;
  await assert.rejects(consumeMailbox(b), /offline/);
  await consumeMailbox(c);
  fail = false;
  await consumeMailbox(b);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0], deliveries[1]);
  assert.equal((await eventsIn(await repository(f.main))).length, 1);
});

test("file-scoped messages only reach overlapping worktrees, and new sessions do not replay older broadcasts", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  await writeFile(join(f.c, "other.txt"), "C local\n");
  let b = 0;
  let c = 0;
  const codex = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver() {
      b++;
    },
  };
  const opencode = {
    cwd: f.c,
    ref,
    adapter: "opencode",
    session: "C",
    async deliver() {
      c++;
    },
  };
  await consumeMailbox(codex);
  await consumeMailbox(opencode);
  await sendMessage({ cwd: f.a, adapter: "codex", session: "A", text: "shared changed", files: ["shared.txt"] });
  await consumeMailbox(codex);
  await consumeMailbox(opencode);
  assert.equal(b, 1);
  assert.equal(c, 0);
  await consumeMailbox({
    ...codex,
    session: "new-conversation",
    async deliver() {
      assert.fail("no historical replay");
    },
  });
});

test("file aliases normalize before deduplication and delivery, including retained events", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const received: Notification[] = [];
  const options = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver(batch: Notification[]) {
      received.push(...batch);
    },
  };
  await consumeMailbox(options);
  const event = await sendMessage({
    cwd: f.a,
    adapter: "cc",
    session: "A",
    text: "aliases",
    files: ["./shared.txt", "shared.txt", ".//./shared.txt"],
  });
  assert.deepEqual(event.files, ["shared.txt"]);
  // Old producers may have persisted aliases before normalization was introduced.
  const repo = await repository(f.a);
  await writeFile(
    join(repo.directory, "events", `${event.id}.json`),
    JSON.stringify({ ...event, files: ["./shared.txt"] }),
  );
  await consumeMailbox(options);
  assert.equal(received[0]?.event.id, event.id);
  await consumeMailbox(options);
  assert.equal(received.length, 1);
  for (const file of [
    ".",
    "./",
    "src/",
    "./../secret",
    "src/../shared.txt",
    "/shared.txt",
    ...(process.platform === "win32" ? ["C:\\shared.txt", "./C:/shared.txt"] : []),
  ]) {
    await assert.rejects(
      sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "invalid", files: [file] }),
      /repository-relative/,
    );
  }
});

test("Unix backslashes in filenames remain literal", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const file = "literal\\name.txt";
  await writeFile(join(f.b, file), "local\n");
  const options = { cwd: f.b, ref, adapter: "codex", session: "B", async deliver() {} };
  await consumeMailbox(options);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "literal", files: [`./${file}`] });
  assert.deepEqual(event.files, [file]);
  assert.equal((await consumeMailbox(options))[0]?.event.id, event.id);
});

test("bounded batches leave remaining messages for the next check", async (t) => {
  const f = await fixture(t);
  const received: string[] = [];
  const options = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver(batch: Notification[]) {
      received.push(...batch.map((n) => n.event.id));
    },
  };
  await consumeMailbox(options);
  for (let i = 0; i < 41; i++) await sendMessage({ cwd: f.a, adapter: "codex", session: "A", text: `message ${i}` });
  const expected = (await eventsIn(await repository(f.b))).map((event) => event.id);
  for (const count of [8, 16, 24, 32, 40, 41]) {
    await consumeMailbox(options);
    assert.equal(received.length, count);
  }
  await consumeMailbox(options);
  assert.deepEqual(received, expected);
});

test("confirmed payloads are skipped in session scans, but publication recovery and GC validate them", async (t) => {
  const f = await fixture(t);
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
  const c = { ...b, cwd: f.c, session: "C" };
  await consumeMailbox(b);
  await consumeMailbox(c);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "pending" });
  await consumeMailbox(b);
  const repo = await repository(f.b);
  const path = join(repo.directory, "events", `${event.id}.json`);
  await writeFile(path, "{}");
  const key = sessionKey(repo, b, ref);
  const receiptPath = join(repo.directory, "receipts", key, `${event.id}.json`);
  const receipt = await readFile(receiptPath, "utf8");
  assert.deepEqual(await withLock(join(repo.directory, "sessions", `${key}.lock`), () => eventsIn(repo, key)), []);
  // A receipt does not establish whether an unreadable payload is a pending
  // upstream event, so synchronization preserves the data and stops.
  await assert.rejects(consumeMailbox(b), /Invalid shared event/);
  assert.equal(await readFile(receiptPath, "utf8"), receipt);
  // A daemon has no subscriber receipt to establish the payload's kind.
  await assert.rejects(
    withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, b)),
    /Invalid shared event/,
  );
  await assert.rejects(consumeMailbox(c), /Invalid shared event/);
  await assert.rejects(eventsIn(repo), /Invalid shared event/);
  await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /Invalid shared event/);
  assert.equal(await readFile(path, "utf8"), "{}");
  await writeFile(path, JSON.stringify(event));
  await consumeMailbox(c);
  assert.equal(delivered, 2);
});

test("receipt filtering validates contents and notices deletion without a process restart", async (t) => {
  const f = await fixture(t);
  let delivered = 0;
  const options = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver() {
      delivered++;
    },
  };
  await consumeMailbox(options);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "pending" });
  await consumeMailbox(options);
  const repo = await repository(f.b);
  const key = sessionKey(repo, options, ref);
  const path = join(repo.directory, "receipts", key, `${event.id}.json`);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  for (const invalid of [
    { ...receipt, eventId: "wrong" },
    { ...receipt, status: "unknown" },
    { ...receipt, at: "invalid" },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(consumeMailbox(options), /Invalid receipt/);
    assert.equal(delivered, 1);
  }
  await rm(path);
  await consumeMailbox(options);
  await consumeMailbox(options);
  assert.equal(delivered, 2);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(eventsIn(repo, key, abort.signal), /abort/i);
  await assert.rejects(eventsIn(repo, "../outside"), /Invalid receipt key/);
});

test("repo identity is shared across worktrees but not across separate clones", async (t) => {
  const f = await fixture(t);
  const a = await repository(f.a);
  const b = await repository(f.b);
  assert.equal(a.id, b.id);
  git(f.root, "clone", f.main, join(f.root, "clone"));
  const clone = await repository(join(f.root, "clone"));
  assert.notEqual(a.id, clone.id);
  await consumeMailbox({ cwd: f.b, ref, adapter: "codex", session: "B", async deliver() {} });
  const message = await sendMessage({
    cwd: clone.root,
    adapter: "codex",
    session: "clone",
    text: "must not cross clones",
  });
  assert.equal(message.recipients.length, 0);
});

test("legacy cursors migrate without being deleted and queued delivery is acknowledged only after acceptance", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f.b);
  const identity = { adapter: "codex", session: "legacy" };
  const key = sessionKey(repo, identity, ref);
  const legacyDirectory = join(repo.common, "worktree-agent-sync");
  await mkdir(legacyDirectory);
  const legacyPath = join(legacyDirectory, `${key}.json`);
  await writeFile(legacyPath, JSON.stringify({ root: f.b, ref, commit: f.initial }));
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await f.commit(f.main, "shared.txt", "upstream\n");
  let received = 0;
  let accepted = false;
  const options = {
    cwd: f.b,
    ref,
    ...identity,
    async deliver() {
      received++;
      return accepted;
    },
  };
  await consumeMailbox(options);
  await consumeMailbox(options);
  assert.equal(received, 2);
  accepted = true;
  await consumeMailbox(options);
  await consumeMailbox(options);
  assert.equal(received, 3);
  assert.equal(JSON.parse(await readFile(legacyPath, "utf8")).commit, f.initial);
  assert.equal((await eventsIn(repo)).length, 1);
});

test("rewind followed by the same forward update creates a new event rather than reusing an old receipt", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const received: string[] = [];
  const options = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver(batch: Notification[]) {
      received.push(...batch.map((n) => n.event.id));
    },
  };
  await consumeMailbox(options);
  const next = await f.commit(f.main, "shared.txt", "upstream\n");
  await consumeMailbox(options);
  git(f.main, "update-ref", ref, f.initial);
  await consumeMailbox(options);
  git(f.main, "update-ref", ref, next);
  await consumeMailbox(options);
  assert.equal(received.length, 3);
  assert.equal(new Set(received).size, 3);
});

test("message validation and cancellation do not advance receipts", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "bad", files: ["../secret"] }),
    /repository-relative/,
  );
  await assert.rejects(sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "x".repeat(65 * 1024) }), /64 KiB/);
  const options = { cwd: f.b, ref, adapter: "codex", session: "B", async deliver() {} };
  await consumeMailbox(options);
  await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "pending" });
  const abort = new AbortController();
  await assert.rejects(
    consumeMailbox({
      ...options,
      signal: abort.signal,
      async deliver() {
        abort.abort();
      },
    }),
    /abort/i,
  );
  let count = 0;
  await consumeMailbox({
    ...options,
    async deliver() {
      count++;
    },
  });
  assert.equal(count, 1);
});

test("cancellation while awaiting delivery confirmation preserves the event and releases locks", async (t) => {
  const f = await fixture(t);
  const recipient = { cwd: f.b, ref, adapter: "test", session: "recipient", async deliver() {} };
  await consumeMailbox(recipient);
  const repo = await repository(f.b),
    key = sessionKey(repo, recipient, ref);
  for (const result of [true, false]) {
    const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: `confirmation ${result}` });
    const abort = new AbortController();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const pending = consumeMailbox({
      ...recipient,
      signal: abort.signal,
      async isDelivered() {
        entered.resolve();
        await release.promise;
        return result;
      },
      async deliver() {
        assert.fail("cancelled confirmation must not deliver");
      },
    });
    await entered.promise;
    abort.abort();
    release.resolve();
    await assert.rejects(pending, /abort/i);
    await assert.rejects(stat(join(repo.directory, "receipts", key, `${event.id}.json`)), { code: "ENOENT" });
    await assert.rejects(stat(join(repo.directory, "sessions", `${key}.lock`)), { code: "ENOENT" });
    await assert.rejects(stat(join(repo.directory, "publish.lock")), { code: "ENOENT" });
    let count = 0;
    await consumeMailbox({
      ...recipient,
      async deliver() {
        count++;
      },
    });
    assert.equal(count, 1);
  }
});

test("cancellation while awaiting pending delivery inspection preserves the event and releases locks", async (t) => {
  const f = await fixture(t);
  const recipient = { cwd: f.b, ref, adapter: "test", session: "recipient", async deliver() {} };
  await consumeMailbox(recipient);
  const repo = await repository(f.b),
    key = sessionKey(repo, recipient, ref);
  for (const result of [true, false]) {
    const event = await sendMessage({
      cwd: f.a,
      adapter: "test",
      session: "sender",
      text: `pending inspection ${result}`,
    });
    const abort = new AbortController();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const pending = consumeMailbox({
      ...recipient,
      signal: abort.signal,
      async isPending() {
        entered.resolve();
        await release.promise;
        return result;
      },
      async deliver() {
        assert.fail("cancelled inspection must not deliver");
      },
    });
    await entered.promise;
    abort.abort();
    release.resolve();
    await assert.rejects(pending, /abort/i);
    await assert.rejects(stat(join(repo.directory, "receipts", key, `${event.id}.json`)), { code: "ENOENT" });
    await assert.rejects(stat(join(repo.directory, "sessions", `${key}.lock`)), { code: "ENOENT" });
    await assert.rejects(stat(join(repo.directory, "publish.lock")), { code: "ENOENT" });
    let count = 0;
    await consumeMailbox({
      ...recipient,
      async deliver() {
        count++;
      },
    });
    assert.equal(count, 1);
  }
});

test("cancellation during receipt preparation does not commit any receipt", async (t) => {
  const f = await fixture(t);
  const recipient = { cwd: f.b, ref, adapter: "test", session: "recipient", async deliver() {} };
  await consumeMailbox(recipient);
  const repo = await repository(f.b),
    key = sessionKey(repo, recipient, ref),
    directory = join(repo.directory, "receipts", key);
  for (const mode of ["known", "irrelevant", "accepted"] as const) {
    const event = await sendMessage({
      cwd: f.a,
      adapter: "test",
      session: "sender",
      text: mode,
      files: mode === "irrelevant" ? ["shared.txt"] : [],
    });
    const receipt = join(directory, `${event.id}.json`),
      abort = new AbortController();
    const originalOpen = fs.promises.open;
    let cancelled = false,
      delivered = 0;
    fs.promises.open = (async (path: any, ...args: any[]) => {
      const handle = await (originalOpen as any)(path, ...args);
      if (String(path).startsWith(`${receipt}.`)) {
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs: any[]) => {
          const result = await originalWrite(...writeArgs);
          if (!cancelled) {
            cancelled = true;
            abort.abort();
          }
          return result;
        };
      }
      return handle;
    }) as typeof fs.promises.open;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        consumeMailbox({
          ...recipient,
          signal: abort.signal,
          isDelivered: mode === "known" ? async () => true : undefined,
          async deliver() {
            delivered++;
          },
        }),
        /abort/i,
      );
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(cancelled, true, mode);
    assert.equal(delivered, mode === "accepted" ? 1 : 0, mode);
    await assert.rejects(stat(receipt), { code: "ENOENT" });
    assert.ok(
      !(await readdir(directory)).some((name) => name.startsWith(`${event.id}.json.`) && name.endsWith(".tmp")),
    );
    await assert.rejects(stat(join(repo.directory, "sessions", `${key}.lock`)), { code: "ENOENT" });
    await consumeMailbox(recipient);
    assert.equal(
      (await readFile(receipt, "utf8")).includes(`"status":"${mode === "irrelevant" ? "irrelevant" : "delivered"}"`),
      true,
    );
  }
});
