import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  apis[name] = (await import(pathToFileURL(join(path, "core/changes.js")))).pathMatcher;
const root = await mkdtemp(join(tmpdir(), "gitrelay-matcher-perf-"));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
const results = [];
try {
  git("init", "-b", "main");
  for (const ignoreCase of [false, true])
    for (const count of [1000, 100000]) {
      git("config", "core.ignorecase", String(ignoreCase));
      const files = new Set(Array.from({ length: count }, (_, i) => `SRC/Dir-${i % 100}/file-${i}.ts`));
      files.add("embedded/");
      for (let sample = 0; sample < 13; sample++) {
        const entries = Object.entries(apis);
        if (sample % 2) entries.reverse();
        for (const [variant, run] of entries) {
          const usage = process.resourceUsage(),
            start = performance.now(),
            match = await run(root, files),
            wallMs = performance.now() - start,
            after = process.resourceUsage(),
            cpuMs = (after.userCPUTime + after.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 1000;
          assert.equal(match("SRC/Dir-0/file-0.ts"), true);
          assert.equal(match("SRC/Dir-0"), true);
          assert.equal(match("embedded/nested/file"), true);
          assert.equal(match("src/dir-0/file-0.ts"), ignoreCase);
          assert.equal(match("absent"), false);
          assert.equal(match("SRC/"), false);
          assert.equal(match("."), false);
          if (sample) results.push({ ignoreCase, count, variant, sample, wallMs, cpuMs });
        }
      }
    }
  const medians = {};
  for (const ignoreCase of [false, true])
    for (const count of [1000, 100000])
      for (const variant of Object.keys(apis))
        for (const key of ["wallMs", "cpuMs"]) {
          const s = results
            .filter((r) => r.ignoreCase === ignoreCase && r.count === count && r.variant === variant)
            .map((r) => r[key])
            .toSorted((a, b) => a - b);
          medians[`${ignoreCase}-${count}-${variant}-${key}`] = (s[5] + s[6]) / 2;
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
          "Synthetic path sets with real Git ignorecase configuration; setup/assertions excluded. Warm local caches and uncontrolled host load. Node CPU excludes Git children. No allocation, peak-RSS, cold-cache, Windows or native-client latency comparison.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
