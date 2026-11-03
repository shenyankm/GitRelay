import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const [baseline, mode] = process.argv.slice(2);
assert.ok(
  baseline && ["recipients", "migration"].includes(mode) && process.argv.length === 4,
  "Pass baseline dist and recipients|migration.",
);
const variants = { baseline: resolve(baseline), candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)) },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/cleanup.js")))).collectRepository;
const { sessionKey } = await import(pathToFileURL(join(variants.candidate, "core/mailbox.js")));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  root = await mkdtemp(join(tmpdir(), "gitrelay-gc-receipts-")),
  results = [];
const repo = {
    root,
    common: root,
    directory: root,
    id: hash("repo"),
    identity: hash("identity"),
    identitySource: "external",
  },
  ref = "refs/heads/main",
  at = "2020-01-01T00:00:00.000Z";
const cases =
  mode === "recipients"
    ? [
        { name: "empty", events: 0, recipients: 0 },
        { name: "one", events: 1, recipients: 1 },
        ...["ready", "missing-first", "legacy-first"].flatMap((name) =>
          [32, 1000].map((recipients) => ({ name: `${name}-${recipients}`, events: 1, recipients, state: name })),
        ),
      ]
    : [
        { name: "legacy-100", events: 100, recipients: 1, state: "legacy-first" },
        { name: "legacy-1000", events: 1000, recipients: 1, state: "legacy-first" },
        { name: "ready-1000", events: 1000, recipients: 1, state: "ready" },
      ];
try {
  for (const workload of cases) {
    for (const folder of ["events", "trash", "sessions", "refs", "receipts"])
      await mkdir(join(root, folder), { recursive: true });
    const keys = [];
    for (let i = 0; i < workload.recipients; i++) {
      const identity = { adapter: "benchmark", session: `receiver-${i}` },
        key = sessionKey(repo, identity, ref);
      keys.push(key);
      await mkdir(join(root, "receipts", key));
      await writeFile(
        join(root, "sessions", key + ".json"),
        JSON.stringify({
          ...identity,
          key,
          root,
          ref,
          createdAt: at,
          lastSeen: at,
          migrated: !(i === 0 && workload.state === "legacy-first"),
        }),
      );
    }
    const ids = [];
    for (let i = 0; i < workload.events; i++) {
      const id = hash(["event", workload.name, i]);
      ids.push(id);
      await writeFile(
        join(root, "events", id + ".json"),
        JSON.stringify({
          id,
          kind: "message",
          createdAt: at,
          sender: { adapter: "benchmark", session: "sender", root },
          recipients: keys,
          text: "message",
          files: [],
        }),
      );
      for (let offset = 0; offset < keys.length; offset += 32)
        await Promise.all(
          keys.slice(offset, offset + 32).map(async (key, j) => {
            if (offset + j === 0 && workload.state === "missing-first") return;
            await writeFile(
              join(root, "receipts", key, id + ".json"),
              JSON.stringify({ eventId: id, status: "delivered", at }),
            );
          }),
        );
    }
    ids.sort();
    const blocked = workload.state === "missing-first" || workload.state === "legacy-first";
    for (let sample = 0; sample < 13; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const start = performance.now(),
          report = await run(repo, { apply: false, retentionDays: 0 }),
          wallMs = performance.now() - start;
        assert.deepEqual(report.removed, []);
        assert.deepEqual(report.eligible.toSorted(), blocked ? [] : ids);
        assert.deepEqual(report.kept.map((e) => e.id).toSorted(), blocked ? ids : []);
        assert.ok(
          report.kept.every((e) => e.reason === (workload.state === "missing-first" ? "unconfirmed" : "migration")),
        );
        if (sample) results.push({ workload: workload.name, variant, sample, wallMs });
      }
    }
    assert.equal((await readdir(join(root, "events"))).length, workload.events);
    for (const folder of ["events", "trash", "sessions", "refs", "receipts"])
      await rm(join(root, folder), { recursive: true });
  }
  const medians = {};
  for (const workload of cases)
    for (const variant of Object.keys(apis)) {
      const s = results
        .filter((r) => r.workload === workload.name && r.variant === variant)
        .map((r) => r.wallMs)
        .toSorted((a, b) => a - b);
      medians[`${workload.name}-${variant}`] = (s[5] + s[6]) / 2;
    }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        mode,
        samples: 12,
        variants,
        medians,
        results,
        limitations:
          "Synthetic GC dry-runs with valid per-session receipts, migrated/legacy metadata and an early missing-receipt control. Warm local cache; setup/assertions excluded; uncontrolled host load. No deletion throughput, near-limit peak memory, cold caches, Windows or real-client latency.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
