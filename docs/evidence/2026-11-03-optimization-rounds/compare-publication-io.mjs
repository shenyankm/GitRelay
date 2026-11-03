import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass the saved round-15 dist directory.");
const variants = {
  baseline: resolve(process.argv[2]),
  candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
};
const apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/mailbox.js")))).publishUpstream;
const { withLock } = await import(pathToFileURL(join(variants.candidate, "core/store.js")));
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const root = await mkdtemp(join(tmpdir(), "gitrelay-publication-io-"));
const repo = {
    root,
    common: root,
    directory: root,
    id: hash("repo"),
    identity: hash("identity"),
    identitySource: "external",
  },
  sender = { adapter: "benchmark", session: "sender", root },
  ref = "refs/heads/main",
  previous = "a".repeat(40),
  commit = "b".repeat(40),
  recipients = Array.from({ length: 10 }, (_, i) => hash(["recipient", i]));
const results = [];
try {
  for (const name of ["events", "trash", "receipts"]) await mkdir(join(root, name));
  await withLock(join(root, "publish.lock"), async () => {
    for (const workload of ["existing", "new"]) {
      const fixedId = hash(["upstream", ref, previous, commit, ""]);
      await writeFile(
        join(root, "events", fixedId + ".json"),
        JSON.stringify({
          id: fixedId,
          kind: "upstream",
          ref,
          previous,
          commit,
          sender,
          recipients,
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      for (let sample = 0; sample < 13; sample++) {
        const entries = Object.entries(apis);
        if (sample % 2) entries.reverse();
        for (const [variant, run] of entries) {
          const start = performance.now();
          for (let call = 0; call < 100; call++) {
            const salt = workload === "existing" ? "" : `${sample}-${variant}-${call}`;
            const event = await run(repo, sender, ref, previous, commit, recipients, salt);
            assert.equal(event.id, hash(["upstream", ref, previous, commit, salt]));
            assert.equal(event.kind, "upstream");
            assert.deepEqual(event.recipients, recipients);
            assert.equal(event.previous, previous);
            assert.equal(event.commit, commit);
          }
          const wallMs = (performance.now() - start) / 100;
          if (sample) results.push({ workload, variant, sample, wallMs });
        }
      }
    }
    const medians = {};
    for (const workload of ["existing", "new"])
      for (const variant of Object.keys(apis)) {
        const s = results
          .filter((r) => r.workload === workload && r.variant === variant)
          .map((r) => r.wallMs)
          .toSorted((a, b) => a - b);
        medians[`${workload}-${variant}`] = (s[5] + s[6]) / 2;
      }
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          samples: 12,
          callsPerSample: 100,
          variants,
          medians,
          results,
          limitations:
            "In-process publication with publication lock held throughout all samples, no contention; existing events reuse ten recipients; new publications have unique salts. Warm filesystem caches and uncontrolled host load. Includes equality assertions, excludes setup. No cold-cache, peak-RSS, Windows, concurrent-writer or native-client latency comparison.",
        },
        null,
        2,
      ),
    );
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
