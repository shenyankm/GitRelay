import assert from "node:assert/strict";
import fs from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { collectRepository } from "../../src/core/cleanup.ts";
import { publishUpstream, sessionKey } from "../../src/core/mailbox.ts";
import { type Repository } from "../../src/core/repository.ts";
import { hash, withLock } from "../../src/core/store.ts";

const ref = "refs/heads/main",
  previous = "a".repeat(40),
  commit = "b".repeat(40);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gitrelay-receipt-batches-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["sessions", "events", "trash", "refs", "receipts"]) await mkdir(join(directory, name));
  const repo: Repository = {
    root: directory,
    common: directory,
    directory,
    id: hash("repo"),
    identity: hash("identity"),
    identitySource: "external",
  };
  const at = "2020-01-01T00:00:00.000Z",
    id = hash(["upstream", ref, previous, commit, ""]);
  const recipients: string[] = [];
  for (const session of ["first", "second", "third"]) {
    const identity = { adapter: "test", session },
      key = sessionKey(repo, identity, ref);
    recipients.push(key);
    await mkdir(join(directory, "receipts", key));
    await writeFile(
      join(directory, "sessions", `${key}.json`),
      JSON.stringify({ ...identity, root: directory, key, ref, createdAt: at, lastSeen: at, migrated: true }),
    );
    await writeFile(
      join(directory, "receipts", key, `${id}.json`),
      JSON.stringify({ eventId: id, status: "delivered", at }),
    );
  }
  const event = {
    id,
    kind: "upstream",
    ref,
    previous,
    commit,
    createdAt: at,
    sender: { adapter: "test", session: "sender", root: directory },
    recipients,
  };
  await writeFile(join(directory, "refs", `${hash(ref)}.json`), JSON.stringify({ ref, commit }));
  return {
    repo,
    event,
    recipients,
    receipt: (index: number) => join(directory, "receipts", recipients[index], `${id}.json`),
    lock: join(directory, "publish.lock"),
  };
}

test("GC groups proof files by event and preserves unrelated names", async (t) => {
  const f = await fixture(t),
    directory = join(f.repo.directory, "receipts", f.recipients[0]);
  await writeFile(join(f.repo.directory, "events", `${f.event.id}.json`), JSON.stringify(f.event));
  const proofs = Array.from({ length: 33 }, (_, i) => `${f.event.id}.${hash(i)}.pi-proof`);
  const orphan = `${hash("other-event")}.${hash("proof")}.pi-proof`;
  for (const name of [...proofs, orphan, "notes.txt"])
    await writeFile(join(directory, name), "preserve unrelated proof");
  assert.deepEqual((await collectRepository(f.repo, { apply: true, retentionDays: 0 })).removed, [f.event.id]);
  for (const name of proofs) await assert.rejects(access(join(directory, name)), { code: "ENOENT" });
  for (const name of [orphan, "notes.txt"])
    assert.equal(await readFile(join(directory, name), "utf8"), "preserve unrelated proof");
});

for (const kind of ["receipt", "proof"])
  test(
    `GC drains ${kind} deletion peers before releasing its lock and can resume the trash journal`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t),
        trash = join(f.repo.directory, "trash", `${f.event.id}.json`),
        content = JSON.stringify(f.event);
      await writeFile(join(f.repo.directory, "events", `${f.event.id}.json`), content);
      const paths =
        kind === "receipt"
          ? [f.receipt(0), f.receipt(1), f.receipt(2)]
          : [0, 1, 2].map((index) =>
              join(
                f.repo.directory,
                "receipts",
                f.recipients[0],
                `${f.event.id}.${String(index).padStart(64, "0")}.pi-proof`,
              ),
            );
      if (kind === "proof") for (const path of paths) await writeFile(path, "proof");
      const gate = Promise.withResolvers<void>(),
        started = Promise.withResolvers<void>(),
        original = fs.promises.rm;
      const patch = t.mock.method(fs.promises, "rm", async (...args: Parameters<typeof original>) => {
        if (args[0] === paths[0]) throw new Error("first deletion failure");
        if (args[0] === paths[2]) throw new Error("later deletion failure");
        if (args[0] === paths[1]) {
          started.resolve();
          await gate.promise;
        }
        return original(...args);
      });
      syncBuiltinESMExports();
      let settled = false,
        pending: ReturnType<typeof collectRepository> | undefined;
      try {
        pending = collectRepository(f.repo, { apply: true, retentionDays: 0 });
        pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await started.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        await assert.rejects(
          withLock(f.lock, async () => {}),
          /busy/i,
        );
        assert.equal(await readFile(trash, "utf8"), content);
        gate.resolve();
        await assert.rejects(pending, /first deletion failure/);
        assert.equal(await readFile(trash, "utf8"), content);
        await assert.rejects(access(paths[1]), { code: "ENOENT" });
      } finally {
        gate.resolve();
        await pending?.catch(() => {});
        patch.mock.restore();
        syncBuiltinESMExports();
      }
      assert.deepEqual((await collectRepository(f.repo, { apply: true, retentionDays: 0 })).removed, [f.event.id]);
      await assert.rejects(access(trash), { code: "ENOENT" });
    },
  );

