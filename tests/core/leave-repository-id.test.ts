import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { sessionKey } from "../../src/core/mailbox.ts";
import { leaveSession, leaveSessionIfRepository, preflightLeaveSession } from "../../src/core/sessions.ts";
import { hash } from "../../src/core/store.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-leave-id-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.WORKTREE_SYNC_STATE_DIR;
  process.env.WORKTREE_SYNC_STATE_DIR = join(directory, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
    else process.env.WORKTREE_SYNC_STATE_DIR = previous;
  });
  const state = process.env.WORKTREE_SYNC_STATE_DIR,
    repos = join(state, "repos"),
    root = join(directory, "missing");
  const ref = "refs/heads/main",
    actor = { adapter: "test", session: "native" },
    key = sessionKey({ root }, actor, ref),
    now = new Date().toISOString();
  async function add(tag: string) {
    const common = join(directory, tag),
      identity = "a".repeat(64),
      id = hash([common, identity]),
      target = join(repos, id);
    for (const name of ["sessions", "events", "receipts", "refs", "trash"])
      await mkdir(join(target, name), { recursive: true });
    for (const name of ["identity-owner.json", "identity-ready.json"])
      await writeFile(join(target, name), JSON.stringify({ id }));
    await writeFile(join(target, "repo.json"), JSON.stringify({ id, common, identity, identitySource: "marker" }));
    await writeFile(
      join(target, "sessions", `${key}.json`),
      JSON.stringify({ ...actor, key, root, ref, createdAt: now, lastSeen: now, migrated: true }),
    );
    return { id, target };
  }
  return { directory, repos, root, ref, actor, key, add };
}

test("explicit state repository resolves ambiguous removed-worktree session without closing another", async (t) => {
  const f = await fixture(t),
    a = await f.add("a"),
    b = await f.add("b");
  await assert.rejects(leaveSession({ cwd: f.root, ...f.actor, ref: f.ref }), /Cannot uniquely locate/);
  assert.ok((await leaveSession({ cwd: f.root, ...f.actor, ref: f.ref, repositoryId: a.id }))?.closedAt);
  const other = JSON.parse(await readFile(join(b.target, "sessions", `${f.key}.json`), "utf8"));
  assert.equal(other.closedAt, undefined);
});

test("explicit repository preflight rejects existing paths and binds a removed-worktree leave", async (t) => {
  const f = await fixture(t),
    a = await f.add("a");
  const options = { cwd: f.root, ...f.actor, ref: f.ref, repositoryId: a.id };
  await assert.rejects(preflightLeaveSession({ ...options, cwd: f.directory }), /only for a missing worktree/);
  const checked = await preflightLeaveSession(options);
  assert.deepEqual(checked, { repositoryId: a.id });
  assert.equal(JSON.parse(await readFile(join(a.target, "sessions", `${f.key}.json`), "utf8")).closedAt, undefined);
  assert.ok((await leaveSessionIfRepository(options, checked))?.closedAt);
});

test(
  "explicit state repository avoids scanning another invalid entry",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      a = await f.add("a"),
      other = join(f.directory, "outside");
    await mkdir(join(other, "sessions"), { recursive: true });
    await symlink(other, join(f.repos, "f".repeat(64)));
    await assert.rejects(leaveSession({ cwd: f.root, ...f.actor, ref: f.ref }), /Invalid GitRelay state directory/);
    assert.ok((await leaveSession({ cwd: f.root, ...f.actor, ref: f.ref, repositoryId: a.id }))?.closedAt);
  },
);

test("explicit repository selection rejects invalid IDs, missing state, and existing worktrees", async (t) => {
  const f = await fixture(t);
  await f.add("a");
  await assert.rejects(
    leaveSession({ cwd: f.root, ...f.actor, ref: f.ref, repositoryId: "../outside" }),
    /Invalid repository state ID/,
  );
  await assert.rejects(
    leaveSession({ cwd: f.root, ...f.actor, ref: f.ref, repositoryId: "d".repeat(64) }),
    /Cannot uniquely locate/,
  );
  await assert.rejects(
    leaveSession({ cwd: f.directory, ...f.actor, ref: f.ref, repositoryId: "d".repeat(64) }),
    /only for a missing worktree/,
  );
});

