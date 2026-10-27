import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { fixture, git } from "../helpers.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const run = (...args: string[]) => exec(process.execPath, [cli, ...args]);

test("status reports local divergence, dirty worktree, missing upstream and exact branch names", async (t) => {
  const f = await fixture(t);
  git(f.b, "branch", "--set-upstream-to=main");
  await f.commit(f.b, "shared.txt", "local\n");
  await f.commit(f.main, "other.txt", "remote\n");
  await writeFile(join(f.b, "untracked.txt"), "new\n");
  const snapshot = JSON.parse((await run("status", "--cwd", f.b)).stdout);
  assert.equal(snapshot.worktree.branch, "feature/b");
  assert.equal(snapshot.worktree.dirty, true);
  assert.equal(snapshot.local.tracking.ahead, 1);
  assert.equal(snapshot.local.tracking.behind, 1);
  assert.equal(snapshot.github, undefined);
  const missing = JSON.parse((await run("status", "--cwd", f.b, "--branch", "feature")).stdout);
  assert.equal(missing.local.commit, null);
  git(f.b, "config", "branch.feature/b.remote", "origin");
  git(f.b, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const gone = JSON.parse((await run("status", "--cwd", f.b)).stdout);
  assert.deepEqual(gone.local.tracking, { ref: "refs/remotes/origin/main", commit: null, ahead: null, behind: null });
  git(f.b, "checkout", "--detach");
  await assert.rejects(run("status", "--cwd", f.b), /Detached HEAD/);
  assert.equal(JSON.parse((await run("status", "--cwd", f.b, "--branch", "main")).stdout).worktree.branch, null);
  await assert.rejects(run("status", "--cwd", f.b, "--branch", "../main"));
  await assert.rejects(run("status", "--cwd", f.b, "--repo", "owner/repo"), /requires --github/);
  await assert.rejects(run("status", "--cwd", f.b, "--interval-ms", "NaN"), /interval-ms/);
  await assert.rejects(run("check", "--github"), /require the status command/);
});

test("status handles unborn branches", async (t) => {
  const f = await fixture(t);
  const empty = join(f.root, "empty");
  git(f.root, "init", "-b", "main", empty);
  const status = JSON.parse((await run("status", "--cwd", empty)).stdout);
  assert.equal(status.worktree.commit, null);
  assert.equal(status.local.commit, null);
  assert.equal(status.local.tracking, null);
  git(empty, "remote", "add", "origin", f.main);
  git(empty, "fetch", "origin", "main");
  git(empty, "config", "branch.main.remote", "origin");
  git(empty, "config", "branch.main.merge", "refs/heads/main");
  for (const args of [[], ["--branch", "main"]]) {
    const tracked = JSON.parse((await run("status", "--cwd", empty, ...args)).stdout);
    assert.deepEqual(tracked.local.tracking, {
      ref: "refs/remotes/origin/main",
      commit: f.initial,
      ahead: null,
      behind: null,
    });
    assert.match(
      (await run("status", "--cwd", empty, "--format", "markdown", ...args)).stdout,
      /refs\/remotes\/origin\/main/,
    );
  }
  assert.equal(JSON.parse((await run("status", "--cwd", empty, "--branch", "@")).stdout).local.tracking, null);
  git(empty, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(empty, "config", "branch.main.merge", "refs/heads/HEAD");
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty)).stdout).local.tracking, {
    ref: "refs/remotes/origin/HEAD",
    commit: f.initial,
    ahead: null,
    behind: null,
  });
  git(empty, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  git(empty, "config", "branch.main.merge", "refs/heads/main");
  git(empty, "update-ref", "-d", "refs/remotes/origin/main");
  for (const args of [[], ["--branch", "main"]]) {
    assert.deepEqual(JSON.parse((await run("status", "--cwd", empty, ...args)).stdout).local.tracking, {
      ref: "refs/remotes/origin/main",
      commit: null,
      ahead: null,
      behind: null,
    });
  }
  git(empty, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/m*:refs/custom/z*");
  git(empty, "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/other/*");
  git(empty, "config", "--add", "remote.origin.fetch", "^refs/heads/main");
  git(empty, "config", "--add", "branch.main.merge", "refs/heads/other");
  assert.match(git(empty, "status", "--porcelain=v2", "--branch"), /# branch\.upstream custom\/zain/);
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty)).stdout).local.tracking, {
    ref: "refs/custom/zain",
    commit: null,
    ahead: null,
    behind: null,
  });
  git(empty, "config", "branch.other.remote", ".");
  git(empty, "config", "branch.other.merge", "refs/heads/missing");
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty, "--branch", "other")).stdout).local.tracking, {
    ref: "refs/heads/missing",
    commit: null,
    ahead: null,
    behind: null,
  });
  git(empty, "config", "branch.other.merge", "missing");
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty, "--branch", "other")).stdout).local.tracking, {
    ref: "missing",
    commit: null,
    ahead: null,
    behind: null,
  });
  git(empty, "update-ref", "refs/heads/missing", f.initial);
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty, "--branch", "other")).stdout).local.tracking, {
    ref: "refs/heads/missing",
    commit: f.initial,
    ahead: null,
    behind: null,
  });
  git(empty, "update-ref", "refs/heads/shared", f.initial);
  git(empty, "update-ref", "refs/tags/shared", f.initial);
  git(empty, "config", "branch.other.merge", "shared");
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty, "--branch", "other")).stdout).local.tracking, {
    ref: "shared",
    commit: null,
    ahead: null,
    behind: null,
  });
  git(empty, "config", "branch.other.merge", "refs/heads/missing");
  git(empty, "config", "remote...fetch", "+refs/heads/*:refs/remotes/local/*");
  git(empty, "symbolic-ref", "HEAD", "refs/heads/other");
  assert.match(git(empty, "status", "--porcelain=v2", "--branch"), /# branch\.upstream local\/missing/);
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty)).stdout).local.tracking, {
    ref: "refs/remotes/local/missing",
    commit: null,
    ahead: null,
    behind: null,
  });
  git(empty, "symbolic-ref", "HEAD", "refs/heads/main");
  git(empty, "config", "--unset-all", "remote...fetch");
  git(empty, "config", "--replace-all", "branch.main.merge", "refs/heads/price$&");
  git(empty, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(empty, "update-ref", "refs/remotes/origin/price$&", f.initial);
  assert.deepEqual(JSON.parse((await run("status", "--cwd", empty)).stdout).local.tracking, {
    ref: "refs/remotes/origin/price$&",
    commit: f.initial,
    ahead: null,
    behind: null,
  });
  git(empty, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/other:refs/custom/other");
  assert.equal(JSON.parse((await run("status", "--cwd", empty)).stdout).local.tracking, null);
});

