import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  apis[name] = (await import(pathToFileURL(join(path, "core/changes.js")))).pathMatcher;
const root = await mkdtemp(join(tmpdir(), "gitrelay-matcher-queries-"));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
const queries = [
  ".",
  "src/",
  "SRC/Dir-0/file-0.ts",
  "src/dir-0/file-0.ts",
  "SRC/Dir-0",
  "embedded/child",
  "Éclair/工作😀",
  ...Array.from({ length: 1000 }, (_, i) => `${"absent/".repeat((i % 32) + 1)}file-${i}.ts`),
];
try {
  git("init", "-b", "main");
  for (const ignoreCase of [false, true])
    for (const count of [0, 1, 1000]) {
      git("config", "core.ignorecase", String(ignoreCase));
      const files = new Set(Array.from({ length: count }, (_, i) => `SRC/Dir-${i % 100}/file-${i}.ts`));
      if (count) files.add("embedded/");
      const matches = {};
      for (const [name, run] of Object.entries(apis)) matches[name] = await run(root, files);
      for (const q of queries) assert.equal(matches.candidate(q), matches.baseline(q), q);
      assert.throws(() => matches.candidate(null), TypeError);
      const calls = 10000,
        expected = Array.from({ length: calls }, (_, i) =>
          matches.baseline(queries[i % queries.length]) ? 1 : 0,
        ).reduce((a, b) => a + b, 0);
      for (let sample = 0; sample <= 12; sample++) {
        const entries = Object.entries(matches);
        if (sample % 2) entries.reverse();
        for (const [variant, match] of entries) {
          let total = 0;
          const before = process.resourceUsage(),
            start = performance.now();
          for (let i = 0; i < calls; i++) if (match(queries[i % queries.length])) total++;
          const wallMs = (performance.now() - start) / calls,
            after = process.resourceUsage(),
            cpuMs =
              (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000 / calls;
          assert.equal(total, expected);
          if (sample) results.push({ ignoreCase, count, calls, variant, sample, wallMs, cpuMs });
        }
      }
    }
  const medians = {};
  for (const ignoreCase of [false, true])
    for (const count of [0, 1, 1000])
      for (const variant of Object.keys(apis))
        for (const key of ["wallMs", "cpuMs"]) {
          const s = results
            .filter((r) => r.ignoreCase === ignoreCase && r.count === count && r.variant === variant)
            .map((r) => r[key])
            .sort((a, b) => a - b);
          medians[`${ignoreCase}-${count}-${variant}-${key}`] = (s[5] + s[6]) / 2;
        }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples: 12,
        queries: queries.length,
        variants,
        medians,
        results,
        limitations:
          "Pure query callbacks from public pathMatcher after real Git ignorecase configuration. Empty/single/1,000-path controls, Unicode, nested absent paths and invalid-input guard. Setup, matcher construction and assertions excluded. Warm modules; no complete inbox, physical I/O, peak-memory or real-client latency claim.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
