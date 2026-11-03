import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass saved baseline dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {},
  results = [];
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/store.js")))).hash;
const corpus = [
  null,
  true,
  false,
  0,
  -0,
  NaN,
  Infinity,
  "",
  "工作😀\ud800\0",
  [],
  {},
  { b: 2, a: 1 },
  new Date(0),
  Buffer.from([0, 255]),
];
for (let i = 0; i < 1000; i++)
  corpus.push(["upstream", `refs/heads/topic-${i}`, "a".repeat(40), "b".repeat(40), `${i}`]);
for (const value of corpus) assert.equal(apis.candidate(value), apis.baseline(value));
const cycle = {};
cycle.self = cycle;
const invalid = [undefined, Symbol("x"), 1n, cycle];
for (const value of invalid) {
  const outcomes = Object.values(apis).map((run) => {
    try {
      run(value);
      assert.fail("Invalid value accepted");
    } catch (error) {
      return { name: error.name, message: error.message, code: error.code };
    }
  });
  assert.deepEqual(outcomes[0], outcomes[1]);
}
const cases = [
  { name: "identity", value: { adapter: "codex", session: "s", root: "/fixture/工作😀" }, calls: 5000 },
  { name: "upstream", value: corpus.at(-1), calls: 5000 },
  { name: "large", value: { text: "x".repeat(131072) }, calls: 100 },
];
for (const c of cases)
  for (let sample = 0; sample <= 12; sample++) {
    const entries = Object.entries(apis);
    if (sample % 2) entries.reverse();
    for (const [variant, run] of entries) {
      let last;
      const before = process.resourceUsage(),
        start = performance.now();
      for (let i = 0; i < c.calls; i++) last = run(c.value);
      const wallMs = (performance.now() - start) / c.calls,
        after = process.resourceUsage(),
        cpuMs = (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000 / c.calls;
      assert.equal(last, apis.baseline(c.value));
      if (sample) results.push({ name: c.name, calls: c.calls, variant, sample, wallMs, cpuMs });
    }
  }
const medians = {};
for (const c of cases)
  for (const variant of Object.keys(apis))
    for (const key of ["wallMs", "cpuMs"]) {
      const s = results
        .filter((r) => r.name === c.name && r.variant === variant)
        .map((r) => r[key])
        .sort((a, b) => a - b);
      medians[`${c.name}-${variant}-${key}`] = (s[5] + s[6]) / 2;
    }
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: 12,
      comparedValues: corpus.length,
      invalidCases: invalid.length,
      variants,
      medians,
      results,
      limitations:
        "Pure public hash helper with representative JSON identities, upstream tuples and 128-KiB payloads; serialized edge values and exception type/code/message compared. Warm modules, no I/O or peak-memory claim. Does not by itself establish end-to-end inbox latency.",
    },
    null,
    2,
  ),
);
