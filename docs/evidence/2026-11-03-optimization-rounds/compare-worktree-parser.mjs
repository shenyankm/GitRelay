import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass saved baseline dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {},
  results = [];
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/git.js")))).parseWorktrees;
const branches = [
  "refs/heads/main",
  "refs/heads/refs/heads/main",
  "refs/remotes/origin/main",
  "refs/heads/工作😀",
  "",
  "refs/heads/",
  "\ufeffrefs/heads/main",
  "\nrefs/heads/main",
];
const corpus = [
  "",
  "unknown\0branch refs/heads/main\0",
  "worktree \0bare\0\0",
  "worktree /one\0worktree /two\0detached\0",
  "worktree /CR\r\n\0locked reason with spaces\0prunable missing\0",
];
for (const branch of branches)
  for (const suffix of ["", "\0", "\0\0", "\0branch refs/heads/replaced\0"])
    corpus.push(`worktree /fixture/工作😀\0HEAD ${"a".repeat(40)}\0branch ${branch}${suffix}`);
for (const text of corpus) assert.deepEqual(apis.candidate(text), apis.baseline(text));
for (const [count, calls] of [
  [1, 5000],
  [1000, 50],
  [10000, 5],
]) {
  const text = Array.from(
    { length: count },
    (_, i) =>
      `worktree /fixture/tree-${i}\0HEAD ${"a".repeat(40)}\0branch ${branches[i % branches.length]}\0locked lock-reason\0\0`,
  ).join("");
  const expected = apis.baseline(text);
  for (let sample = 0; sample <= 8; sample++) {
    const entries = Object.entries(apis);
    if (sample % 2) entries.reverse();
    for (const [variant, run] of entries) {
      let last,
        total = 0;
      const before = process.resourceUsage(),
        start = performance.now();
      for (let i = 0; i < calls; i++) {
        last = run(text);
        total += last.length;
      }
      const wallMs = (performance.now() - start) / calls,
        after = process.resourceUsage();
      const cpuMs =
        (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000 / calls;
      assert.equal(total, count * calls);
      assert.deepEqual(last, expected);
      if (sample) results.push({ count, calls, variant, sample, wallMs, cpuMs });
    }
  }
}
const medians = {};
for (const count of [1, 1000, 10000])
  for (const variant of Object.keys(apis))
    for (const key of ["wallMs", "cpuMs"]) {
      const s = results
        .filter((r) => r.count === count && r.variant === variant)
        .map((r) => r[key])
        .sort((a, b) => a - b);
      medians[`${count}-${variant}-${key}`] = (s[3] + s[4]) / 2;
    }
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: 8,
      comparedInputs: corpus.length,
      variants,
      medians,
      results,
      limitations:
        "Pure public worktree parser with ASCII/Unicode refs, incomplete records, repeated branch fields and unusual paths. Timings exclude output assertions. Warm modules and uncontrolled host load. No subprocess, physical I/O, peak memory, cold cache or native-client claim.",
    },
    null,
    2,
  ),
);
