import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { publishUpstream, sessionKey, type Notification } from "../../src/core/mailbox.ts";
import { readRef } from "../../src/core/publisher.ts";
import { hash, withLock } from "../../src/core/store.ts";
import { type Repository } from "../../src/core/repository.ts";

const ref = "refs/heads/main",
  agent = { adapter: "test", session: "receiver" };
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "gitrelay-hint-recovery-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const keys = Object.keys(process.env).filter(
    (key) => key.startsWith("GIT_") || key === "WORKTREE_SYNC_STATE_DIR" || key === "WORKTREE_SYNC_REPOSITORY_IDS",
  );
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (key.startsWith("GIT_") || key === "WORKTREE_SYNC_STATE_DIR" || key === "WORKTREE_SYNC_REPOSITORY_IDS")
        delete process.env[key];
    Object.assign(process.env, previous);
  });
  const template = join(base, "template"),
    raw = join(base, "repo"),
    state = join(base, "state"),
    config = join(base, "gitconfig");
  await mkdir(template);
  await writeFile(config, "");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";
  execFileSync("git", ["init", "--template", template, raw], { stdio: "pipe" });
  const root = await realpath(raw),
    common = await realpath(join(root, ".git"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${template}`,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("symbolic-ref", "HEAD", ref);
  await writeFile(join(root, "file"), "A\n");
  git("add", "file");
  git("commit", "-m", "A");
  const a = git("rev-parse", "HEAD");
  await writeFile(join(root, "file"), "B\n");
  git("add", "file");
  git("commit", "-m", "B");
  const b = git("rev-parse", "HEAD");
  const identity = "a".repeat(64),
    id = hash([common, identity]);
  const repo: Repository = {
    root,
    common,
    id,
    directory: join(state, "repos", id),
    identity,
    identitySource: "marker",
  };
  await writeFile(join(common, ".git-relay-id"), `${identity}\n`);
  for (const name of ["sessions", "events", "receipts", "refs", "trash"])
    await mkdir(join(repo.directory, name), { recursive: true });
  for (const name of ["identity-ready.json", "identity-owner.json"])
    await writeFile(join(repo.directory, name), JSON.stringify({ id }));
  const key = sessionKey(repo, agent, ref),
    now = new Date().toISOString(),
    token = hash("daemon"),
    cursorPath = join(repo.directory, "refs", `${hash(ref)}.json`);
  await writeFile(
    join(repo.directory, "sessions", `${key}.json`),
    JSON.stringify({ ...agent, key, root, ref, createdAt: now, lastSeen: now, baseline: a, migrated: true }),
  );
  await writeFile(cursorPath, JSON.stringify({ ref, commit: a, checkedAt: now, daemonToken: token }));
  await writeFile(join(state, "daemon.lock"), JSON.stringify({ pid: process.pid, token }));
  await writeFile(
    join(state, "daemon.json"),
    JSON.stringify({ pid: process.pid, token, intervalMs: 5000, heartbeatAt: now }),
  );
  process.env.WORKTREE_SYNC_STATE_DIR = state;
  const delivered: Notification[] = [];
  const consume = () =>
    consumeMailbox({
      cwd: root,
      ...agent,
      ref,
      async deliver(batch) {
        delivered.push(...batch);
      },
    });
  let copy = 0;
  const retry = async () => {
    const next = `${state}-copy-${++copy}`,
      source = process.env.WORKTREE_SYNC_STATE_DIR!;
    await cp(source, next, {
      recursive: true,
      filter: (path) => !path.endsWith(".lock") || path.endsWith("daemon.lock"),
    });
    process.env.WORKTREE_SYNC_STATE_DIR = next;
    return { ...repo, directory: join(next, "repos", id) };
  };
  return { a, b, base, root, repo, cursorPath, key, git, consume, retry, delivered };
}

test("a matching daemon hint cannot hide a newer ref", async (t) => {
  const f = await fixture(t);
  await f.consume();
  assert.equal((await readRef(f.repo, ref))?.commit, f.b);
  assert.equal(
    (await readdir(join(f.repo.directory, "events"))).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length,
    1,
  );
});

test("a retained hint cannot hide pending publication after ref rollback", async (t) => {
  const f = await fixture(t);
  // Model an old writer that wrote its event but did not advance the cursor.
  await withLock(join(f.repo.directory, "publish.lock"), () => publishUpstream(f.repo, agent, ref, f.a, f.b, [f.key]));
  // Test preload retains locks, so continue from a lock-free copy of the state.
  const resumed = await f.retry();
  f.git("update-ref", ref, f.a);
  await writeFile(join(f.root, "file"), "local edit\n");
  await f.consume();
  assert.equal((await readRef(resumed, ref))?.commit, f.a);
  assert.equal(f.delivered.length, 2);
  assert.deepEqual(
    new Set(f.delivered.map(({ event }) => event.kind === "upstream" && `${event.previous}:${event.commit}`)),
    new Set([`${f.a}:${f.b}`, `${f.b}:${f.a}`]),
  );
  const recovered = await f.retry();
  await f.consume();
  assert.equal(f.delivered.length, 2, "receipts prevent repeat delivery");
  assert.equal(
    (await readdir(join(recovered.directory, "events"))).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length,
    2,
  );
});

test("cursor write failure is reported and a retry recovers the event once", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file"), "local edit\n");
  const original = fs.promises.rename;
  let injected = false;
  fs.promises.rename = (async (source, target) => {
    if (target === f.cursorPath) {
      injected = true;
      throw new Error("injected cursor EIO");
    }
    return original(source, target);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.consume(), /injected cursor EIO/);
  } finally {
    fs.promises.rename = original;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(f.delivered.length, 0);
  assert.equal((await readRef(f.repo, ref))?.commit, f.a);
  const recovered = await f.retry();
  await f.consume();
  assert.equal((await readRef(recovered, ref))?.commit, f.b);
  assert.equal(f.delivered.length, 1);
  assert.equal(
    (await readdir(join(recovered.directory, "events"))).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length,
    1,
  );
});
