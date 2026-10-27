import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addWorktree, listWorktrees, parseWorktrees, removeWorktree } from "../../src/core/git.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "git-relay-worktree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-b", "main");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  return { root, repo };
}

test("NUL parser preserves unusual paths and worktree metadata", () => {
  assert.deepEqual(
    parseWorktrees(
      "worktree /tmp/a\n b\0HEAD abc123\0branch refs/heads/feature/a\0locked reason\0\0worktree /tmp/detached\0HEAD def456\0detached\0prunable missing directory\0\0worktree /tmp/bare\0bare\0\0",
    ),
    [
      { path: "/tmp/a\n b", head: "abc123", branch: "feature/a", locked: "reason" },
      { path: "/tmp/detached", head: "def456", detached: true, prunable: "missing directory" },
      { path: "/tmp/bare", bare: true },
    ],
  );
  assert.equal(parseWorktrees("worktree /x\0locked\0\0")[0].locked, "");
});

test("create new/existing branches and preserve worktrees when removal is unavailable", async (t) => {
  const { repo, root } = await fixture(t);
  const path = await addWorktree(repo, join(root, "space and \u4e2d\u6587\nworktree"), "feature/new", true);
  assert.equal((await listWorktrees(repo))[1].path, path);
  assert.equal((await listWorktrees(repo))[1].branch, "feature/new");
  await assert.rejects(removeWorktree(repo, path), /Automatic worktree removal is temporarily unavailable/);
  assert.equal((await listWorktrees(repo)).length, 2);
  git(repo, "show-ref", "--verify", "refs/heads/feature/new");
  git(repo, "branch", "feature/existing", "feature/new");
  const other = await addWorktree(repo, join(root, "existing tree"), "feature/existing");
  await assert.rejects(removeWorktree(repo, other), /Automatic worktree removal is temporarily unavailable/);
  assert.equal((await listWorktrees(repo)).length, 3);
});

test("protect primary, current/subdirectory/symlink, locked and dirty worktrees", async (t) => {
  const { repo, root } = await fixture(t);
  const path = await addWorktree(repo, join(root, "linked"), "feature/safe", true);
  await assert.rejects(removeWorktree(repo, repo), /main worktree/);
  await assert.rejects(removeWorktree(path, path), /current worktree/);
  const sub = join(path, "sub");
  await mkdir(sub);
  await assert.rejects(removeWorktree(sub, path), /current worktree/);
  const alias = join(root, "alias");
  await symlink(sub, alias, "dir");
  await assert.rejects(removeWorktree(alias, path), /current worktree/);
  await rm(sub, { recursive: true });
  git(repo, "worktree", "lock", path);
  await assert.rejects(removeWorktree(repo, path), /locked/);
  git(repo, "worktree", "unlock", path);
  await writeFile(join(path, "untracked.txt"), "keep me");
  await assert.rejects(removeWorktree(repo, path));
  assert.equal(await readFile(join(path, "untracked.txt"), "utf8"), "keep me");
  git(path, "add", "untracked.txt");
  await assert.rejects(removeWorktree(repo, path));
  assert.equal(await readFile(join(path, "untracked.txt"), "utf8"), "keep me");
  await assert.rejects(removeWorktree(repo, root), /not a worktree of the current repository/);
});

test("reject invalid inputs and refuse branch resets or tag-only checkouts", async (t) => {
  const { repo, root } = await fixture(t);
  const path = join(root, "target");
  await assert.rejects(addWorktree(repo, " ", "feature/new", true), /must not be empty/);
  await assert.rejects(addWorktree(repo, path, "--force", true));
  await assert.rejects(addWorktree(repo, path, "bad name", true));
  await assert.rejects(addWorktree(repo, path, "main", true));
  await assert.rejects(addWorktree(repo, path, "main"));
  await assert.rejects(addWorktree(repo, path, "feature/new", true, "--help"));
  git(repo, "tag", "tag-only");
  await assert.rejects(addWorktree(repo, path, "tag-only"));
  assert.equal((await listWorktrees(repo)).length, 1);
});

test("ambiguous tag/branch start points require a qualified ref", async (t) => {
  const { repo, root } = await fixture(t);
  const initial = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "tag", "dup");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "new",
  );
  const newer = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "branch", "dup");
  await assert.rejects(
    addWorktree(repo, join(root, "ambiguous"), "feature/ambiguous", true, "dup"),
    /matches both.*full ref/,
  );
  const fromBranch = await addWorktree(repo, join(root, "branch"), "feature/branch", true, "refs/heads/dup");
  const fromTag = await addWorktree(repo, join(root, "tag"), "feature/tag", true, "refs/tags/dup");
  assert.equal(git(fromBranch, "rev-parse", "HEAD").trim(), newer);
  assert.equal(git(fromTag, "rev-parse", "HEAD").trim(), initial);
});

test("supports explicit start points and reports non-repository errors", async (t) => {
  const { repo, root } = await fixture(t);
  const path = await addWorktree(repo, join(root, "target"), "feature/base", true, "main");
  assert.equal(git(path, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));
  await assert.rejects(listWorktrees(root), /git repository/);
});

test("a branch start point wins over a direct ref with the same name", async (t) => {
  const { repo, root } = await fixture(t);
  const initial = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "update-ref", "refs/stash", initial);
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "new");
  const newer = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "branch", "stash");
  const fromBranch = await addWorktree(repo, join(root, "branch"), "feature/stash", true, "stash");
  assert.equal(git(fromBranch, "rev-parse", "HEAD").trim(), newer);
});

test("new worktrees pin commits despite hash-shaped ref collisions", async (t) => {
  const { repo, root } = await fixture(t);
  const initial = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "new");
  const newer = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "update-ref", `refs/heads/${newer}`, initial);
  git(repo, "update-ref", `refs/tags/${newer}`, initial);
  const path = await addWorktree(repo, join(root, "hash"), "feature/hash", true, "main");
  assert.equal(git(path, "rev-parse", "HEAD").trim(), newer);
});

test(
  "new worktrees pin commits when a hash-shaped ref appears before creation",
  { skip: process.platform === "win32" },
  async (t) => {
    const { repo, root } = await fixture(t);
    const initial = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "new");
    const newer = git(repo, "rev-parse", "HEAD").trim();
    const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = add ]; then
  "$ISSUE40_GIT" -C "$2" update-ref "refs/heads/$ISSUE40_NEWER" "$ISSUE40_INITIAL" || exit 1
fi
exec "$ISSUE40_GIT" "$@"
`,
      { mode: 0o755 },
    );
    const previous = {
      PATH: process.env.PATH,
      ISSUE40_GIT: process.env.ISSUE40_GIT,
      ISSUE40_NEWER: process.env.ISSUE40_NEWER,
      ISSUE40_INITIAL: process.env.ISSUE40_INITIAL,
    };
    Object.assign(process.env, {
      PATH: `${bin}:${previous.PATH}`,
      ISSUE40_GIT: actualGit,
      ISSUE40_NEWER: newer,
      ISSUE40_INITIAL: initial,
    });
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const path = await addWorktree(repo, join(root, "injected"), "feature/injected", true, "main");
    assert.equal(git(path, "rev-parse", "HEAD").trim(), newer);
    assert.equal(git(repo, "rev-parse", `refs/heads/${newer}`).trim(), initial);
  },
);
