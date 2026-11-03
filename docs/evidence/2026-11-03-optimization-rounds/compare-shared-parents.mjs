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
  apis[name] = (await import(pathToFileURL(join(path, "core/mailbox.js")))).eventsIn;
const { hash, withLock } = await import(pathToFileURL(join(variants.candidate, "core/store.js")));
const root = await mkdtemp(join(tmpdir(), "gitrelay-shared-parents-")),
  key = hash("receiver"),
  ref = "refs/heads/main",
  previous = hash("previous").slice(0, 40),
  commit = hash("commit").slice(0, 40);
const sender = { adapter: "benchmark", session: "sender", root };
try {
  for (const count of [1, 32, 1000]) {
    const directory = join(root, String(count)),
      receiptDir = join(directory, "receipts", key);
    for (const folder of ["events", "trash", "sessions", `receipts/${key}`])
      await mkdir(join(directory, folder), { recursive: true });
    const parents = Array.from({ length: count }, (_, i) => {
      const recipient = hash(["migration", i]);
      return {
        id: hash(["upstream", ref, previous, commit, `migration:${recipient}`]),
        kind: "upstream",
        ref,
        previous,
        commit,
        createdAt: "2020-01-02T00:00:00.000Z",
        sender,
        recipients: [recipient],
      };
    });
    const children = Array.from({ length: count }, (_, i) => {
      const next = hash(["next", i]).slice(0, 40);
      return {
        id: hash(["upstream", ref, commit, next, ""]),
        kind: "upstream",
        ref,
        previous: commit,
        commit: next,
        createdAt: "2020-01-01T00:00:00.000Z",
        sender,
        recipients: [key],
      };
    });
    const events = [...parents, ...children];
    for (let offset = 0; offset < events.length; offset += 32)
      await Promise.all(
        events
          .slice(offset, offset + 32)
          .map((e) => writeFile(join(directory, "events", e.id + ".json"), JSON.stringify(e))),
      );
    const expected = [...parents, ...children].map((e) => e.id),
      sorted = (items) => items.map((e) => e.id).sort((a, b) => a.localeCompare(b));
    const order = [...sorted(parents), ...sorted(children)];
    for (let sample = 0; sample <= 8; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const before = process.resourceUsage(),
          start = performance.now();
        const output = await withLock(join(directory, "sessions", key + ".lock"), () => run({ directory }, key));
        const wallMs = performance.now() - start,
          after = process.resourceUsage(),
          cpuMs = (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000;
        assert.deepEqual(
          output.map((e) => e.id),
          order,
        );
        assert.deepEqual(output.map((e) => e.id).sort(), expected.toSorted());
        assert.deepEqual(await readdir(receiptDir), []);
        if (sample) results.push({ count, events: count * 2, edges: count * count, variant, sample, wallMs, cpuMs });
      }
    }
  }
  const medians = {};
  for (const count of [1, 32, 1000])
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
        variants,
        medians,
        results,
        limitations:
          "Synthetic valid migration fan-in: N migration events share a commit and N ordinary children each require all migration parents. Same actual state files, session lock and exact causal ordering; receipt directory remains empty. Warm caches and uncontrolled host load. Measures inbox scan and ordering, not native Git traversal, delivery, cold caches, physical I/O or peak memory. Million-edge case is a stress workload.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