test("status writes an App-readable Markdown snapshot and keeps JSON as the default", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "status.md");
  const rendered = (await run("status", "--cwd", f.b, "--format", "markdown", "--output", path)).stdout;
  assert.equal(await readFile(path, "utf8"), rendered);
  assert.match(rendered, /# GitRelay/);
  assert.match(rendered, /Auto-sync.*Off/);
  assert.equal(JSON.parse((await run("status", "--cwd", f.b)).stdout).type, "worktree.branch-status");
  await assert.rejects(run("status", "--format", "html"), /json or markdown/);
  await assert.rejects(run("status", "--watch", "--format", "markdown", "--output", path), /without --watch/);
  await assert.rejects(run("hook", "removed", "--branch-status"), /requires hook codex/);
  const call = exec(process.execPath, [cli, "hook", "codex", "--branch-status"]);
  call.child.stdin!.end(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "Enable GitRelay",
      session_id: "app-test",
      cwd: f.b,
    }),
  );
  assert.match(JSON.parse((await call).stdout).systemMessage, /feature\/b/);
});

test(
  "GitHub status uses gh auth/host, encodes branches, handles absence and preserves local state on failure",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const bin = join(f.root, "bin");
    await mkdir(bin);
    const response = join(f.root, "response.json");
    const log = join(f.root, "gh.log");
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(response)}, 'utf8'));
if (fixture.fail) { process.stderr.write('HTTP 403: denied'); process.exit(1); }
if (args[0] === 'repo') console.log(JSON.stringify({ nameWithOwner: 'owner/repo', url: 'https://github.example.com/owner/repo' }));
else console.log(JSON.stringify(fixture.pages));
`,
      { mode: 0o755 },
    );
    const invoke = () =>
      exec(process.execPath, [cli, "status", "--cwd", f.b, "--github", "--repo", "github.example.com/owner/repo"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    const ref = (name: string, sha = f.initial) => ({ ref: `refs/heads/${name}`, object: { type: "commit", sha } });
    await writeFile(response, JSON.stringify({ pages: [[ref("feature/b-other")], [ref("feature/b")]] }));
    let status = JSON.parse((await invoke()).stdout);
    assert.equal(status.github.matchesLocal, true);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["repo", "view", "github.example.com/owner/repo", "--json", "nameWithOwner,url"]);
    assert.deepEqual(calls[1], [
      "api",
      "--hostname",
      "github.example.com",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      "repos/owner/repo/git/matching-refs/heads/feature%2Fb",
    ]);
    await writeFile(response, JSON.stringify({ pages: [[ref("feature/b", "a".repeat(40))]] }));
    assert.equal(JSON.parse((await invoke()).stdout).github.matchesLocal, false);
    await writeFile(response, JSON.stringify({ pages: [[ref("feature/b-other")]] }));
    assert.equal(JSON.parse((await invoke()).stdout).github.commit, null);
    for (const invalid of [{ fail: true }, { pages: [[ref("feature/b", "invalid")]] }, { pages: {} }]) {
      await writeFile(response, JSON.stringify(invalid));
      await assert.rejects(invoke(), (error: Error & { stdout?: string; code?: number }) => {
        status = JSON.parse(error.stdout!);
        assert.equal(error.code, 1);
        assert.equal(status.local.commit, f.initial);
        assert.match(status.github.error, /denied|Invalid GitHub/);
        return true;
      });
    }
    await writeFile(response, JSON.stringify({ pages: [[ref("feature/b")]] }));
    assert.equal(JSON.parse((await invoke()).stdout).github.matchesLocal, true);
  },
);

test(
  "status watch emits changes once, broadcasts after baseline, and exits on SIGTERM",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await run("check", "--cwd", f.c, "--session", "receiver");
    const child = spawn(
      process.execPath,
      [cli, "status", "--cwd", f.b, "--watch", "--interval-ms", "50", "--session", "monitor"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    const exited = once(child, "exit");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const lines = () => stdout.trim().split("\n").filter(Boolean);
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (lines().length < count && Date.now() < deadline) await delay(25);
      assert.equal(lines().length, count, stderr);
    };
    await waitFor(1);
    assert.equal((await run("check", "--cwd", f.c, "--session", "receiver")).stdout, "");
    await writeFile(join(f.b, "shared.txt"), "dirty\n");
    await waitFor(2);
    const received = JSON.parse((await run("check", "--cwd", f.c, "--session", "receiver")).stdout);
    assert.equal(JSON.parse(received.text).worktree.dirty, true);
    await delay(200);
    assert.equal(lines().length, 2);
    assert.equal((await run("check", "--cwd", f.c, "--session", "receiver")).stdout, "");
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
  },
);