test(
  "trash recovery drains receipt peers and preserves a missing-first decision over corrupt later data",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      trash = join(f.repo.directory, "trash", `${f.event.id}.json`),
      path = join(f.repo.directory, "events", `${f.event.id}.json`);
    const content = JSON.stringify(f.event);
    await writeFile(trash, content);
    await rm(f.receipt(0));
    await writeFile(f.receipt(1), "{broken");
    const gate = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>(),
      original = fs.promises.open;
    let settled = false;
    const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
      if (args[0] === f.receipt(1)) {
        started.resolve();
        await gate.promise;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    let pending: ReturnType<typeof publishUpstream> | undefined;
    try {
      pending = withLock(f.lock, () => publishUpstream(f.repo, f.event.sender, ref, previous, commit, f.recipients));
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      await assert.rejects(
        withLock(f.lock, async () => {}),
        /busy/i,
      );
      gate.resolve();
      await assert.rejects(pending, /missing receipt; manual recovery required/);
      assert.equal(await readFile(trash, "utf8"), content);
      await assert.rejects(access(path), { code: "ENOENT" });
    } finally {
      gate.resolve();
      await pending?.catch(() => {});
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

for (const mode of ["missing", "legacy", "corrupt"])
  test(`GC drains recipient peers and preserves the first ${mode} decision`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t),
      path = join(f.repo.directory, "events", `${f.event.id}.json`),
      content = JSON.stringify(f.event);
    await writeFile(path, content);
    if (mode === "missing") await rm(f.receipt(1));
    else if (mode === "legacy") {
      const sessionPath = join(f.repo.directory, "sessions", `${f.recipients[1]}.json`),
        session = JSON.parse(await readFile(sessionPath, "utf8"));
      session.migrated = false;
      await writeFile(sessionPath, JSON.stringify(session));
    } else await writeFile(f.receipt(1), "{broken");
    if (mode !== "corrupt") await writeFile(f.receipt(2), "{later-corrupt");
    const gate = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>(),
      original = fs.promises.open;
    let settled = false;
    const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
      if (args[0] === f.receipt(2)) {
        started.resolve();
        await gate.promise;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    let pending: ReturnType<typeof collectRepository> | undefined;
    try {
      pending = collectRepository(f.repo, { apply: true, retentionDays: 0 });
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      await assert.rejects(
        withLock(f.lock, async () => {}),
        /busy/i,
      );
      gate.resolve();
      if (mode === "corrupt") await assert.rejects(pending, SyntaxError);
      else {
        const report = await pending;
        assert.deepEqual(report.kept, [{ id: f.event.id, reason: mode === "missing" ? "unconfirmed" : "migration" }]);
        assert.deepEqual(report.removed, []);
      }
      assert.equal(await readFile(path, "utf8"), content);
      assert.equal(JSON.parse(await readFile(f.receipt(0), "utf8")).eventId, f.event.id);
    } finally {
      gate.resolve();
      await pending?.catch(() => {});
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  });

test("GC caches legacy migration state only within a call and still validates every receipt", async (t) => {
  const f = await fixture(t),
    key = f.recipients[0],
    ids = ["1".padStart(64, "0"), "2".padStart(64, "0")];
  const sessionPath = join(f.repo.directory, "sessions", `${key}.json`),
    session = JSON.parse(await readFile(sessionPath, "utf8"));
  session.migrated = false;
  await writeFile(sessionPath, JSON.stringify(session));
  const receipt = (id: string) => join(f.repo.directory, "receipts", key, `${id}.json`);
  const acknowledgement = (id: string) => JSON.stringify({ eventId: id, status: "delivered", at: f.event.createdAt });
  for (const id of ids) {
    await writeFile(
      join(f.repo.directory, "events", `${id}.json`),
      JSON.stringify({
        id,
        kind: "message",
        createdAt: f.event.createdAt,
        sender: f.event.sender,
        recipients: [key],
        text: "preserve",
        files: [],
      }),
    );
    await writeFile(receipt(id), acknowledgement(id));
  }
  const original = fs.promises.open;
  let reads = 0;
  const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
    if (args[0] === sessionPath) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const report = await collectRepository(f.repo, { apply: true, retentionDays: 0 });
    assert.deepEqual(
      report.kept,
      ids.map((id) => ({ id, reason: "migration" })),
    );
    assert.deepEqual(report.removed, []);
    assert.equal(reads, 1);
    reads = 0;
    await writeFile(receipt(ids[1]), "{broken");
    await assert.rejects(collectRepository(f.repo, { apply: true, retentionDays: 0 }), SyntaxError);
    assert.equal(reads, 1);
    for (const id of ids) await access(join(f.repo.directory, "events", `${id}.json`));
    session.migrated = true;
    await writeFile(sessionPath, JSON.stringify(session));
    await writeFile(receipt(ids[1]), acknowledgement(ids[1]));
    reads = 0;
    const fresh = await collectRepository(f.repo, { apply: false, retentionDays: 0 });
    assert.deepEqual(fresh.eligible, ids);
    assert.deepEqual(fresh.kept, []);
    assert.equal(reads, 1);
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
  }
});
