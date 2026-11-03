import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass saved round-24 dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/branch-status.js")))).branchStatus;
const root = await mkdtemp(join(tmpdir(), "gitrelay-ref-prefixes-")),
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
  git("commit", "--allow-empty", "-m", "initial");
  const commit = git("rev-parse", "HEAD");
  git("config", "branch.family.remote", ".");
  git("config", "branch.family.merge", "refs/heads/main");
  for (const workload of ["local", "upstream"]) {
    if (workload === "upstream") {
      git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      git("config", "branch.main.remote", "origin");
      git("config", "branch.main.merge", "refs/heads/family");
    }
    let created = 0;
    for (const count of [0, 1000, 10000]) {
      const records = [];
      while (created < count) {
        records.push(
          `update refs/${workload === "local" ? "heads" : "remotes/origin"}/family/child-${created} ${commit}\n`,
        );
        created++;
      }
      if (records.length)
        execFileSync("git", ["-C", cwd, "update-ref", "--stdin"], { input: records.join(""), stdio: "pipe" });
      for (let sample = 0; sample < 13; sample++) {
        const entries = Object.entries(apis);
        if (sample % 2) entries.reverse();
        for (const [variant, run] of entries) {
          const usage = process.resourceUsage(),
            start = performance.now(),
            status = await run({ cwd, ...(workload === "local" ? { branch: "family" } : {}) }),
            wallMs = performance.now() - start,
            after = process.resourceUsage(),
            cpuMs = (after.userCPUTime + after.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 1000;
          assert.deepEqual(status.worktree, { branch: "main", commit, dirty: false });
          assert.deepEqual(status.local, {
            ref: workload === "local" ? "refs/heads/family" : "refs/heads/main",
            commit: workload === "local" ? null : commit,
            tracking: {
              ref: workload === "local" ? "refs/heads/main" : "refs/remotes/origin/family",
              commit: workload === "local" ? commit : null,
              ahead: null,
              behind: null,
            },
          });
          if (sample) results.push({ workload, count, variant, sample, wallMs, cpuMs });
        }
      }
    }
  }
  const medians = {};
  for (const workload of ["local", "upstream"])
    for (const count of [0, 1000, 10000])
      for (const variant of Object.keys(apis))
        for (const key of ["wallMs", "cpuMs"]) {
          const s = results
            .filter((r) => r.workload === workload && r.count === count && r.variant === variant)
            .map((r) => r[key])
            .toSorted((a, b) => a - b);
          medians[`${workload}-${count}-${variant}-${key}`] = (s[5] + s[6]) / 2;
        }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples: 12,
        variants,
        medians,
        results,
        limitations:
          "Real Git refs with missing exact local/upstream refs and nested matching prefixes; full branch status and exact returned fields asserted. Warm local caches, setup/assertions excluded, uncontrolled host load. Node CPU excludes Git children. No cold cache, memory, Windows, network or native-client comparison.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
