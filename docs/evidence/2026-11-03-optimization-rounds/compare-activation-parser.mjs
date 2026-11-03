import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.argv.length, 3, "Pass saved baseline dist directory.");
const variants = {
  baseline: resolve(process.argv[2]),
  candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
};
const apis = {},
  results = [];
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/activation.js")))).requestedActivation;
const clauses = [
  "启用GitRelay",
  "关闭GitRelay",
  "请使用并行开发",
  "work in parallel",
  "解释GitRelay",
  "不要关闭GitRelay",
  "git-relay",
  "hello",
  "`启用GitRelay`",
  "“关闭GitRelay”",
  "```",
  "~~~",
  "",
  "\t",
];
const corpus = [undefined, null, 1, {}, ...clauses];
for (let i = 0; i < 1024; i++) {
  const indent = " \t ".slice(0, i % 4).repeat(i % 7);
  corpus.push(
    `${clauses[i % clauses.length]}\n${indent}${clauses[(i * 7) % clauses.length]}\n${clauses[(i * 11) % clauses.length]}`,
  );
}
for (const prompt of corpus) assert.equal(apis.candidate(prompt), apis.baseline(prompt), JSON.stringify(prompt));
const cases = [
  { name: "plain-10", calls: 1000, prompt: "Review the existing implementation.\n".repeat(10) },
  { name: "plain-1000", calls: 50, prompt: "Review the existing implementation.\n".repeat(1000) },
  { name: "fenced-1000", calls: 50, prompt: "```text\n" + "  启用GitRelay\n".repeat(1000) + "```\n关闭GitRelay" },
  { name: "indented-1000", calls: 50, prompt: "    quoted example\n".repeat(1000) + "启用GitRelay" },
  { name: "tabs-1000", calls: 50, prompt: "\t\tquoted example\n".repeat(1000) + "关闭GitRelay" },
];
for (const c of cases)
  for (let sample = 0; sample <= 8; sample++) {
    const entries = Object.entries(apis);
    if (sample % 2) entries.reverse();
    for (const [variant, run] of entries) {
      const expected = apis.baseline(c.prompt),
        before = process.resourceUsage(),
        start = performance.now();
      for (let i = 0; i < c.calls; i++) assert.equal(run(c.prompt), expected);
      const wallMs = (performance.now() - start) / c.calls,
        after = process.resourceUsage();
      const cpuMs =
        (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000 / c.calls;
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
      medians[`${c.name}-${variant}-${key}`] = (s[3] + s[4]) / 2;
    }
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: 8,
      comparedPrompts: corpus.length,
      variants,
      medians,
      results,
      limitations:
        "Pure public request parser, synthetic prompt corpus and indentation/fence controls. Wall/Node CPU per call, warmed modules and uncontrolled host load. No I/O, model/native-client latency or peak-memory claim. Equality corpus is bounded, not a general Markdown equivalence proof.",
    },
    null,
    2,
  ),
);
