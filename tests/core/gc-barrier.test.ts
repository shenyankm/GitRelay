import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import {
  eventsIn,
  readReceipt,
  readSession,
  registerSession,
  sendMessage,
  sessionKey,
} from "../../src/core/mailbox.ts";
import { joinSession, leaveSession } from "../../src/core/sessions.ts";
import { repository, withLock, writeJson } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";
const exec = promisify(execFile);
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test state");
    await delay(5);
  }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(5000, undefined, { signal: abort.signal }).then(() => {
        throw new Error("Timed out waiting for test state");
      }),
    ]);
  } finally {
    abort.abort();
  }
}

/** Hold GC after its recipient barrier, while it reads a known receipt. */
async function pauseReceipt(path: string, eventId: string) {
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let trapped = false;
  prototype.read = async function (...args: unknown[]) {
    const result = await original.apply(this, args);
    if (!trapped && result.bytesRead) {
      const buffer = args[0] as Buffer;
      const offset = args[1] as number;
      const text = buffer.subarray(offset, offset + result.bytesRead).toString();
      if (text.includes(eventId) && text.includes('"status":"delivered"')) {
        trapped = true;
        entered.resolve();
        await release.promise;
      }
    }
    return result;
  };
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => {
      release.resolve();
      prototype.read = original;
    },
  };
}

test("GC keeps events while a receiver is still delivering after publication", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "busy", async deliver() {} };
  await consumeMailbox(receiver);
  const confirmed = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "confirmed" });
  await consumeMailbox(receiver);
  const pending = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "pending" });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const consumer = consumeMailbox({
    ...receiver,
    async deliver() {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    await bounded(entered.promise);
    const report = await collectGarbage(f.a, { apply: true, retentionDays: 0 });
    assert.ok(report.kept.some((item) => item.id === confirmed.id && item.reason === "busy"));
    assert.ok(report.kept.some((item) => item.id === pending.id && item.reason === "busy"));
    release.resolve();
    await consumer;
    assert.deepEqual(
      new Set((await collectGarbage(f.a, { apply: true, retentionDays: 0 })).removed),
      new Set([confirmed.id, pending.id]),
    );
  } finally {
    release.resolve();
    await consumer;
  }
});

test("GC drains recipient locks and reports failures even when another recipient is busy", async (t) => {
  const f = await fixture(t);
  const receivers = ["a", "b", "c"].map((session) => ({
    cwd: f.b,
    ref,
    adapter: "test",
    session,
    async deliver() {},
  }));
  for (const receiver of receivers) await consumeMailbox(receiver);
  const event = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "confirmed" });
  for (const receiver of receivers) await consumeMailbox(receiver);
  const repo = await repository(f.a);
  const locks = [...event.recipients].sort().map((key) => join(repo.directory, "sessions", `${key}.lock`));
  await writeJson(locks[0], { pid: process.pid });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = fs.promises.rm;
  const mocked = t.mock.method(
    fs.promises,
    "rm",
    async (path: Parameters<typeof original>[0], options?: Parameters<typeof original>[1]) => {
      if (path === locks[2]) throw new Error("injected recipient unlock failure");
      if (path === locks[1]) {
        entered.resolve();
        await release.promise;
      }
      return original(path, options);
    },
  );
  syncBuiltinESMExports();
  let finished = false;
  const rejected = assert.rejects(
    collectGarbage(f.a, { apply: true, retentionDays: 0 }).finally(() => {
      finished = true;
    }),
    /injected recipient unlock failure/,
  );
  try {
    await bounded(entered.promise);
    await delay(25);
    assert.equal(finished, false);
    await stat(join(repo.directory, "publish.lock"));
    release.resolve();
    await rejected;
    for (const path of [join(repo.directory, "publish.lock"), locks[1]])
      await assert.rejects(stat(path), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(locks[0], "utf8")).pid, process.pid);
    assert.ok(await readFile(join(repo.directory, "events", `${event.id}.json`)));
    for (const key of event.recipients) assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
  } finally {
    release.resolve();
    await rejected;
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(locks[0], { force: true });
    await rm(locks[2], { force: true });
  }
});

test(
  "GC drains a large confirmed audience under a low file descriptor limit",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const repo = await repository(f.b);
    await withLock(join(repo.directory, "publish.lock"), async () => {
      for (let index = 0; index < 90; index++) {
        const session = await registerSession(repo, { adapter: "test", session: `receiver-${index}` }, ref, f.initial);
        await writeJson(join(repo.directory, "sessions", `${session.key}.json`), { ...session, migrated: true });
      }
    });
    const confirmed = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "confirmed" });
    const unread = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "unread" });
    assert.equal(confirmed.recipients.length, 90);
    for (const key of confirmed.recipients) {
      await mkdir(join(repo.directory, "receipts", key), { recursive: true });
      await writeJson(join(repo.directory, "receipts", key, `${confirmed.id}.json`), {
        eventId: confirmed.id,
        status: "delivered",
        at: new Date(0).toISOString(),
      });
    }
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const { stdout } = await exec(
      "sh",
      [
        "-c",
        'ulimit -n 64; exec "$@"',
        "sh",
        process.execPath,
        "--experimental-strip-types",
        cli,
        "gc",
        "--cwd",
        f.a,
        "--apply",
        "--retention-days",
        "0",
      ],
      { env: process.env, timeout: 15000 },
    );
    const report = JSON.parse(stdout);
    assert.deepEqual(report.removed, [confirmed.id]);
    assert.ok(
      report.kept.some(
        (item: { id: string; reason: string }) => item.id === unread.id && item.reason === "unconfirmed",
      ),
    );
    assert.deepEqual(
      (await eventsIn(repo)).map((event) => event.id),
      [unread.id],
    );
  },
);

