import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass saved pre-change dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/mailbox.js")))).eventsIn;
const root = await mkdtemp(join(tmpdir(), "gitrelay-path-scan-")),
  results = [],
  hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const repo = {
  root,
  common: root,
  directory: root,
  id: hash("repo"),
  identity: hash("identity"),
  identitySource: "external",
};
try {
  for (const folder of ["events", "trash"]) await mkdir(join(root, folder));
  for (const [count, paths] of [
    [0, 0],
    [1000, 0],
    [10000, 0],
    [500, 1000],
  ]) {
    const files = Array.from({ length: paths }, (_, i) => `src/dir-${i % 100}/file-${i}.ts`),
      ids = [];
    for (let offset = 0; offset < count; offset += 32)
      await Promise.all(
        Array.from({ length: Math.min(32, count - offset) }, async (_, j) => {
          const id = hash(["event", offset + j]);
          ids.push(id);
          await writeFile(
            join(root, "events", id + ".json"),
            JSON.stringify({
              id,
              kind: "message",
              createdAt: "2020-01-01T00:00:00.000Z",
              sender: { adapter: "benchmark", session: "sender", root },
              recipients: [],
              text: "message",
              files,
            }),
          );
        }),
      );
    ids.sort();
    for (let sample = 0; sample < 13; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const usage = process.resourceUsage(),
          start = performance.now(),
          events = await run(repo),
          wallMs = performance.now() - start,
          after = process.resourceUsage(),
          cpuMs = (after.userCPUTime + after.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 1000;
        assert.deepEqual(
          events.map((e) => e.id),
          ids,
        );
        for (const event of events) assert.deepEqual(event.files, files);
        if (sample) results.push({ count, paths, variant, sample, wallMs, cpuMs });
      }
    }
    await rm(join(root, "events"), { recursive: true });
    await mkdir(join(root, "events"));
  }
  const medians = {};
  for (const [count, paths] of [
    [0, 0],
    [1000, 0],
    [10000, 0],
    [500, 1000],
  ])
    for (const variant of Object.keys(apis))
      for (const key of ["wallMs", "cpuMs"]) {
        const s = results
          .filter((r) => r.count === count && r.paths === paths && r.variant === variant)
          .map((r) => r[key])
          .toSorted((a, b) => a - b);
        medians[`${count}-${paths}-${variant}-${key}`] = (s[5] + s[6]) / 2;
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
          "Actual event files; empty/1,000/10,000 empty-file-list controls and 500 thousand-path events. Warm local caches, setup/assertions excluded; uncontrolled host load. Node CPU excludes children. No delivery, lock contention, peak-RSS, cold-cache, Windows or native-client latency comparison.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
