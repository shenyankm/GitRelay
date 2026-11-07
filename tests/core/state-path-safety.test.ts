import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { hash, readJson } from "../../src/core/store.ts";
import { leaveSession } from "../../src/core/sessions.ts";

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "gitbeacon-state-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo"),
    template = join(directory, "template"),
    state = join(directory, "state"),
    outside = join(directory, "outside");
  await mkdir(template);
  await mkdir(outside);
  execFileSync("git", ["init", "--template", template, root], { stdio: "ignore" });
  const common = await realpath(join(root, ".git")),
    worktree = await realpath(root);
  const identity = "a".repeat(64),
    id = hash([common, identity]),
    directoryPath = join(state, "repos", id);
  await mkdir(directoryPath, { recursive: true });
  await writeFile(join(common, ".gitbeacon-id"), `${identity}\n`);
  for (const name of ["identity-owner.json", "identity-ready.json"])
    await writeFile(join(directoryPath, name), JSON.stringify({ id }));
  return { root, worktree, common, directory, directoryPath, id, identity, outside, state };
}

function preserveState(t: { after(fn: () => void): void }): void {
  const previous = process.env.GITBEACON_STATE_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = previous;
  });
}

const folders = ["sessions", "events", "receipts", "refs", "trash"] as const;
const message = (cwd: string) => ({ cwd, adapter: "test", session: "sender", text: "synthetic" });

test(
  "managed repository directories reject static symlinks without writing their targets",
  { skip: process.platform === "win32" },
  async (t) => {
    preserveState(t);
    for (const linked of folders) {
      const f = await fixture(t);
      process.env.GITBEACON_STATE_DIR = f.state;
      for (const name of folders)
        if (name === linked) await symlink(f.outside, join(f.directoryPath, name));
        else await mkdir(join(f.directoryPath, name));
      await assert.rejects(sendMessage(message(f.root)), /Invalid gitbeacon state directory/);
      assert.ok((await lstat(join(f.directoryPath, linked))).isSymbolicLink());
      assert.deepEqual(await readdir(f.outside), []);
    }
  },
);

test(
  "managed state children reject links while the selected state root can be a link",
  { skip: process.platform === "win32" },
  async (t) => {
    preserveState(t);
    for (const linked of ["identity-locks", "identity-choices", "identity-history"] as const) {
      const f = await fixture(t);
      process.env.GITBEACON_STATE_DIR = f.state;
      for (const name of folders) await mkdir(join(f.directoryPath, name));
      await symlink(f.outside, join(f.state, linked));
      await assert.rejects(sendMessage(message(f.root)), /Invalid gitbeacon state directory/);
      assert.ok((await lstat(join(f.state, linked))).isSymbolicLink());
      assert.deepEqual(await readdir(f.outside), []);
    }
    const f = await fixture(t);
    for (const name of folders) await mkdir(join(f.directoryPath, name));
    const alias = join(f.directory, "state-alias");
    await symlink(f.state, alias);
    process.env.GITBEACON_STATE_DIR = alias;
    const event = await sendMessage(message(f.root));
    assert.ok((await readdir(join(f.directoryPath, "events"))).includes(`${event.id}.json`));
  },
);

test(
  "nested receipt directories reject symlinks before consumption",
  { skip: process.platform === "win32" },
  async (t) => {
    preserveState(t);
    const f = await fixture(t);
    process.env.GITBEACON_STATE_DIR = f.state;
    for (const name of folders) await mkdir(join(f.directoryPath, name));
    const ref = "refs/heads/main",
      identity = { adapter: "test", session: "receiver" };
    const key = sessionKey({ root: f.worktree }, identity, ref);
    await symlink(f.outside, join(f.directoryPath, "receipts", key));
    let delivered = false;
    await assert.rejects(
      consumeMailbox({
        cwd: f.root,
        ...identity,
        ref,
        async deliver() {
          delivered = true;
        },
      }),
      /Invalid gitbeacon state directory/,
    );
    assert.equal(delivered, false);
    assert.deepEqual(await readdir(f.outside), []);
  },
);

test(
  "receipt files reject symlinks without changing ordinary readJson compatibility",
  { skip: process.platform === "win32" },
  async (t) => {
    preserveState(t);
    const f = await fixture(t);
    process.env.GITBEACON_STATE_DIR = f.state;
    for (const name of folders) await mkdir(join(f.directoryPath, name));
    const key = "b".repeat(64),
      id = "c".repeat(64),
      path = join(f.directoryPath, "receipts", key, `${id}.json`),
      target = join(f.outside, "receipt.json");
    await mkdir(join(f.directoryPath, "receipts", key));
    const receipt = { eventId: id, status: "delivered", at: new Date().toISOString() };
    await writeFile(target, JSON.stringify(receipt));
    await symlink(target, path);
    const repo = {
      root: f.worktree,
      common: f.common,
      id: f.id,
      directory: f.directoryPath,
      identity: f.identity,
      identitySource: "marker" as const,
    };
    await assert.rejects(readReceipt(repo, key, id), /State path is not a regular file/);
    assert.deepEqual(await readJson(path), receipt);
    assert.equal(await readlink(path), target);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), receipt);
    const normalId = "d".repeat(64),
      normal = { eventId: normalId, status: "delivered", at: receipt.at };
    await writeFile(join(f.directoryPath, "receipts", key, `${normalId}.json`), JSON.stringify(normal));
    assert.deepEqual(await readReceipt(repo, key, normalId), normal);
    assert.equal(await readReceipt(repo, key, "e".repeat(64)), undefined);
    const danglingId = "f".repeat(64),
      dangling = join(f.directoryPath, "receipts", key, `${danglingId}.json`);
    await symlink(join(f.outside, "missing.json"), dangling);
    await assert.rejects(readReceipt(repo, key, danglingId), /State path is not a regular file/);
    assert.equal(await readlink(dangling), join(f.outside, "missing.json"));
  },
);

test("leaving a missing worktree skips unrelated incomplete repository state", async (t) => {
  preserveState(t);
  const f = await fixture(t),
    missing = join(f.directory, "missing-worktree"),
    ref = "refs/heads/main",
    identity = { adapter: "test", session: "old" };
  process.env.GITBEACON_STATE_DIR = f.state;
  for (const name of folders) await mkdir(join(f.directoryPath, name));
  const now = new Date().toISOString(),
    key = sessionKey({ root: missing }, identity, ref);
  await writeFile(
    join(f.directoryPath, "repo.json"),
    JSON.stringify({ id: f.id, common: f.common, identity: f.identity, identitySource: "marker" }),
  );
  await writeFile(
    join(f.directoryPath, "sessions", `${key}.json`),
    JSON.stringify({ ...identity, key, root: missing, ref, createdAt: now, lastSeen: now }),
  );
  await mkdir(join(f.state, "repos", "e".repeat(64), "sessions"), { recursive: true });
  assert.ok((await leaveSession({ cwd: missing, ...identity, ref }))?.closedAt);
});