test("GC publication barrier skips arriving consumers and blocks publishers", async (t) => {
  const f = await fixture(t);
  const deliveries: string[] = [];
  const receiver = (cwd: string, session: string) => ({
    cwd,
    ref,
    adapter: "test",
    session,
    async deliver(batch: { event: { id: string } }[]) {
      deliveries.push(...batch.map((item) => item.event.id));
    },
  });
  const a = receiver(f.b, "a"),
    b = receiver(f.c, "b"),
    direct = receiver(f.b, "direct");
  for (const item of [a, b, direct]) await consumeMailbox(item);
  const event = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "confirmed" });
  for (const item of [a, b, direct]) await consumeMailbox(item);
  await leaveSession(b);
  const repo = await repository(f.a);
  const keyA = sessionKey(await repository(f.b), a, ref),
    keyB = sessionKey(await repository(f.c), b, ref),
    keyDirect = sessionKey(await repository(f.b), direct, ref);
  const pause = await pauseReceipt(join(repo.directory, "receipts", keyB, `${event.id}.json`), event.id);
  try {
    const gc = collectGarbage(f.a, { apply: true, retentionDays: 0 });
    await bounded(pause.entered);
    assert.deepEqual(await bounded(consumeMailbox(a)), []);
    await assert.rejects(joinSession(b), { name: "Error", message: /busy/i });
    assert.deepEqual(
      await withLock(join(repo.directory, "sessions", `${keyDirect}.lock`), () => eventsIn(repo, keyDirect)),
      [],
    );
    await assert.rejects(leaveSession(direct), { name: "Error", message: /busy/i });
    let sent = false;
    const publisher = sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "after barrier" }).then(
      (result) => {
        sent = true;
        return result;
      },
    );
    await delay(50);
    assert.equal(sent, false);
    pause.release();
    assert.deepEqual((await gc).removed, [event.id]);
    await joinSession(b);
    await leaveSession(direct);
    const next = await publisher;
    assert.ok(next.recipients.includes(keyA));
    assert.ok((await readSession(repo, keyDirect))?.closedAt);
    assert.equal(await readReceipt(repo, keyA, event.id), undefined);
    await consumeMailbox(a);
    assert.equal(deliveries.filter((id) => id === event.id).length, 3);
    assert.equal(deliveries.filter((id) => id === next.id).length, 1);
  } finally {
    pause.restore();
  }
});

test("GC cancellation after the recipient barrier preserves events and receipts", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "cancel", async deliver() {} };
  await consumeMailbox(receiver);
  const event = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "confirmed" });
  await consumeMailbox(receiver);
  const repo = await repository(f.a),
    key = sessionKey(await repository(f.b), receiver, ref);
  const pause = await pauseReceipt(join(repo.directory, "receipts", key, `${event.id}.json`), event.id);
  try {
    const controller = new AbortController();
    const cancelled = assert.rejects(
      collectGarbage(f.a, { apply: true, retentionDays: 0, signal: controller.signal }),
      { name: "AbortError" },
    );
    await bounded(pause.entered);
    controller.abort();
    pause.release();
    await cancelled;
    assert.deepEqual(
      (await eventsIn(repo)).map((item) => item.id),
      [event.id],
    );
    assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
    await assert.rejects(stat(join(repo.directory, "publish.lock")), { code: "ENOENT" });
    assert.deepEqual((await collectGarbage(f.a, { apply: true, retentionDays: 0 })).removed, [event.id]);
  } finally {
    pause.restore();
  }
});

test(
  "GC recovers a committed deletion after a forced process exit",
  { skip: process.platform === "win32", timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref, adapter: "test", session: "kill", async deliver() {} };
    await consumeMailbox(receiver);
    const confirmed = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "confirmed" });
    await consumeMailbox(receiver);
    const unread = await sendMessage({ cwd: f.a, adapter: "sender", session: "sender", text: "unread" });
    const repo = await repository(f.a),
      marker = join(f.root, "gc-delete-in-progress");
    const cleanup = pathToFileURL(fileURLToPath(new URL("../../src/core/cleanup.ts", import.meta.url))).href;
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.promises.rm; fs.promises.rm=async function(p,o){if(String(p).includes('/receipts/')&&String(p).endsWith(${JSON.stringify(confirmed.id + ".json")})){fs.writeFileSync(${JSON.stringify(marker)},'ready');await new Promise(()=>setInterval(()=>{},1000));}return original.call(this,p,o)}; syncBuiltinESMExports();const {collectGarbage}=await import(${JSON.stringify(cleanup)});await collectGarbage(${JSON.stringify(f.a)},{apply:true,retentionDays:0});`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      await until(async () => Boolean(await stat(marker).catch(() => undefined)) || child.exitCode !== null);
      assert.equal(await readFile(marker, "utf8").catch(() => stderr), "ready");
      await stat(join(repo.directory, "trash", `${confirmed.id}.json`));
      child.kill("SIGKILL");
      assert.equal((await closed).signal, "SIGKILL");
      await stat(join(repo.directory, "events", `${unread.id}.json`));
      await stat(join(repo.directory, "receipts", confirmed.recipients[0], `${confirmed.id}.json`));
      // The isolated child is confirmed dead, so only its abandoned publication lock is removed.
      await rm(join(repo.directory, "publish.lock"));
      const report = await collectGarbage(f.a, { apply: true, retentionDays: 0 });
      assert.ok(report.removed.includes(confirmed.id));
      assert.ok(report.kept.some((item) => item.id === unread.id && item.reason === "unconfirmed"));
      assert.deepEqual(
        (await eventsIn(repo)).map((event) => event.id),
        [unread.id],
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
  },
);
