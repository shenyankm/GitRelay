import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { inspectChange } from "../../src/core/changes.ts";
import { eventsIn, readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";

test(
  "transient Git failure cannot falsely acknowledge an existing upstream event",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      got: any[] = [];
    const receiver = {
      cwd: f.b,
      ref,
      adapter: "test",
      session: "B",
      async deliver(batch: any[]) {
        got.push(...batch);
      },
    };
    await consumeMailbox(receiver);
    await writeFile(join(f.b, "shared.txt"), "local");
    await f.commit(f.main, "shared.txt", "upstream");
    const bin = join(f.root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *' merge-base '*|*' cat-file '*) echo 'temporary wrapper failure' >&2; exit 1;; esac\nexec /usr/bin/git "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old ?? ""}`;
    try {
      await assert.rejects(
        consumeMailbox(receiver),
        (error: unknown) =>
          (error as Error).message.includes("could not compare") &&
          String((error as Error).cause).includes("temporary wrapper failure"),
      );
    } finally {
      if (old === undefined) delete process.env.PATH;
      else process.env.PATH = old;
    }
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref),
      event = (await eventsIn(repo)).find((item) => item.kind === "upstream")!;
    assert.ok(event);
    assert.equal(await readReceipt(repo, key, event.id), undefined);
    assert.equal(got.length, 0);
    await consumeMailbox(receiver);
    assert.equal(got.length, 1);
    assert.equal(got[0].change.unavailable, undefined);
    assert.match(got[0].change.patch, /upstream/);
  },
);

test("missing commits and shallow history fail closed", async (t) => {
  const f = await fixture(t);
  const tip = await f.commit(f.main, "shared.txt", "new");
  const missing = "f".repeat(40);
  await assert.rejects(inspectChange({ root: f.b, ref, commit: missing }, tip), /could not compare/);
  const clone = join(f.root, "shallow");
  git(f.root, "clone", "--depth", "1", pathToFileURL(f.main).href, clone);
  assert.throws(() => git(clone, "cat-file", "-e", `${f.initial}^{commit}`));
  await assert.rejects(inspectChange({ root: clone, ref, commit: f.initial }, tip), /could not compare/);
});

test("existing unrelated commits remain unread when merge-base is absent", async (t) => {
  const f = await fixture(t);
  const tree = git(f.main, "rev-parse", "HEAD^{tree}").trim();
  const child = await import("node:child_process");
  const orphan = child
    .execFileSync(
      "git",
      ["-C", f.main, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit-tree", tree],
      { input: "orphan\n", encoding: "utf8" },
    )
    .trim();
  await assert.rejects(inspectChange({ root: f.b, ref, commit: f.initial }, orphan), /history may be unrelated/);
});

for (const mode of ["permission", "corrupt"] as const) {
  test(
    `commit object ${mode} error cannot be classified as missing`,
    { skip: process.platform === "win32" || (mode === "permission" && process.getuid?.() === 0) },
    async (t) => {
      const f = await fixture(t);
      const tip = await f.commit(f.main, "shared.txt", "new");
      const object = join(f.main, ".git", "objects", f.initial.slice(0, 2), f.initial.slice(2));
      const bytes = await readFile(object);
      try {
        if (mode === "permission") await chmod(object, 0);
        else {
          await chmod(object, 0o644);
          await writeFile(object, "corrupt object");
        }
        await assert.rejects(inspectChange({ root: f.b, ref, commit: f.initial }, tip));
      } finally {
        await chmod(object, 0o644);
        await writeFile(object, bytes);
        await chmod(object, 0o444);
      }
    },
  );
}

for (const extension of ["pack", "idx"] as const) {
  test(
    `unreadable ${extension} fails closed instead of claiming missing commits`,
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async (t) => {
      const f = await fixture(t),
        tip = await f.commit(f.main, "shared.txt", "new");
      git(f.main, "gc", "--prune=now");
      const dir = join(f.main, ".git", "objects", "pack"),
        name = (await readdir(dir)).find((item) => item.endsWith(`.${extension}`));
      assert.ok(name);
      const path = join(dir, name);
      await chmod(path, 0);
      try {
        await assert.rejects(inspectChange({ root: f.b, ref, commit: f.initial }, tip), /could not compare/);
      } finally {
        await chmod(path, 0o444);
      }
    },
  );
}

test("pruned history remains unread while independent messages can advance", async (t) => {
  const f = await fixture(t),
    got: any[] = [];
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "B",
    async deliver(batch: any[]) {
      got.push(...batch);
    },
  };
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await consumeMailbox(receiver);
  const lost = await f.commit(f.main, "shared.txt", "old upstream\n");
  await consumeMailbox({
    ...receiver,
    async deliver() {
      return false;
    },
  });
  const backup = join(f.root, "object-backup"),
    objects = join(f.main, ".git", "objects");
  await cp(objects, backup, { recursive: true });
  git(f.main, "reset", "--hard", f.initial);
  git(f.main, "reflog", "expire", "--expire=now", "--all");
  git(f.main, "gc", "--prune=now");
  assert.throws(() => git(f.main, "cat-file", "-e", lost));
  await f.commit(f.main, "shared.txt", "new history\n");
  const message = await sendMessage({ cwd: f.a, adapter: "test", session: "A", text: "behind missing history" });
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  await assert.rejects(
    consumeMailbox(receiver),
    (error: unknown) =>
      (error as Error).message.includes("could not compare") && (error as Error).message.includes(lost),
  );
  const unread = (await eventsIn(repo)).filter((event) => event.recipients.includes(key));
  for (const event of unread)
    assert.equal((await readReceipt(repo, key, event.id))?.status, event.kind === "message" ? "delivered" : undefined);
  assert.deepEqual(
    got.map((item) => item.event.id),
    [message.id],
  );
  await cp(backup, objects, { recursive: true, force: false, errorOnExist: false });
  await consumeMailbox(receiver);
  assert.ok(got.some((item) => item.event.id === message.id));
  assert.equal(
    got.some((item) => item.change?.unavailable),
    false,
  );
  for (const event of unread) assert.ok(await readReceipt(repo, key, event.id));
  const count = got.length;
  await consumeMailbox(receiver);
  assert.equal(got.length, count);
});
