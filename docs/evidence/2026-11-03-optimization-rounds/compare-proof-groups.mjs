import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  apis[name] = (await import(pathToFileURL(join(path, "core/cleanup.js")))).collectRepository;
const { hash } = await import(pathToFileURL(join(variants.candidate, "core/store.js")));
const { sessionKey } = await import(pathToFileURL(join(variants.candidate, "core/mailbox.js")));
const root = await mkdtemp(join(tmpdir(), "gitrelay-proof-groups-"));
const repo = {
  root,
  common: root,
  directory: root,
  id: hash("repo"),
  identity: hash("identity"),
  identitySource: "external",
};
const identity = { adapter: "benchmark", session: "receiver" },
  ref = "refs/heads/main",
  at = "2020-01-01T00:00:00.000Z",
  key = sessionKey(repo, identity, ref),
  receiptDir = join(root, "receipts", key);
try {
  for (const folder of ["events", "trash", "sessions", "refs", `receipts/${key}`])
    await mkdir(join(root, folder), { recursive: true });
  await writeFile(
    join(root, "sessions", key + ".json"),
    JSON.stringify({ ...identity, key, root, ref, createdAt: at, lastSeen: at, migrated: true }),
  );
  for (const proofs of [0, 1, 1000, 10000]) {
    const id = hash(["event", proofs]),
      event = {
        id,
        kind: "message",
        createdAt: at,
        sender: { adapter: "benchmark", session: "sender", root },
        recipients: [key],
        text: "message",
        files: [],
      };
    const names = Array.from({ length: proofs }, (_, i) => `${id}.${i.toString(16).padStart(64, "0")}.pi-proof`);
    for (let sample = 0; sample <= 8; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        await writeFile(join(root, "events", id + ".json"), JSON.stringify(event));
        await writeFile(join(receiptDir, id + ".json"), JSON.stringify({ eventId: id, status: "delivered", at }));
        for (let offset = 0; offset < names.length; offset += 32)
          await Promise.all(names.slice(offset, offset + 32).map((name) => writeFile(join(receiptDir, name), "proof")));
        const before = process.resourceUsage(),
          start = performance.now(),
          report = await run(repo, { apply: true, retentionDays: 0 }),
          wallMs = performance.now() - start,
          after = process.resourceUsage();
        const cpuMs = (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000;
        assert.deepEqual(report.removed, [id]);
        assert.deepEqual(report.kept, []);
        for (const directory of [receiptDir, join(root, "trash"), join(root, "events")])
          assert.deepEqual(await readdir(directory), []);
        if (sample) results.push({ proofs, variant, sample, wallMs, cpuMs });
      }
    }
  }
  const medians = {};
  for (const proofs of [0, 1, 1000, 10000])
    for (const variant of Object.keys(apis))
      for (const key of ["wallMs", "cpuMs"]) {
        const s = results
          .filter((r) => r.proofs === proofs && r.variant === variant)
          .map((r) => r[key])
          .sort((a, b) => a - b);
        medians[`${proofs}-${variant}-${key}`] = (s[3] + s[4]) / 2;
      }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples: 8,
        variants,
        medians,
        results,
        limitations:
          "Actual GC apply for one migrated recipient with zero/one/many legacy proof filenames. Fresh events/receipts/proofs recreated outside timing. Includes validation, locks, scan, journal and all deletion I/O; exact empty-directory assertions excluded. Warm caches and uncontrolled host load. No peak-memory, physical I/O, cold-cache, Windows or native-client claim.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
