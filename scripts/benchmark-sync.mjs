import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBranch } from "../dist/core/branch-sync.js";

const temporary = await mkdtemp(join(tmpdir(), "gitbeacon-sync-bench-"));
const previousState = process.env.GITBEACON_STATE_DIR;
process.env.GITBEACON_STATE_DIR = join(temporary, "state");
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
try {
  const main = join(temporary, "main");
  const receiver = join(temporary, "receiver");
  git(temporary, "init", "-b", "main", main);
  await writeFile(join(main, "shared.txt"), "base\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "baseline");
  const initial = git(main, "rev-parse", "HEAD");
  git(main, "worktree", "add", "-b", "receiver", receiver);
  git(receiver, "remote", "add", "benchmark", main);
  git(receiver, "fetch", "benchmark");
  git(receiver, "branch", "--set-upstream-to=benchmark/main");
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const start = performance.now();
    const result = await syncBranch(receiver, "receiver");
    const elapsed = performance.now() - start;
    assert.equal(result.state, "up-to-date");
    assert.equal(git(receiver, "rev-parse", "HEAD"), initial);
    assert.equal(await readFile(join(receiver, "shared.txt"), "utf8"), "base\n");
    assert.equal(git(receiver, "status", "--porcelain"), "");
    if (i) samples.push(elapsed);
  }
  console.log(
    JSON.stringify({
      node: process.version,
      git: git(main, "--version"),
      samples: samples.length,
      medianMs: samples.sort((a, b) => a - b)[3],
      workload: "up-to-date linked worktree with local file remote; one warm-up and setup excluded",
    }),
  );
} finally {
  if (previousState === undefined) delete process.env.GITBEACON_STATE_DIR;
  else process.env.GITBEACON_STATE_DIR = previousState;
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
