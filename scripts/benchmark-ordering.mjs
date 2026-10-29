import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hash, withLock } from "../dist/core/store.js";

const [baseline, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, "Usage: node scripts/benchmark-ordering.mjs [baseline-dist-directory]");
const variants = {
  ...(baseline ? { baseline: resolve(baseline) } : {}),
  candidate: fileURLToPath(new URL("../dist/", import.meta.url)),
};
const apis = {};
for (const [name, directory] of Object.entries(variants))
  apis[name] = await import(pathToFileURL(join(directory, "core/mailbox.js")));
const temporary = await mkdtemp(join(tmpdir(), "git-relay-order-bench-"));
const key = hash("receiver"),
  ref = "refs/heads/main",
  results = [];
const commit = (index) => hash(["commit", index]).slice(0, 40);
try {
  for (const workload of ["rollback", "linear"]) {
    const directory = join(temporary, workload),
      receipts = join(directory, "receipts", key);
    for (const folder of ["events", "trash", "sessions", `receipts/${key}`])
      await mkdir(join(directory, folder), { recursive: true });
    const ids = [];
    for (const count of [100, 1000, 2000]) {
      while (ids.length < count) {
        const index = ids.length;
        const previous = commit(index ? (workload === "rollback" ? (index - 1) % 2 : index - 1) : -1);
        const current = commit(workload === "rollback" ? index % 2 : index);
        const id = hash(["upstream", ref, previous, current, index ? ids.at(-1) : `migration:${key}`]);
        await writeFile(
          join(directory, "events", `${id}.json`),
          JSON.stringify({
            id,
            kind: "upstream",
            ref,
            previous,
            commit: current,
            createdAt: new Date(1_700_000_000_000 - index).toISOString(),
            sender: { adapter: "benchmark", session: "sender", root: directory },
            recipients: [key],
          }),
        );
        ids.push(id);
      }
      for (let sample = 0; sample <= 5; sample++) {
        const entries = Object.entries(apis);
        if (sample % 2) entries.reverse();
        for (const [name, api] of entries) {
          const cpu = process.cpuUsage(),
            start = performance.now();
          const events = await withLock(join(directory, "sessions", `${key}.lock`), () =>
            api.eventsIn({ directory }, key),
          );
          const wallMs = performance.now() - start,
            used = process.cpuUsage(cpu);
          assert.deepEqual(
            events.map((event) => event.id),
            ids,
            "Causal order must survive reversed timestamps and repeated commits",
          );
          if (sample)
            results.push({ name, workload, events: count, sample, wallMs, cpuMs: (used.user + used.system) / 1000 });
        }
      }
      assert.deepEqual(await readdir(receipts), [], "Scanning must not acknowledge events");
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = [];
  for (const name of Object.keys(apis))
    for (const workload of ["rollback", "linear"])
      for (const events of [100, 1000, 2000]) {
        const rows = results.filter((row) => row.name === name && row.workload === workload && row.events === events);
        medians.push({
          name,
          workload,
          events,
          wallMs: median(rows.map((row) => row.wallMs)),
          cpuMs: median(rows.map((row) => row.cpuMs)),
        });
      }
  console.log(
    JSON.stringify({
      environment: { node: process.version, platform: platform(), arch: arch() },
      variants,
      samples: 5,
      medians,
      results,
      workload:
        "Synthetic valid upstream event chains with an initial legacy migration; repeated two-commit rollbacks and a linear-history control; reversed timestamps; same real state files, held session lock, one warm-up and setup excluded; alternating variants",
      limitations:
        "Warm local caches and uncontrolled external load. Measures locked inbox scanning and ordering, not Git history comparison, full backlog delivery, native-client latency, cold caches, network filesystems or per-variant peak memory.",
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
