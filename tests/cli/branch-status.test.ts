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
    const hosts = join(f.root, "hosts.log");
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
fs.appendFileSync(${JSON.stringify(hosts)}, (process.env.GH_HOST || '') + '\\n');
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(response)}, 'utf8'));
if (fixture.fail) { process.stderr.write('HTTP 403: denied'); process.exit(1); }
if (args[0] === 'repo') console.log(JSON.stringify({ nameWithOwner: 'owner/repo', url: fixture.url || 'https://github.example.com/owner/repo' }));
else console.log(JSON.stringify(fixture.pages));
`,
      { mode: 0o755 },
    );
    const invoke = (repo: string | null = "github.example.com/owner/repo") =>
      exec(process.execPath, [cli, "status", "--cwd", f.b, "--github", ...(repo ? ["--repo", repo] : [])], {
        env: { ...process.env, GH_HOST: "unrelated.invalid:9999", PATH: `${bin}:${process.env.PATH}` },
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
    await writeFile(
      response,
      JSON.stringify({ url: "https://github.example.com:8443/owner/repo", pages: [[ref("feature/b")]] }),
    );
    for (const repo of ["github.example.com:8443/owner/repo", null]) {
      assert.equal(JSON.parse((await invoke(repo)).stdout).github.matchesLocal, true);
      const entries = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.at(-1)[0], "api");
      assert.ok(!entries.at(-1).includes("--hostname"));
      assert.equal((await readFile(hosts, "utf8")).trim().split("\n").at(-1), "github.example.com:8443");
    }
    for (const repo of [
      "github.example.com:bad/owner/repo",
      "github.example.com:65536/owner/repo",
      "github.example.com:/owner/repo",
    ]) {
      await assert.rejects(invoke(repo), (error: Error & { stdout?: string }) => {
        assert.match(JSON.parse(error.stdout!).github.error, /--repo must be/);
        return true;
      });
    }
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
