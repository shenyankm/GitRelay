import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { eventsIn, readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { BusyError, GC_LOCK_TOKEN, repository, withLock } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

test("callback BusyError is propagated without acknowledging the event", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, adapter: "test", session: "b", ref: "refs/heads/main", async deliver() {} };
  await consumeMailbox(receiver);
  await sendMessage({ cwd: f.a, adapter: "test", session: "a", text: "pending" });
  for (const point of ["isDelivered", "isPending", "deliver", "beforeReceipt"] as const) {
    const fail = () => {
      throw new BusyError(`callback ${point}`);
    };
    const options = { ...receiver, ...(point === "beforeReceipt" ? { isDelivered: () => true } : {}), [point]: fail };
    await assert.rejects(consumeMailbox(options), new RegExp(`callback ${point}`));
  }
  assert.equal((await consumeMailbox(receiver)).length, 1);
});

test("session and GC publication lock contention still skip the polling round", async (t) => {
  const f = await fixture(t);
  const receiver = {
    cwd: f.b,
    adapter: "test",
    session: "b",
    ref: "refs/heads/main",
    async deliver() {
      assert.fail();
    },
  };
  await consumeMailbox(receiver);
  await sendMessage({ cwd: f.a, adapter: "test", session: "a", text: "pending" });
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, receiver.ref);
  await withLock(join(repo.directory, "sessions", `${key}.lock`), async () =>
    assert.deepEqual(await consumeMailbox(receiver), []),
  );
  await withLock(
    join(repo.directory, "publish.lock"),
    async () => assert.deepEqual(await consumeMailbox(receiver), []),
    { token: GC_LOCK_TOKEN },
  );
});

test("ownerless session locks are reported without acknowledging unread messages", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, adapter: "test", session: "b", ref: "refs/heads/main", async deliver() {} };
  await consumeMailbox(receiver);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "a", text: "pending" });
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, receiver.ref),
    lock = join(repo.directory, "sessions", `${key}.lock`);
  for (const contents of ["", "{", JSON.stringify({ pid: 0 })]) {
    await fs.promises.writeFile(lock, contents);
    await assert.rejects(consumeMailbox(receiver), (error: Error) => error.message.includes(lock));
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        "--experimental-strip-types",
        fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
        "check",
        "--cwd",
        f.b,
        "--agent",
        "test",
        "--session",
        "b",
      ]),
      (error: Error & { stderr?: string }) => error.stderr?.includes(lock) === true,
    );
    assert.equal(await fs.promises.readFile(lock, "utf8"), contents);
    assert.equal(await readReceipt(repo, key, event.id), undefined);
    if (contents === "") {
      await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), (error: Error) =>
        error.message.includes(lock),
      );
      assert.ok((await eventsIn(repo)).some((item) => item.id === event.id));
      await assert.rejects(fs.promises.stat(join(repo.directory, "publish.lock")), { code: "ENOENT" });
    }
    await fs.promises.rm(lock);
  }
  assert.equal((await consumeMailbox(receiver)).length, 1);
});

test("BusyError inside an acquired publication lock is propagated", async (t) => {
  const f = await fixture(t);
  const receiver = {
    cwd: f.b,
    adapter: "test",
    session: "b",
    ref: "refs/heads/main",
    async deliver() {
      assert.fail();
    },
  };
  await consumeMailbox(receiver);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, receiver.ref);
  const target = join(repo.directory, "sessions", `${key}.json`),
    original = fs.promises.rename;
  const mocked = t.mock.method(
    fs.promises,
    "rename",
    async (source: Parameters<typeof original>[0], destination: Parameters<typeof original>[1]) => {
      if (destination === target) throw new BusyError("session write");
      return original(source, destination);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(consumeMailbox(receiver), /session write/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("BusyError while writing an acquired lock is propagated", async (t) => {
  const f = await fixture(t);
  const receiver = {
    cwd: f.b,
    adapter: "test",
    session: "b",
    ref: "refs/heads/main",
    async deliver() {
      assert.fail();
    },
  };
  await consumeMailbox(receiver);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, receiver.ref);
  for (const target of [join(repo.directory, "sessions", `${key}.lock`), join(repo.directory, "publish.lock")]) {
    const original = fs.promises.open;
    const mocked = t.mock.method(
      fs.promises,
      "open",
      async (
        path: Parameters<typeof original>[0],
        flags: Parameters<typeof original>[1],
        mode?: Parameters<typeof original>[2],
      ) => {
        const file = await original(path, flags, mode);
        if (path === target)
          file.writeFile = async () => {
            throw new BusyError("lock write failure");
          };
        return file;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(consumeMailbox(receiver), /lock write failure/);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("session lock release error is propagated after GC contention", async (t) => {
  const f = await fixture(t);
  const receiver = {
    cwd: f.b,
    adapter: "test",
    session: "b",
    ref: "refs/heads/main",
    async deliver() {
      assert.fail();
    },
  };
  await consumeMailbox(receiver);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, receiver.ref);
  const target = join(repo.directory, "sessions", `${key}.lock`),
    original = fs.promises.rm;
  const mocked = t.mock.method(
    fs.promises,
    "rm",
    async (path: Parameters<typeof original>[0], options?: Parameters<typeof original>[1]) => {
      if (path === target) throw new BusyError("injected session unlock failure");
      return original(path, options);
    },
  );
  syncBuiltinESMExports();
  try {
    await withLock(
      join(repo.directory, "publish.lock"),
      async () => {
        await assert.rejects(consumeMailbox(receiver), /injected session unlock failure/);
      },
      { token: GC_LOCK_TOKEN },
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  const owner = JSON.parse(await fs.promises.readFile(target, "utf8")) as { pid?: number };
  assert.equal(owner.pid, process.pid);
  await fs.promises.rm(target);
});
