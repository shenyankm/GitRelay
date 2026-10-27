import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventsIn, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { hash, stateDirectory } from "../../src/core/store.ts";

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "send-message-input-")),
    template = join(dir, "template"),
    cwd = join(dir, "repo");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousState = process.env.WORKTREE_SYNC_STATE_DIR;
  process.env.WORKTREE_SYNC_STATE_DIR = join(dir, "state");
  t.after(() => {
    if (previousState === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
    else process.env.WORKTREE_SYNC_STATE_DIR = previousState;
  });
  await mkdir(template);
  execFileSync("git", ["init", "--template", template, cwd], { stdio: "pipe" });
  const root = await realpath(cwd),
    common = await realpath(join(root, ".git"));
  return { dir, root, common };
}

test("sparse file inputs fail before repository state is created", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    sendMessage({ cwd: f.root, adapter: "test", session: "s", text: "hello", files: Array(1) }),
    /Message files must be repository-relative/,
  );
  await assert.rejects(lstat(join(f.common, ".git-relay-id")), { code: "ENOENT" });
});

for (const changeSignal of [false, true])
  test(`sendMessage snapshots mutable inputs before awaiting (signal=${changeSignal})`, async (t) => {
    const f = await fixture(t),
      marker = "a".repeat(64),
      id = hash([f.common, marker]),
      directory = join(stateDirectory(), "repos", id);
    await mkdir(directory, { recursive: true });
    for (const name of ["sessions", "events", "receipts", "refs", "trash"]) await mkdir(join(directory, name));
    await writeFile(join(f.common, ".git-relay-id"), `${marker}\n`);
    for (const name of ["identity-owner.json", "identity-ready.json"])
      await writeFile(join(directory, name), JSON.stringify({ id }));
    const ref = "refs/heads/main",
      own = { adapter: "test", session: "sender" },
      peer = { adapter: "test", session: "peer" },
      now = new Date().toISOString();
    const ownKey = sessionKey({ root: f.root }, own, ref),
      peerRoot = join(f.dir, "other"),
      peerKey = sessionKey({ root: peerRoot }, peer, ref);
    for (const session of [
      { ...own, key: ownKey, root: f.root, ref, createdAt: now, lastSeen: now, migrated: true },
      { ...peer, key: peerKey, root: peerRoot, ref, createdAt: now, lastSeen: now, migrated: true },
    ])
      await writeFile(join(directory, "sessions", `${session.key}.json`), JSON.stringify(session));
    const originalSignal = new AbortController(),
      files = ["original.txt"];
    const options = { cwd: f.root, ...own, ref, text: "original message", files, signal: originalSignal.signal };
    const pending = sendMessage(options);
    options.cwd = join(f.dir, "not-present");
    options.adapter = "";
    options.session = "changed";
    options.text = "";
    options.ref = "refs/heads/other";
    files[0] = "changed.txt";
    if (changeSignal) options.signal = AbortSignal.abort();
    const event = await pending;
    assert.deepEqual(event.sender, { ...own, root: f.root });
    assert.equal(event.text, "original message");
    assert.deepEqual(event.files, ["original.txt"]);
    assert.deepEqual(event.recipients, [peerKey]);
    const repo = { root: f.root, common: f.common, id, directory, identity: marker, identitySource: "marker" as const };
    assert.deepEqual(
      (await eventsIn(repo)).map((item) => item.id),
      [event.id],
    );
    assert.equal(
      JSON.parse(await readFile(join(directory, "events", `${event.id}.json`), "utf8")).text,
      "original message",
    );
  });

test("aborting the captured signal still cancels the pending send", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const pending = sendMessage({
    cwd: f.root,
    adapter: "test",
    session: "sender",
    text: "message",
    signal: controller.signal,
  });
  controller.abort(new Error("cancel captured signal"));
  await assert.rejects(pending, /cancel captured signal/);
  await assert.rejects(lstat(join(f.common, ".git-relay-id")), { code: "ENOENT" });
});

test("send snapshots the closed sender key before options change", async (t) => {
  const f = await fixture(t),
    marker = "b".repeat(64),
    id = hash([f.common, marker]),
    directory = join(stateDirectory(), "repos", id);
  await mkdir(directory, { recursive: true });
  for (const name of ["sessions", "events", "receipts", "refs", "trash"]) await mkdir(join(directory, name));
  await writeFile(join(f.common, ".git-relay-id"), `${marker}\n`);
  for (const name of ["identity-owner.json", "identity-ready.json"])
    await writeFile(join(directory, name), JSON.stringify({ id }));
  const ref = "refs/heads/main",
    identity = { adapter: "test", session: "sender" },
    key = sessionKey({ root: f.root }, identity, ref),
    now = new Date().toISOString();
  await writeFile(
    join(directory, "sessions", `${key}.json`),
    JSON.stringify({
      ...identity,
      key,
      root: f.root,
      ref,
      createdAt: now,
      lastSeen: now,
      closedAt: now,
      migrated: true,
    }),
  );
  const options = { cwd: f.root, ...identity, ref, text: "message" },
    pending = sendMessage(options);
  options.ref = "refs/heads/other";
  options.session = "other";
  await assert.rejects(pending, /This session has left/);
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(join(directory, "events"))), []);
  for (const change of [
    { ref: "refs/heads/other" },
    { adapter: "cli" },
    { instance: "c".repeat(64) },
    { session: "other" },
  ]) {
    const sent = await sendMessage({ cwd: f.root, ...identity, ref, text: "message", ...change });
    assert.equal(sent.text, "message");
  }
  await assert.rejects(sendMessage({ cwd: f.root, ...identity, ref, text: "message" }), /This session has left/);
});
