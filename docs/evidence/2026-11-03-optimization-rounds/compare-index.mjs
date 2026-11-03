import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass the saved round-12 dist directory.");
const variants = {
  baseline: resolve(process.argv[2]),
  candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
};
const apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/changes.js")))).worktreeFiles;
const root = await mkdtemp(join(tmpdir(), "gitrelay-index-perf-"));
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
const results = [];
try {
  const template = join(root, "template");
  await mkdir(template);
  git("init", "--template", template, "-b", "main");
  git("commit", "--allow-empty", "-m", "initial");
  const commit = git("rev-parse", "HEAD");
  const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
    input: "",
    encoding: "utf8",
  }).trim();
  for (const count of [0, 1000, 100000]) {
    git("read-tree", "--empty");
    const files = Array.from({ length: count }, (_, i) => `file-${String(i).padStart(6, "0")}.txt`);
    const expected = [...files, "submodule"].sort();
    const records = files.map((file) => `100644 ${blob}\t${file}\0`).join("") + `160000 ${commit}\tsubmodule\0`;
    execFileSync("git", ["-C", root, "update-index", "-z", "--index-info"], {
      input: records,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (let sample = 0; sample < 13; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const usage = process.resourceUsage(),
          start = performance.now();
        const own = await run(root, commit);
        const wallMs = performance.now() - start,
          after = process.resourceUsage(),
          cpuMs = (after.userCPUTime + after.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 1000;
        assert.deepEqual([...own].sort(), expected);
        if (sample) results.push({ count, variant, sample, wallMs, cpuMs });
      }
    }
  }
  const medians = {};
  for (const count of [0, 1000, 100000])
    for (const variant of Object.keys(apis))
      for (const key of ["wallMs", "cpuMs"]) {
        const s = results
          .filter((r) => r.count === count && r.variant === variant)
          .map((r) => r[key])
          .toSorted((a, b) => a - b);
        medians[`${count}-${variant}-${key}`] = (s[5] + s[6]) / 2;
      }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        git: git("--version"),
        platform: process.platform,
        arch: process.arch,
        samples: 12,
        variants,
        medians,
        results,
        limitations:
          "Real Git index; absent ordinary files create staged and unstaged relevance; one uninitialized gitlink. Warm caches and uncontrolled host load. Node CPU excludes Git children. No cold caches, peak memory, Windows or native-client latency.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
