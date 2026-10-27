import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { daemonStatus } from "../../src/core/daemon-state.ts";
import { runDaemon } from "../../src/core/daemon.ts";
import { eventsIn, registerSession, sendMessage } from "../../src/core/mailbox.ts";
import {
  GC_LOCK_TOKEN,
  hash,
  readJson,
  repository,
  stateDirectory,
  withLock,
  writeJson,
} from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("daemon condition timed out");
    await delay(20);
  }
}

test("clients check refs with fresh and stale daemon observations", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  let count = 0;
  const receiver = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "codex",
    session: "B",
    async deliver() {
      count++;
    },
  };
  await consumeMailbox(receiver);
  await f.commit(f.main, "shared.txt", "upstream\n");
  const root = stateDirectory();
  const token = hash("daemon-test");
  const state = { pid: process.pid, token, intervalMs: 5000, heartbeatAt: new Date().toISOString() };
  await writeJson(join(root, "daemon.lock"), { pid: process.pid, token });
  await writeJson(join(root, "daemon.json"), state);
  const repo = await repository(f.b);
  const refPath = join(repo.directory, "refs", `${hash(receiver.ref)}.json`);
  const cached = (await readJson(refPath)) as object;
  await writeJson(refPath, { ...cached, daemonToken: token });
  assert.equal((await daemonStatus()).running, true);
  await consumeMailbox(receiver);
  assert.equal(count, 1); // A fresh daemon observation does not suppress a client check.
  await writeJson(refPath, { ...cached, daemonToken: token, checkedAt: "2000-01-01T00:00:00.000Z" });
  await consumeMailbox(receiver);
  assert.equal(count, 1); // Rechecking the older cursor does not redeliver its event.
  await f.commit(f.main, "shared.txt", "upstream again\n");
  await writeJson(join(root, "daemon.json"), { ...state, heartbeatAt: "2000-01-01T00:00:00.000Z" });
  assert.equal((await daemonStatus()).running, false);
  await consumeMailbox(receiver);
  assert.equal(count, 2);
  await writeJson(join(root, "daemon.json"), { ...state, token: hash("other-owner") });
  assert.equal((await daemonStatus()).running, false);
  await rm(join(root, "daemon.lock"));
  await rm(join(root, "daemon.json"));
});

test("one daemon discovers multiple repositories and isolates a failing subscription", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  }); // Stop before the fixture removes its store.
  const f = await fixture(t);
  const clone = join(f.root, "clone");
  git(f.root, "clone", f.main, clone);
  await consumeMailbox({ cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "B", async deliver() {} });
  await consumeMailbox({ cwd: clone, ref: "refs/heads/main", adapter: "codex", session: "clone", async deliver() {} });
  // A legacy/corrupt subscription must remain isolated; send no longer creates subscriptions.
  await registerSession(await repository(f.a), { adapter: "cc", session: "bad-ref" }, "refs/heads/missing");
  const a = await repository(f.b);
  const b = await repository(clone);
  const errors: string[] = [];
  const ready = Promise.withResolvers<void>();
  running = runDaemon({
    signal: abort.signal,
    intervalMs: 50,
    onEvent(event: any) {
      if (event.type === "daemon.ready") ready.resolve();
      if (event.type === "daemon.error") errors.push(`${event.ref ?? ""}: ${event.message}`);
    },
  });
  running.catch(ready.reject);
  await ready.promise;
  await f.commit(f.main, "shared.txt", "main updated\n");
  await f.commit(clone, "shared.txt", "clone updated\n");
  await waitFor(
    async () =>
      (await eventsIn(a)).some((e) => e.kind === "upstream") &&
      (await eventsIn(b)).some((e) => e.kind === "upstream") &&
      errors.length > 0,
  );
  assert.ok(errors.some((message) => message.includes("missing")));
  abort.abort();
  await running;
  assert.equal((await daemonStatus()).running, false);
});

test("daemon preserves state when the repository ownership marker is missing", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  });
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const refPath = join(repo.directory, "refs", `${hash(receiver.ref)}.json`);
  const initialRef = await readJson(refPath);
  await rm(join(repo.directory, "identity-owner.json"));
  await f.commit(f.main, "shared.txt", "upstream\n");
  const errors: string[] = [];
  running = runDaemon({
    signal: abort.signal,
    intervalMs: 50,
    onEvent(event: any) {
      if (event.type === "daemon.error") errors.push(event.message);
    },
  });
  await waitFor(async () => errors.some((message) => message.includes("Incomplete GitRelay state initialization")));
  abort.abort();
  await running;
  assert.deepEqual(await eventsIn(repo), []);
  assert.deepEqual(await readJson(refPath), initialRef);
});

