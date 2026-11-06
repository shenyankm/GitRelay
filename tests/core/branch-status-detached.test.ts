import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { branchStatus } from "../../src/core/branch-status.ts";

test("ambiguous Git HEAD labels distinguish branches from detached or non-branch HEAD", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "git-relay-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    repo = join(root, "repo"),
    hooks = join(root, "hooks");
  for (const path of [home, repo, hooks]) await mkdir(path);
  const config = join(root, "gitconfig");
  await writeFile(config, "");
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
  });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "initial");
  git("switch", "-c", "(detached)");
  let status = await branchStatus({ cwd: repo });
  assert.equal(status.worktree.branch, "(detached)");
  assert.equal(status.local.ref, "refs/heads/(detached)");
  status = await branchStatus({ cwd: repo, branch: "main" });
  assert.equal(status.worktree.branch, "(detached)");
  assert.equal(status.local.ref, "refs/heads/main");
  git("switch", "--detach");
  await assert.rejects(branchStatus({ cwd: repo }), /Detached HEAD/);
  assert.equal((await branchStatus({ cwd: repo, branch: "main" })).worktree.branch, null);
  git("tag", "other");
  git("symbolic-ref", "HEAD", "refs/tags/other");
  const nonBranch = await branchStatus({ cwd: repo, branch: "main" });
  assert.equal(nonBranch.worktree.branch, null);
  await assert.rejects(branchStatus({ cwd: repo }), /HEAD does not point to a local branch/);
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("switch", "-c", "(null)");
  assert.equal((await branchStatus({ cwd: repo })).worktree.branch, "(null)");
  git("switch", "main");
  git("switch", "-c", "分支");
  assert.equal((await branchStatus({ cwd: repo })).worktree.branch, "分支");
  if (process.platform !== "win32") {
    git("switch", "(detached)");
    const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(root, "bin"),
      marker = join(root, "marker");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
if [ "$3" = symbolic-ref ]; then
  case "$CASE" in
    failure) echo failure >&2; exit 1;;
    invalid) printf 'refs/heads/\\377\\n'; exit 0;;
    switch) if [ -f "$MARKER" ]; then exit 1; else : > "$MARKER"; fi;;
  esac
fi
exec "${actualGit}" "$@"
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${previous.PATH}`;
    process.env.MARKER = marker;
    process.env.CASE = "failure";
    await assert.rejects(branchStatus({ cwd: repo }), /failure/);
    process.env.CASE = "invalid";
    await assert.rejects(branchStatus({ cwd: repo }), /not valid UTF-8/);
    process.env.CASE = "switch";
    await assert.rejects(branchStatus({ cwd: repo }), /HEAD changed/);
  }
  await assert.rejects(branchStatus({ cwd: repo, signal: AbortSignal.abort(new Error("stopped")) }), /stopped/);
});
