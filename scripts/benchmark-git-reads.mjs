import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [baseline, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, "Usage: node scripts/benchmark-git-reads.mjs [baseline-dist-directory]");
const variants = {
  ...(baseline ? { baseline: resolve(baseline) } : {}),
  candidate: fileURLToPath(new URL("../dist/", import.meta.url)),
};
const apis = {};
for (const [name, directory] of Object.entries(variants))
  apis[name] = {
    ...(await import(pathToFileURL(join(directory, "core/branch-status.js")))),
    ...(await import(pathToFileURL(join(directory, "core/changes.js")))),
  };
const temporary = await mkdtemp(join(tmpdir(), "git-relay-reads-bench-"));
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-C",
      temporary,
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
const results = [];
try {
  git("init", "-b", "main");
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  for (const file of ["staged", "unstaged"]) await writeFile(join(temporary, file), "base\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  const initial = git("rev-parse", "HEAD");
  git("checkout", "-b", "receiver");
  git("branch", "--set-upstream-to=main");
  await writeFile(join(temporary, "staged"), "staged\n");
  git("add", "staged");
  await writeFile(join(temporary, "staged"), "base\n");
  await writeFile(join(temporary, "unstaged"), "unstaged\n");
  await writeFile(join(temporary, "untracked"), "untracked\n");
  await writeFile(join(temporary, ".git", "info", "exclude"), "ignored\n");
  await writeFile(join(temporary, "ignored"), "ignored\n");
  const expected = ["ignored", "staged", "unstaged", "untracked"];
  const advanced = git("commit-tree", `${initial}^{tree}`, "-p", initial, "-m", "upstream");
  const measure = async (workload, run) => {
    for (let sample = 0; sample < 21; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [name, api] of entries) {
        const before = process.resourceUsage(),
          start = performance.now();
        await run(api);
        const wallMs = performance.now() - start,
          after = process.resourceUsage();
        if (sample)
          results.push({
            name,
            workload,
            sample,
            wallMs,
            cpuMs: (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000,
            fsReadBlocks: after.fsRead - before.fsRead,
            fsWriteBlocks: after.fsWrite - before.fsWrite,
          });
      }
    }
  };
  await measure("equal-status", async (api) => {
    const status = await api.branchStatus({ cwd: temporary });
    assert.equal(status.worktree.dirty, true);
    assert.deepEqual(status.local.tracking, { ref: "refs/heads/main", commit: initial, ahead: 0, behind: 0 });
  });
  await measure("equal-worktree", async (api) => {
    assert.deepEqual([...(await api.worktreeFiles(temporary, initial))].sort(), expected);
  });
  git("update-ref", "refs/heads/main", advanced);
  await measure("ancestor-worktree", async (api) => {
    assert.deepEqual([...(await api.worktreeFiles(temporary, advanced))].sort(), expected);
  });
  for (const api of Object.values(apis))
    assert.equal((await api.branchStatus({ cwd: temporary })).local.tracking.behind, 1);
  let history = "";
  for (const branch of ["main", "receiver"])
    for (let index = 0; index < 10_000; index++) {
      const message = `${branch} ${index}`;
      history += `commit refs/heads/${branch}\ncommitter Benchmark <benchmark@example.test> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}\n${index ? "" : `from ${initial}\n`}\n`;
    }
  execFileSync("git", ["-C", temporary, "fast-import", "--quiet", "--force"], { input: history });
  const upstream = git("rev-parse", "main"),
    local = git("rev-parse", "receiver");
  git("branch", "selected", initial);
  git("config", "branch.selected.remote", ".");
  git("config", "branch.selected.merge", "refs/heads/main");
  for (const commitGraph of [false, true]) {
    if (commitGraph) git("commit-graph", "write", "--reachable");
    for (const branch of ["receiver", "selected"])
      await measure(`${branch}-diverged-${commitGraph ? "with" : "without"}-commit-graph`, async (api) => {
        const status = await api.branchStatus({ cwd: temporary, branch });
        assert.deepEqual(status.worktree, { branch: "receiver", commit: local, dirty: true });
        assert.deepEqual(status.local, {
          ref: `refs/heads/${branch}`,
          commit: branch === "receiver" ? local : initial,
          tracking: {
            ref: "refs/heads/main",
            commit: upstream,
            ahead: branch === "receiver" ? 10_000 : 0,
            behind: 10_000,
          },
        });
      });
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = Object.fromEntries(
    Object.keys(apis).map((name) => [
      name,
      Object.fromEntries(
        [...new Set(results.map((row) => row.workload))].map((workload) => {
          const rows = results.filter((row) => row.name === name && row.workload === workload);
          return [
            workload,
            Object.fromEntries(
              ["wallMs", "cpuMs", "fsReadBlocks", "fsWriteBlocks"].map((key) => [
                key,
                median(rows.map((row) => row[key])),
              ]),
            ),
          ];
        }),
      ),
    ]),
  );
  console.log(
    JSON.stringify({
      environment: { node: process.version, git: git("--version"), platform: platform(), arch: arch() },
      variants,
      samples: 20,
      medians,
      results,
      workload:
        "same real Git repository; alternating variants; staged cancellation, unstaged, ignored and untracked files; 10,000 commits per diverged branch, with and without a commit graph; current and explicitly selected branch; one warm-up and setup excluded",
      limitations:
        "Warm local caches and uncontrolled external load. CPU covers Node, excluding Git children. Block counters are not physical disk bytes. No per-variant memory, cold-cache, network-filesystem or real-client latency comparison.",
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
