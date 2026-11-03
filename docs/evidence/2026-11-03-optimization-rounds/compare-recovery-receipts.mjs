import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass the saved round-18 dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/mailbox.js")))).publishUpstream;
const { withLock } = await import(pathToFileURL(join(variants.candidate, "core/store.js")));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const root = await mkdtemp(join(tmpdir(), "gitrelay-recovery-receipts-")),
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
  previous = "a".repeat(40),
  commit = "b".repeat(40),
  id = hash(["upstream", ref, previous, commit, ""]),
  sender = { adapter: "benchmark", session: "sender", root };
try {
  for (const name of ["events", "trash", "receipts"]) await mkdir(join(root, name));
  await withLock(join(root, "publish.lock"), async () => {
    for (const count of [0, 1, 32, 1000]) {
      const recipients = Array.from({ length: count }, (_, i) => hash(["recipient", i]));
      for (let offset = 0; offset < count; offset += 32)
        await Promise.all(
          recipients.slice(offset, offset + 32).map(async (key) => {
            await mkdir(join(root, "receipts", key), { recursive: true });
            await writeFile(
              join(root, "receipts", key, id + ".json"),
              JSON.stringify({ eventId: id, status: "delivered", at: "2020-01-01T00:00:00.000Z" }),
            );
          }),
        );
      const content = JSON.stringify({
          id,
          kind: "upstream",
          ref,
          previous,
          commit,
          sender,
          recipients,
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
        trash = join(root, "trash", id + ".json"),
        path = join(root, "events", id + ".json");
      for (let sample = 0; sample < 13; sample++) {
        const entries = Object.entries(apis);
        if (sample % 2) entries.reverse();
        for (const [variant, run] of entries) {
          await rm(path, { force: true });
          await writeFile(trash, content);
          const start = performance.now(),
            event = await run(repo, sender, ref, previous, commit, recipients),
            wallMs = performance.now() - start;
          assert.deepEqual(event.recipients, recipients);
          assert.equal(await readFile(path, "utf8"), content);
          await assert.rejects(access(trash), { code: "ENOENT" });
          if (sample) results.push({ count, variant, sample, wallMs });
        }
      }
    }
  });
  const medians = {};
  for (const count of [0, 1, 32, 1000])
    for (const variant of Object.keys(apis)) {
      const s = results
        .filter((r) => r.count === count && r.variant === variant)
        .map((r) => r.wallMs)
        .toSorted((a, b) => a - b);
      medians[`${count}-${variant}`] = (s[5] + s[6]) / 2;
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
          "Synthetic valid trash journals and receipts; publication lock held throughout. Warm local caches, setup/assertions excluded, uncontrolled host load. No near-limit memory, cold-cache, Windows, concurrent-writer or real-client comparison.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
