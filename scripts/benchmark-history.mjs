import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { inspectChange } from "../dist/core/changes.js";

const temporary = await mkdtemp(join(tmpdir(), "gitbeacon-history-bench-"));
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
  git(temporary, "init", "-b", "main", main);
  // Keep background Git housekeeping out of measurements and temporary-directory teardown.
  git(main, "config", "gc.auto", "0");
  git(main, "config", "maintenance.auto", "false");
  await writeFile(join(main, "shared.txt"), "base\n");
  await writeFile(join(main, "other.txt"), "base\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "baseline");
  const initial = git(main, "rev-parse", "HEAD");
  const receiver = join(temporary, "receiver");
  git(main, "worktree", "add", "-b", "receiver", receiver);
  await writeFile(join(receiver, "shared.txt"), "local\n");
  const commits = [];
  console.log(
    JSON.stringify({
      node: process.version,
      git: git(main, "--version"),
      platform: platform(),
      arch: arch(),
      samples: 3,
      workload: "first-parent history; two overlapping commits including a revert; setup excluded",
    }),
  );
  for (const count of [10, 100, 500]) {
    while (commits.length < count) {
      const index = commits.length;
      await writeFile(join(main, "other.txt"), `${index}\n`);
      if (index === 2 || index === 3) await writeFile(join(main, "shared.txt"), index === 2 ? "temporary\n" : "base\n");
      git(main, "add", ".");
      git(main, "commit", "-m", `update ${index}`);
      commits.push(git(main, "rev-parse", "HEAD"));
    }
    const samples = [];
    for (let sample = 0; sample < 3; sample++) {
      const start = performance.now();
      const change = await inspectChange({ root: receiver, ref: "refs/heads/main", commit: initial }, commits.at(-1));
      samples.push(performance.now() - start);
      assert.deepEqual(change.files, ["shared.txt"]);
      assert.deepEqual(change.commits, commits);
      assert.equal(change.snapshot, false);
      assert.match(change.patch, /temporary/);
      assert.deepEqual(
        [...change.patch.matchAll(/\nCommit ([a-f0-9]+)\n/g)].map((match) => match[1]),
        [commits[2], commits[3]],
      );
    }
    console.log(JSON.stringify({ commits: count, inspectMs: Math.round(samples.sort((a, b) => a - b)[1] * 10) / 10 }));
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
