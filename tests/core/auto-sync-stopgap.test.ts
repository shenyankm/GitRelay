import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { syncBranch } from "../../src/core/branch-sync.ts";
import { fixture, git } from "../helpers.ts";

test("sync refuses a different checked-out branch and preserves ignored data", async (t) => {
  const f = await fixture(t),
    bin = join(f.root, "fake-bin"),
    calls = join(f.root, "calls");
  const exclude = git(f.a, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
  await mkdir(dirname(exclude), { recursive: true });
  await writeFile(exclude, "ignored-secret\n", { flag: "a" });
  await writeFile(join(f.a, "ignored-secret"), "local only\n");
  git(f.a, "branch", "alternate");
  git(f.a, "switch", "alternate");
  const before = git(f.a, "rev-parse", "HEAD").trim();
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nexec /usr/bin/git "$@"\n`);
  await chmod(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const result = await syncBranch(f.a, "feature/a");
    assert.equal(result.state, "blocked");
    assert.match(result.reason ?? "", /checked out/);
    assert.doesNotMatch(await readFile(calls, "utf8"), /\b(?:fetch|merge)\b/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
  assert.equal(git(f.a, "symbolic-ref", "--short", "HEAD").trim(), "alternate");
  assert.equal(git(f.a, "rev-parse", "HEAD").trim(), before);
  assert.equal(await readFile(join(f.a, "ignored-secret"), "utf8"), "local only\n");
});

test("sync honors cancellation before querying Git", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(syncBranch("unused", "unused", controller.signal), { name: "AbortError" });
});

test("worktree lock and final identity checks cannot prevent a subsequent checkout", async (t) => {
  const f = await fixture(t);
  git(f.a, "branch", "alternate");
  const incoming = await f.commit(f.main, "shared.txt", "incoming\n");
  git(f.main, "worktree", "lock", f.a);
  assert.equal(git(f.a, "symbolic-ref", "HEAD").trim(), "refs/heads/feature/a");
  assert.equal(git(f.a, "rev-parse", "HEAD").trim(), f.initial);
  // This is the exact gap between the old final check and its merge.
  git(f.a, "switch", "alternate");
  const result = await syncBranch(f.a, "feature/a");
  assert.equal(result.state, "blocked");
  assert.equal(git(f.a, "rev-parse", "refs/heads/alternate").trim(), f.initial);
  assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "base\n");
  // Pinning the incoming OID still lets a merge advance the wrong branch.
  git(f.a, "merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", incoming);
  assert.equal(git(f.a, "rev-parse", "refs/heads/feature/a").trim(), f.initial);
  assert.equal(git(f.a, "rev-parse", "refs/heads/alternate").trim(), incoming);
  assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "incoming\n");
  git(f.main, "worktree", "unlock", f.a);
});

test("CLI rejects conflicting sync flags and ambiguous sources before querying Git", async () => {
  const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
  for (const [flags, message] of [
    [["--auto-sync", "--no-auto-sync"], /Choose/],
    [["--github", "--auto-sync", "--repo", "owner/repo"], /omit --repo/],
  ] as const) {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "status", ...flags], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, message);
  }
});

test("auto-sync watch continues read-only status and reports blocked", async (t) => {
  const f = await fixture(t),
    cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", cli, "status", "--cwd", f.a, "--watch", "--auto-sync"],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  const status = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`watch timed out: ${stderr}`));
    }, 8000);
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (data) => {
      stdout += String(data);
      const end = stdout.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, end)));
      } catch (error) {
        reject(error);
      }
      child.kill("SIGTERM");
    });
  });
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(status.sync.state, "blocked");
  assert.equal(status.worktree.branch, "feature/a");
  assert.equal(status.local.commit, f.initial);
  assert.equal(git(f.a, "rev-parse", "HEAD").trim(), f.initial);
});

test("one-shot auto-sync exits blocked while explicit off remains read-only", async (t) => {
  const f = await fixture(t),
    cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
  for (const flag of ["--auto-sync", "--no-auto-sync"]) {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "status", "--cwd", f.a, flag], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const status = JSON.parse(stdout);
    assert.equal(code, flag === "--auto-sync" ? 1 : 0, stderr);
    assert.equal(status.sync?.state, flag === "--auto-sync" ? "blocked" : undefined);
    assert.equal(status.local.commit, f.initial);
    assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "base\n");
  }
});
