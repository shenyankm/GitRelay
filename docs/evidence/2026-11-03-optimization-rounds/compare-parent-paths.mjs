import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
assert.equal(process.argv.length, 3, "Pass the saved round-26 dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/mailbox.js")))).validateEvent;
const id = "a".repeat(64),
  base = {
    id,
    kind: "message",
    sender: { adapter: "benchmark", session: "sender", root: "/fixture" },
    recipients: [],
    text: "message",
    createdAt: "2020-01-01T00:00:00.000Z",
  };
const outcome = (run, file, posix) => {
  try {
    return {
      accepted: true,
      files: run({ ...base, files: [file], ...(posix ? { pathFormat: "posix-v1" } : {}) }, id, posix).files,
    };
  } catch (error) {
    return { accepted: false, error: error.message };
  }
};
let compared = 0;
let level = [""];
const alphabet = [".", "/", "\\", "a", "\n", "\r"];
for (let depth = 0; depth <= 6; depth++) {
  for (const file of level)
    for (const posix of [false, true]) {
      assert.deepEqual(
        outcome(apis.candidate, file, posix),
        outcome(apis.baseline, file, posix),
        JSON.stringify({ file, posix }),
      );
      compared++;
    }
  if (depth < 6) level = level.flatMap((prefix) => alphabet.map((char) => prefix + char));
}
for (const file of ["..\u2028", "..\u2029", "é/..\n", "😀/../x", "\ud800/..", "x\\..\\file", "\ufeff/..", "x/..\r\n"])
  for (const posix of [false, true]) {
    assert.deepEqual(outcome(apis.candidate, file, posix), outcome(apis.baseline, file, posix));
    compared++;
  }
const results = [];
for (const count of [1, 1000])
  for (const posix of [false, true]) {
    const files = Array.from({ length: count }, (_, i) => `src/dir-${i % 100}/file-${i}.ts`),
      event = { ...base, files, ...(posix ? { pathFormat: "posix-v1" } : {}) };
    for (let sample = 0; sample < 13; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const usage = process.resourceUsage(),
          start = performance.now();
        for (let repeat = 0; repeat < 500; repeat++) assert.deepEqual(run({ ...event }, id, posix).files, files);
        const wallMs = (performance.now() - start) / 500,
          after = process.resourceUsage(),
          cpuMs = (after.userCPUTime + after.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 500000;
        if (sample) results.push({ count, posix, variant, sample, wallMs, cpuMs });
      }
    }
  }
const medians = {};
for (const count of [1, 1000])
  for (const posix of [false, true])
    for (const variant of Object.keys(apis))
      for (const key of ["wallMs", "cpuMs"]) {
        const s = results
          .filter((r) => r.count === count && r.posix === posix && r.variant === variant)
          .map((r) => r[key])
          .toSorted((a, b) => a - b);
        medians[`${count}-${posix}-${variant}-${key}`] = (s[5] + s[6]) / 2;
      }
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: 12,
      callsPerSample: 500,
      variants,
      comparedOutcomes: compared,
      naiveEndAnchorCounterexample: {
        file: "..\n",
        oldParentRule: "..\n".split("/").includes(".."),
        naiveParentRule: /(?:^|\/)\.\.(?:\/|$)/.test("..\n"),
      },
      medians,
      results,
      limitations:
        "Public event validation, including JSON payload checks, normalization and assertions, not send/consume I/O. Exhaustive short-component corpus plus Unicode/surrogate cases; warm V8 and uncontrolled host load. No peak memory, filesystem, native-client or cold-start comparison.",
    },
    null,
    2,
  ),
);