test("explicit selection validates the selected state and subscription", async (t) => {
  const f = await fixture(t),
    a = await f.add("a");
  const path = join(a.target, "sessions", `${f.key}.json`),
    original = await readFile(path, "utf8");
  await writeFile(join(a.target, "identity-ready.json"), JSON.stringify({ id: "f".repeat(64) }));
  await assert.rejects(
    leaveSession({ cwd: f.root, ...f.actor, ref: f.ref, repositoryId: a.id }),
    /Incomplete GitRelay state initialization/,
  );
  await writeFile(join(a.target, "identity-ready.json"), JSON.stringify({ id: a.id }));
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), session: "different" }));
  await assert.rejects(leaveSession({ cwd: f.root, ...f.actor, ref: f.ref, repositoryId: a.id }), /Invalid session/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).closedAt, undefined);
});

test("repository selection cannot be used on another command", async () => {
  const cli = join(process.cwd(), "src", "cli", "main.ts");
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      cli,
      "sessions",
      "--repository-id",
      "a".repeat(64),
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--repository-id requires leave/);
});

test("CLI leave accepts a selected state repository", async (t) => {
  const f = await fixture(t),
    a = await f.add("a");
  const cli = join(process.cwd(), "src", "cli", "main.ts");
  const text = execFileSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      cli,
      "leave",
      "--cwd",
      f.root,
      "--agent",
      f.actor.adapter,
      "--session",
      f.actor.session,
      "--repository-id",
      a.id,
    ],
    { encoding: "utf8", env: process.env },
  );
  const result = JSON.parse(text);
  assert.equal(result.left, true);
  assert.ok(result.session.closedAt);
  assert.ok(JSON.parse(await readFile(join(a.target, "sessions", `${f.key}.json`), "utf8")).closedAt);
});

test(
  "leaving a dangling worktree link preserves the link and subscription",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      a = await f.add("a");
    await symlink(join(f.directory, "absent-target"), f.root);
    const path = join(a.target, "sessions", `${f.key}.json`),
      original = await readFile(path, "utf8");
    for (const cwd of [f.root, `${f.root}/`])
      for (const repositoryId of [undefined, a.id]) {
        await assert.rejects(
          leaveSession({ cwd, ...f.actor, ref: f.ref, repositoryId }),
          /Worktree path exists but cannot be resolved/,
        );
        assert.equal(await readFile(path, "utf8"), original);
        assert.equal((await lstat(f.root)).isSymbolicLink(), true);
      }
  },
);