test("daemon cleans newly confirmed events again at the hourly maintenance interval", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  });
  const f = await fixture(t);
  let confirmed = false;
  const receiver = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "codex",
    session: "B",
    async deliver() {
      confirmed = true;
    },
  };
  await consumeMailbox(receiver);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "initially unread" });
  const repo = await repository(f.b);
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const reports: any[] = [];
  running = runDaemon({
    signal: abort.signal,
    intervalMs: 50,
    retentionDays: 0,
    onEvent(event: any) {
      if (event.type === "daemon.cleanup") reports.push(event);
    },
  });
  await waitFor(async () => reports.length >= 1);
  assert.equal(reports[0].removed, 0);
  await waitFor(async () => {
    await consumeMailbox(receiver);
    return confirmed;
  });
  clock += 60 * 60 * 1000 + 1;
  await waitFor(async () => reports.some((report) => report.removed === 1));
  assert.equal(
    (await eventsIn(repo)).some((item) => item.id === event.id),
    false,
  );
  abort.abort();
  await running;
});

test("daemon maintenance uses elapsed time despite a wall clock rollback", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  });
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  let elapsed = performance.now();
  t.mock.method(performance, "now", () => elapsed);
  const reports: any[] = [];
  running = runDaemon({
    signal: abort.signal,
    intervalMs: 50,
    retentionDays: 0,
    onEvent(event: any) {
      if (event.type === "daemon.cleanup") reports.push(event);
    },
  });
  await waitFor(async () => reports.length === 1);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "A", text: "retained across clock rollback" });
  await consumeMailbox(receiver);
  const wall = Date.now() - 24 * 60 * 60 * 1000;
  t.mock.method(Date, "now", () => wall);
  elapsed += 60 * 60 * 1000 + 1;
  await Promise.race([
    waitFor(async () => reports.length >= 2),
    delay(5000, undefined, { ref: false }).then(() => {
      throw new Error("maintenance did not run after elapsed hour");
    }),
  ]);
  assert.equal(reports[1].removed, 0); // The future receipt is still protected by retention.
  assert.ok((await eventsIn(await repository(f.b))).some((item) => item.id === event.id));
  abort.abort();
  await running;
});

test("daemon retries a busy repository without delaying another or a new repository", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  });
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "A", text: "confirmed before daemon startup" });
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const clone = join(f.root, "clone");
  git(f.root, "clone", f.main, clone);
  await consumeMailbox({ cwd: clone, ref: "refs/heads/main", adapter: "test", session: "clone", async deliver() {} });
  const other = await repository(clone);
  let elapsed = performance.now();
  t.mock.method(performance, "now", () => elapsed);
  const reports: any[] = [];
  let busyObserved = false;
  const open = fs.promises.open;
  const mocked = t.mock.method(fs.promises, "open", (async (...args: Parameters<typeof open>) => {
    try {
      return await open(...args);
    } catch (error) {
      if (
        args[0] === join(repo.directory, "publish.lock") &&
        args[1] === "wx" &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      )
        busyObserved = true;
      throw error;
    }
  }) as typeof open);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await withLock(join(repo.directory, "publish.lock"), async () => {
    running = runDaemon({
      signal: abort.signal,
      intervalMs: 50,
      retentionDays: 0,
      onEvent(value: any) {
        if (value.type === "daemon.cleanup") reports.push(value);
      },
    });
    await waitFor(async () => busyObserved && reports.some((report) => report.repo === other.id));
    assert.ok(!reports.some((report) => report.repo === repo.id));
  });
  await delay(150);
  assert.ok(!reports.some((report) => report.repo === repo.id));
  assert.ok((await eventsIn(repo)).some((item) => item.id === event.id));
  elapsed += 5001;
  await waitFor(async () => reports.some((report) => report.repo === repo.id && report.removed === 1));
  const later = join(f.root, "later");
  git(f.root, "clone", f.main, later);
  await consumeMailbox({ cwd: later, ref: "refs/heads/main", adapter: "test", session: "later", async deliver() {} });
  const added = await repository(later);
  await waitFor(async () => reports.some((report) => report.repo === added.id));
  abort.abort();
  await running;
});

test("daemon retries cleanup when a recipient was busy", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  });
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "A", text: "confirmed while recipient busy" });
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  let elapsed = performance.now();
  t.mock.method(performance, "now", () => elapsed);
  const reports: any[] = [];
  await withLock(join(repo.directory, "sessions", `${event.recipients[0]}.lock`), async () => {
    running = runDaemon({
      signal: abort.signal,
      intervalMs: 50,
      retentionDays: 0,
      onEvent(value: any) {
        if (value.type === "daemon.cleanup") reports.push(value);
      },
    });
    await waitFor(async () => reports.length >= 1);
    assert.equal(reports[0].removed, 0);
    assert.equal(reports[0].kept, 1);
  });
  elapsed += 5001;
  await waitFor(async () => reports.some((report) => report.removed === 1));
  assert.ok(!(await eventsIn(repo)).some((item) => item.id === event.id));
  abort.abort();
  await running;
});

