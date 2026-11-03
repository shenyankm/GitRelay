import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass saved round-18 dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/branch-status.js")))).branchStatus;
const root = await mkdtemp(join(tmpdir(), "gitrelay-unborn-status-")),
  cwd = join(root, "repo"),
  template = join(root, "template"),
  results = [];
const git = (...args) =>
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
      "-c",
      `core.hooksPath=${template}`,
      ...args,
    ],
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
try {
  await mkdir(cwd);
  await mkdir(template);
  git("init", "--template", template, "-b", "main");
  let commit = null;
  for (const workload of ["unborn-empty", "unborn-tracked", "existing-control"]) {
    if (workload === "unborn-tracked") {
      git("config", "branch.main.remote", "origin");
      git("config", "branch.main.merge", "refs/heads/main");
      git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    }
    if (workload === "existing-control") {
      git("commit", "--allow-empty", "-m", "initial");
      commit = git("rev-parse", "HEAD");
    }
    for (let sample = 0; sample < 21; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const start = performance.now(),
          status = await run({ cwd }),
          wallMs = performance.now() - start;
        assert.deepEqual(status.worktree, { branch: "main", commit, dirty: false });
        assert.deepEqual(status.local, {
          ref: "refs/heads/main",
          commit,
          tracking:
            workload === "unborn-empty"
              ? null
              : { ref: "refs/remotes/origin/main", commit: null, ahead: null, behind: null },
        });
        if (sample) results.push({ workload, variant, sample, wallMs });
      }
    }
  }
  const medians = {};
  for (const workload of ["unborn-empty", "unborn-tracked", "existing-control"])
    for (const variant of Object.keys(apis)) {
      const s = results
        .filter((r) => r.workload === workload && r.variant === variant)
        .map((r) => r.wallMs)
        .toSorted((a, b) => a - b);
      medians[`${workload}-${variant}`] = (s[9] + s[10]) / 2;
    }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples: 20,
        variants,
        medians,
        results,
        limitations:
          "Real empty/initial-commit Git repositories and tracking configuration; exact branch/commit/tracking fields asserted. Warm local caches, setup/assertions excluded, uncontrolled host load. No concurrent config changes, cold caches, Windows, memory, network or native-client latency comparison.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