test("missing path lstat errors are propagated for explicit and default leave", async (t) => {
  const f = await fixture(t),
    a = await f.add("a");
  const module = new URL("../../src/core/sessions.ts", import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    const root = ${JSON.stringify(f.root)};
    const originalStat = fs.promises.stat, originalLstat = fs.promises.lstat;
    fs.promises.stat = async (path, ...args) => {
      if (path === root) throw Object.assign(new Error('injected stat missing'), { code: 'ENOENT' });
      return originalStat(path, ...args);
    };
    fs.promises.lstat = async (path, ...args) => {
      if (path === root) throw Object.assign(new Error('injected lstat denied'), { code: 'EACCES' });
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    const { leaveSession } = await import(${JSON.stringify(module)});
    for (const repositoryId of [undefined, ${JSON.stringify(a.id)}]) {
      await assert.rejects(leaveSession({ cwd: root, adapter: 'test', session: 'native', ref: 'refs/heads/main', repositoryId }), /injected lstat denied/);
    }
  `;
  execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script],
    { env: process.env, timeout: 20000 },
  );
  assert.equal(JSON.parse(await readFile(join(a.target, "sessions", `${f.key}.json`), "utf8")).closedAt, undefined);
});

test(
  "leaving a missing path under a dangling ancestor preserves state",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      a = await f.add("a"),
      alias = join(f.directory, "ancestor");
    await symlink(join(f.directory, "absent-target"), alias);
    const cwd = join(alias, "missing"),
      key = sessionKey({ root: cwd }, f.actor, f.ref);
    const now = new Date().toISOString(),
      path = join(a.target, "sessions", `${key}.json`);
    const value = JSON.stringify({
      ...f.actor,
      key,
      root: cwd,
      ref: f.ref,
      createdAt: now,
      lastSeen: now,
      migrated: true,
    });
    await writeFile(path, value);
    for (const repositoryId of [undefined, a.id]) {
      await assert.rejects(
        leaveSession({ cwd, ...f.actor, ref: f.ref, repositoryId }),
        /Worktree ancestor is a dangling link/,
      );
      assert.equal(await readFile(path, "utf8"), value);
      assert.equal((await lstat(alias)).isSymbolicLink(), true);
    }
  },
);

test(
  "leaving a missing path through a valid ancestor link remains supported",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      a = await f.add("a"),
      parent = join(f.directory, "real-parent"),
      alias = join(f.directory, "alias");
    await mkdir(parent);
    await symlink(parent, alias);
    const cwd = join(alias, "missing"),
      key = sessionKey({ root: cwd }, f.actor, f.ref);
    const now = new Date().toISOString(),
      path = join(a.target, "sessions", `${key}.json`);
    await writeFile(
      path,
      JSON.stringify({ ...f.actor, key, root: cwd, ref: f.ref, createdAt: now, lastSeen: now, migrated: true }),
    );
    assert.ok((await leaveSession({ cwd, ...f.actor, ref: f.ref, repositoryId: a.id }))?.closedAt);
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
  },
);

test("missing-ancestor inspection stops at the filesystem root", async (t) => {
  const f = await fixture(t),
    a = await f.add("a");
  const module = new URL("../../src/core/sessions.ts", import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    import { dirname, join, parse } from 'node:path';
    const root = parse(process.cwd()).root, parent = join(root, '__gitrelay_nonexistent_root_probe__'), cwd = join(parent, 'missing');
    const originalStat = fs.promises.stat, originalLstat = fs.promises.lstat;
    let rootChecks = 0;
    fs.promises.stat = async (path, ...args) => {
      if (path === cwd) throw Object.assign(new Error('injected stat missing'), { code: 'ENOENT' });
      return originalStat(path, ...args);
    };
    fs.promises.lstat = async (path, ...args) => {
      if (path === cwd || path === parent || path === root) {
        if (path === root) rootChecks++;
        throw Object.assign(new Error('injected path missing'), { code: 'ENOENT' });
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    const { leaveSession } = await import(${JSON.stringify(module)});
    await assert.rejects(leaveSession({ cwd, adapter: 'test', session: 'native', ref: 'refs/heads/main', repositoryId: ${JSON.stringify(a.id)} }), /Cannot inspect worktree path ancestry/);
    assert.equal(rootChecks, 1);
    assert.equal(dirname(root), root);
  `;
  execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script],
    { env: process.env, timeout: 20000 },
  );
});

test(
  "leave cannot treat an existing normalized path as missing through a dangling dot-dot path",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      a = await f.add("a"),
      alias = join(f.directory, "dangling");
    await mkdir(f.root);
    await symlink(join(f.directory, "absent-target"), alias);
    const unnormalized = `${alias}/../missing`,
      path = join(a.target, "sessions", `${f.key}.json`);
    const original = await readFile(path, "utf8");
    for (const repositoryId of [undefined, a.id]) {
      await assert.rejects(leaveSession({ cwd: unnormalized, ...f.actor, ref: f.ref, repositoryId }));
      assert.equal(await readFile(path, "utf8"), original);
    }
  },
);

test(
  "leave rejects an existing raw symlink-dot-dot path even if the normalized path is missing",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      a = await f.add("a"),
      actual = join(f.directory, "other"),
      alias = join(f.directory, "link");
    await mkdir(join(actual, "child"), { recursive: true });
    await mkdir(join(actual, "missing"));
    await symlink(join(actual, "child"), alias);
    const raw = `${alias}/../missing`,
      path = join(a.target, "sessions", `${f.key}.json`),
      original = await readFile(path, "utf8");
    for (const repositoryId of [undefined, a.id]) {
      await assert.rejects(leaveSession({ cwd: raw, ...f.actor, ref: f.ref, repositoryId }));
      assert.equal(await readFile(path, "utf8"), original);
    }
  },
);
