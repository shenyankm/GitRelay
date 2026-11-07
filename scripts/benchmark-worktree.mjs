import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathMatcher, worktreeFiles } from "../dist/core/changes.js";

const temporary = await mkdtemp(join(tmpdir(), "gitbeacon-worktree-bench-"));
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
  git(temporary, "init", "-b", "main");
  for (const file of ["committed", "staged", "unstaged"]) await writeFile(join(temporary, file), "base\n");
  git(temporary, "add", ".");
  git(temporary, "commit", "-m", "baseline");
  const initial = git(temporary, "rev-parse", "HEAD");
  await writeFile(join(temporary, "committed"), "local commit\n");
  git(temporary, "add", "committed");
  git(temporary, "commit", "-m", "local change");
  await writeFile(join(temporary, "staged"), "staged\n");
  git(temporary, "add", "staged");
  await writeFile(join(temporary, "staged"), "base\n");
  await writeFile(join(temporary, "unstaged"), "unstaged\n");
  await writeFile(join(temporary, "untracked"), "untracked\n");
  await writeFile(join(temporary, ".git", "info", "exclude"), "ignored\n");
  await writeFile(join(temporary, "ignored"), "ignored\n");
  const samples = [];
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    const files = await worktreeFiles(temporary, initial);
    const elapsed = performance.now() - start;
    assert.deepEqual([...files].sort(), ["committed", "ignored", "staged", "unstaged", "untracked"]);
    if (i) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      node: process.version,
      git: git(temporary, "--version"),
      samples: samples.length,
      medianMs: samples[10],
      minMs: samples[0],
      maxMs: samples.at(-1),
    }),
  );
  await writeFile(join(temporary, ".git", "info", "exclude"), "ignored\n.cache/\n");
  const expected = new Set(["committed", "ignored", "staged", "unstaged", "untracked"]);
  let created = 0;
  for (const count of [1000, 10000, 100000]) {
    while (created < count) {
      const directory = `.cache/package-${created / 100}`;
      await mkdir(join(temporary, directory), { recursive: true });
      const writes = [];
      for (let i = 0; i < 100; i++, created++) {
        const file = `${directory}/file-${created}.txt`;
        expected.add(file);
        writes.push(writeFile(join(temporary, file), ""));
      }
      await Promise.all(writes);
    }
    const scans = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      const files = await worktreeFiles(temporary, initial);
      const matches = await pathMatcher(temporary, files);
      const elapsed = performance.now() - start;
      assert.deepEqual(files, expected);
      assert(matches(".cache/package-0/file-0.txt"));
      assert(matches(".cache/package-0"));
      assert(!matches(".cache/package-0/absent.txt"));
      if (i) scans.push(elapsed);
    }
    scans.sort((a, b) => a - b);
    console.log(JSON.stringify({ ignoredFiles: count, samples: scans.length, medianScanAndMatchMs: scans[2] }));
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
