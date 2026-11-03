import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  apis[name] = (await import(pathToFileURL(join(path, "core/mailbox.js")))).sessionsIn;
const { hash } = await import(pathToFileURL(join(variants.candidate, "core/store.js"))),
  { sessionKey } = await import(pathToFileURL(join(variants.candidate, "core/mailbox.js")));
const root = await mkdtemp(join(tmpdir(), "gitrelay-session-batches-")),
  repo = {
    root,
    common: root,
    directory: root,
    id: hash("repo"),
    identity: hash("identity"),
    identitySource: "external",
  },
  at = "2020-01-01T00:00:00.000Z",
  ref = "refs/heads/main",
  keys = [];
try {
  await mkdir(join(root, "sessions"));
  for (const count of [0, 1, 32, 1000, 10000]) {
    while (keys.length < count) {
      const amount = Math.min(32, count - keys.length),
        offset = keys.length;
      await Promise.all(
        Array.from({ length: amount }, async (_, j) => {
          const identity = { adapter: "benchmark", session: `receiver-${offset + j}` },
            key = sessionKey(repo, identity, ref);
          keys.push(key);
          await writeFile(
            join(root, "sessions", key + ".json"),
            JSON.stringify({ ...identity, key, root, ref, createdAt: at, lastSeen: at, migrated: true }),
          );
        }),
      );
    }
    const expected = keys.toSorted();
    for (let sample = 0; sample <= 12; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const before = process.resourceUsage(),
          start = performance.now(),
          sessions = await run(repo),
          wallMs = performance.now() - start,
          after = process.resourceUsage(),
          cpuMs = (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000;
        assert.deepEqual(
          sessions.map((s) => s.key),
          expected,
        );
        if (sample) results.push({ count, variant, sample, wallMs, cpuMs });
      }
    }
  }
  const medians = {};
  for (const count of [0, 1, 32, 1000, 10000])
    for (const variant of Object.keys(apis))
      for (const key of ["wallMs", "cpuMs"]) {
        const s = results
          .filter((r) => r.count === count && r.variant === variant)
          .map((r) => r[key])
          .sort((a, b) => a - b);
        medians[`${count}-${variant}-${key}`] = (s[5] + s[6]) / 2;
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
          "Public sessionsIn scan of actual valid session files, including empty/single/32 controls and 1,000/10,000 records. Exact enumeration order/keys verified. Warm local caches; setup/assertions excluded. No peak-memory, physical I/O, cold-cache or native-client claim.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
