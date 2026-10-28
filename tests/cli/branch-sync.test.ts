import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { syncBranch } from "../../src/core/branch-sync.ts";
import { fixture, git } from "../helpers.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  git(f.b, "remote", "add", "origin", f.main);
  git(f.b, "fetch", "origin");
  git(f.b, "branch", "--set-upstream-to=origin/main");
  return f;
}

test("auto-sync is opt-in, fetches and fast-forwards once; explicit off stays read-only", async (t) => {
  const f = await setup(t);
  const commit = await f.commit(f.main, "shared.txt", "cloud\n");
  for (const flags of [[], ["--no-auto-sync"]]) {
    const result = JSON.parse((await exec(process.execPath, [cli, "status", "--cwd", f.b, ...flags])).stdout);
    assert.equal(result.sync, undefined);
    assert.equal(result.local.commit, f.initial);
    assert.equal(result.local.tracking.commit, f.initial);
  }
  const result = JSON.parse((await exec(process.execPath, [cli, "status", "--cwd", f.b, "--auto-sync"])).stdout);
  assert.equal(result.sync.state, "updated");
  assert.equal(result.local.commit, commit);
  assert.equal(result.local.tracking.commit, commit);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "cloud\n");
  assert.equal((await syncBranch(f.b, "feature/b")).state, "up-to-date");
  await assert.rejects(exec(process.execPath, [cli, "status", "--auto-sync", "--no-auto-sync"]), /Choose/);
  await assert.rejects(
    exec(process.execPath, [cli, "status", "--github", "--auto-sync", "--repo", "owner/repo"]),
    /omit --repo/,
  );
});

test("auto-sync preserves dirty work, never autostashes, and refreshes tracking refs", async (t) => {
  const f = await setup(t);
  const commit = await f.commit(f.main, "shared.txt", "cloud\n");
  git(f.b, "config", "merge.autoStash", "true");
  await writeFile(join(f.b, "shared.txt"), "unfinished\n");
  await assert.rejects(
    exec(process.execPath, [cli, "status", "--cwd", f.b, "--auto-sync"]),
    (error: Error & { stdout?: string; code?: number }) => {
      const status = JSON.parse(error.stdout!);
      assert.equal(error.code, 1);
      assert.equal(status.sync.state, "blocked");
      assert.equal(status.local.tracking.commit, commit);
      return true;
    },
  );
  assert.equal(git(f.b, "rev-parse", "HEAD").trim(), f.initial);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "unfinished\n");
  assert.equal(git(f.b, "stash", "list"), "");
});

test("auto-sync preserves ignored files that upstream would overwrite", async (t) => {
  const f = await setup(t);
  const exclude = git(f.b, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
  await mkdir(dirname(exclude), { recursive: true });
  await writeFile(exclude, "secret.txt\n");
  await writeFile(join(f.b, "secret.txt"), "local secret\n");
  await writeFile(join(f.main, "secret.txt"), "upstream\n");
  git(f.main, "add", "-f", "secret.txt");
  git(f.main, "commit", "-m", "track file");
  assert.equal((await syncBranch(f.b, "feature/b")).state, "error");
  assert.equal(await readFile(join(f.b, "secret.txt"), "utf8"), "local secret\n");
  assert.equal(git(f.b, "rev-parse", "HEAD").trim(), f.initial);
});

test("auto-sync refuses divergence, other worktrees and active Git operations", async (t) => {
  const f = await setup(t);
  assert.equal((await syncBranch(f.b, "main")).state, "blocked");
  const rebase = git(f.b, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge").trim();
  await mkdir(rebase);
  assert.match((await syncBranch(f.b, "feature/b")).reason!, /operation in progress/);
  // Use another clean worktree for the independent divergence case.
  git(f.c, "branch", "--set-upstream-to=origin/main");
  const local = await f.commit(f.c, "other.txt", "local\n");
  assert.equal((await syncBranch(f.c, "feature/c")).state, "ahead");
  await f.commit(f.main, "shared.txt", "cloud\n");
  assert.match((await syncBranch(f.c, "feature/c")).reason!, /diverged/);
  assert.equal(git(f.c, "rev-parse", "HEAD").trim(), local);
});

test("auto-sync checks every operation marker in its linked worktree", async (t) => {
  const f = await setup(t);
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
  ]) {
    const path = git(f.b, "rev-parse", "--path-format=absolute", "--git-path", name).trim();
    try {
      if (["rebase-merge", "rebase-apply", "sequencer"].includes(name)) await mkdir(path);
      else await writeFile(path, `${f.initial}\n`);
      const result = await syncBranch(f.b, "feature/b");
      assert.equal(result.state, "blocked", result.reason);
      assert.ok(result.reason?.includes(`(${name})`), result.reason);
      assert.equal(git(f.b, "rev-parse", "HEAD").trim(), f.initial);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
  assert.equal((await syncBranch(f.b, "feature/b")).state, "up-to-date");
});

test("missing upstream and failed fetch never move the local branch", async (t) => {
  const f = await setup(t);
  assert.equal((await syncBranch(f.a, "feature/a")).state, "blocked");
  git(f.b, "remote", "set-url", "origin", join(f.root, "missing.git"));
  assert.equal((await syncBranch(f.b, "feature/b")).state, "error");
  assert.equal(git(f.b, "rev-parse", "HEAD").trim(), f.initial);
});
