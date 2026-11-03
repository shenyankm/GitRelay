import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { synchronizeRef } from "../../src/core/publisher.ts";
import { publishUpstream } from "../../src/core/mailbox.ts";
import { hash, withLock } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

test("a failed ref lookup waits for an in-flight scan before releasing its lock", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const identity = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(identity);
  const repo = await repository(f.b);
  const lock = join(repo.directory, "publish.lock");
  const event = join(repo.directory, "events", `${hash("bad-event")}.json`);
  await writeFile(event, "broken JSON");

  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = fs.promises.open;
  const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
    if (args[0] === event) {
      entered();
      await gate;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    let settled = false;
    const pending = withLock(lock, () => synchronizeRef(repo, "bad-ref", identity));
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(
      withLock(lock, async () => {}),
      /busy/i,
    );
    release();
    // The earlier ref error wins even though the scanned event is corrupt.
    await assert.rejects(pending, /full branch ref/);
  } finally {
    release();
    patch.mock.restore();
    syncBuiltinESMExports();
  }
});

test("cancellation waits for an in-flight scan without advancing the ref", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const identity = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(identity);
  const repo = await repository(f.b);
  const lock = join(repo.directory, "publish.lock");
  const cursor = join(repo.directory, "refs", `${hash(identity.ref)}.json`);
  const id = hash("event");
  const event = join(repo.directory, "events", `${id}.json`);
  const content = JSON.stringify({
    id,
    kind: "message",
    createdAt: new Date(0).toISOString(),
    sender: { adapter: "test", session: "A", root: f.a },
    recipients: [],
    text: "test",
    files: [],
  });
  await writeFile(event, content);
  const before = await readFile(cursor, "utf8");

  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = fs.promises.open;
  const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
    if (args[0] === event) {
      entered();
      await gate;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const abort = new AbortController();
    const reason = new Error("test cancellation");
    let settled = false;
    const pending = withLock(lock, () => synchronizeRef(repo, identity.ref, identity, abort.signal));
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started;
    abort.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(
      withLock(lock, async () => {}),
      /busy/i,
    );
    release();
    await assert.rejects(pending, (error) => error === reason);
  } finally {
    release();
    patch.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(cursor, "utf8"), before);
  assert.equal(await readFile(event, "utf8"), content);
});

for (const folder of ["events", "trash"])
  test(
    `publication format conflict in ${folder} drains peer reads and keeps error priority`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t),
        repo = await repository(f.b),
        ref = "refs/heads/main";
      const id = hash(["upstream", ref, f.initial, f.initial, ""]),
        lock = join(repo.directory, "publish.lock");
      const regular = join(repo.directory, "events", `${id}.json`),
        conflict = join(repo.directory, folder, `${id}.posix.json`);
      await writeFile(regular, "{broken");
      await writeFile(conflict, "preserved conflict");
      let release!: () => void,
        entered!: () => void,
        settled = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const original = fs.promises.open;
      const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
        if (args[0] === regular) {
          entered();
          await gate;
        }
        return original(...args);
      });
      syncBuiltinESMExports();
      let pending: ReturnType<typeof publishUpstream> | undefined;
      try {
        pending = withLock(lock, () =>
          publishUpstream(repo, { adapter: "test", session: "sender" }, ref, f.initial, f.initial, []),
        );
        pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await started;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        await assert.rejects(
          withLock(lock, async () => {}),
          /busy/i,
        );
        release();
        await assert.rejects(pending, /ID conflicts with POSIX message/);
        assert.equal(await readFile(regular, "utf8"), "{broken");
        assert.equal(await readFile(conflict, "utf8"), "preserved conflict");
      } finally {
        release();
        await pending?.catch(() => {});
        patch.mock.restore();
        syncBuiltinESMExports();
      }
    },
  );