test("a long busy cleanup leaves time for other operations before retrying", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  });
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const confirmed = await sendMessage({ cwd: f.a, adapter: "test", session: "A", text: "confirmed" });
  await consumeMailbox(receiver);
  const unread = await sendMessage({ cwd: f.a, adapter: "test", session: "A", text: "unread" });
  const repo = await repository(f.b);
  let elapsed = performance.now();
  t.mock.method(performance, "now", () => elapsed);
  const readdir = fs.promises.readdir;
  let delayed = false;
  const mocked = t.mock.method(fs.promises, "readdir", (async (...args: Parameters<typeof readdir>) => {
    if (!delayed && args[0] === join(repo.directory, "trash")) {
      const lock = (await readJson(join(repo.directory, "publish.lock"))) as { token?: string } | undefined;
      if (lock?.token === GC_LOCK_TOKEN) {
        delayed = true;
        elapsed += 6000;
      }
    }
    return readdir(...args);
  }) as typeof readdir);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const reports: any[] = [];
  await withLock(join(repo.directory, "sessions", `${confirmed.recipients[0]}.lock`), async () => {
    running = runDaemon({
      signal: abort.signal,
      intervalMs: 50,
      retentionDays: 0,
      onEvent(value: any) {
        if (value.type === "daemon.cleanup") reports.push(value);
      },
    });
    await waitFor(async () => reports.length > 0);
    assert.equal(reports[0].removed, 0);
  });
  elapsed += 5001;
  await delay(200);
  assert.equal(reports.length, 1);
  await withLock(join(repo.directory, "publish.lock"), async () => {}, {
    waitMs: 5000,
    signal: AbortSignal.timeout(5000),
  });
  elapsed += 1000;
  await waitFor(async () => reports.some((report) => report.removed === 1));
  const events = await eventsIn(repo);
  assert.ok(events.some((event) => event.id === unread.id));
  assert.ok(!events.some((event) => event.id === confirmed.id));
});

test("a repository without metadata does not consume its first maintenance attempt", async (t) => {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    await running;
  });
  const f = await fixture(t),
    repo = await repository(f.b),
    missed = Promise.withResolvers<void>();
  const original = fs.promises.lstat;
  const mocked = t.mock.method(fs.promises, "lstat", (async (...args: Parameters<typeof original>) => {
    try {
      return await original(...args);
    } catch (error) {
      if (args[0] === join(repo.directory, "repo.json") && (error as NodeJS.ErrnoException).code === "ENOENT")
        missed.resolve();
      throw error;
    }
  }) as typeof original);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  t.mock.method(performance, "now", () => 100);
  const reports: any[] = [];
  running = runDaemon({
    signal: abort.signal,
    intervalMs: 50,
    onEvent(value: any) {
      if (value.type === "daemon.cleanup") reports.push(value);
    },
  });
  await Promise.race([
    missed.promise,
    delay(5000).then(() => {
      throw new Error("daemon did not inspect the pending repository");
    }),
  ]);
  await consumeMailbox({ cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "late", async deliver() {} });
  await waitFor(async () => reports.some((report) => report.repo === repo.id));
});

test("blocked daemon output releases publish.lock and remains abortable", async (t) => {
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let running: Promise<void> | undefined;
  t.after(async () => {
    abort.abort();
    release.resolve();
    await running;
  });
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  await registerSession(await repository(f.a), { adapter: "cc", session: "bad" }, "refs/heads/missing");
  const repo = await repository(f.b);
  running = runDaemon({
    signal: abort.signal,
    intervalMs: 50,
    onEvent(event: any) {
      if (event.type === "daemon.error") {
        entered.resolve();
        return release.promise;
      }
    },
  });
  running.catch(entered.reject);
  await entered.promise;
  assert.equal(await readJson(join(repo.directory, "publish.lock")), undefined);
  const event = await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "not blocked" });
  assert.ok((await consumeMailbox(receiver)).some((notification) => notification.event.id === event.id));
  abort.abort();
  await Promise.race([
    running,
    delay(2000).then(() => {
      throw new Error("blocked output prevented daemon shutdown");
    }),
  ]);
  assert.equal(await readJson(join(stateDirectory(), "daemon.lock")), undefined);
  assert.equal(await readJson(join(stateDirectory(), "daemon.json")), undefined);
  assert.equal(await readJson(join(repo.directory, "publish.lock")), undefined);
});

test("daemon validates limits and supports cancellation before acquiring its lock", async () => {
  await assert.rejects(runDaemon({ signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(runDaemon({ signal: new AbortController().signal, intervalMs: 0 }), /interval-ms/);
  await assert.rejects(runDaemon({ signal: new AbortController().signal, retentionDays: NaN }), /retention-days/);
});
