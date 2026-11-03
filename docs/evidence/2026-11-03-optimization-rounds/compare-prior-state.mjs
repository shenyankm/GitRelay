import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  apis[name] = (await import(pathToFileURL(join(path, "core/repository.js")))).priorRepositories;
const { hash, withLock } = await import(pathToFileURL(join(variants.candidate, "core/store.js")));
const root = await mkdtemp(join(tmpdir(), "gitrelay-prior-state-")),
  prior = process.env.WORKTREE_SYNC_STATE_DIR,
  results = [];
process.env.WORKTREE_SYNC_STATE_DIR = root;
const repo = {
    root,
    common: root,
    directory: root,
    id: hash("current"),
    identity: hash("identity"),
    identitySource: "external",
  },
  history = join(root, "identity-history", hash(root)),
  repos = join(root, "repos");
try {
  for (const count of [0, 1, 32, 1000]) {
    await mkdir(history, { recursive: true });
    await mkdir(repos, { recursive: true });
    await mkdir(join(repos, hash(root)));
    const existing = new Set([hash(root)]);
    for (let i = 0; i < count; i++) {
      const id = createHash("sha256").update(String(i)).digest("hex");
      await writeFile(join(history, id), "");
      if (i % 3 === 0) {
        await mkdir(join(repos, id));
        existing.add(id);
      } else if (i % 3 === 1) {
        await writeFile(join(repos, id), "preserve malformed state");
        existing.add(id);
      }
    }
    await writeFile(join(history, "invalid-name"), "");
    await writeFile(join(history, repo.id), "");
    await mkdir(join(repos, repo.id));
    const order = [...new Set([hash(root), ...(await readdir(history))])].filter((id) => existing.has(id));
    await withLock(join(root, "identity.lock"), async () => {
      for (let sample = 0; sample < 13; sample++) {
        const entries = Object.entries(apis);
        if (sample % 2) entries.reverse();
        for (const [variant, run] of entries) {
          const start = performance.now(),
            found = await run(repo),
            wallMs = performance.now() - start;
          assert.deepEqual(found, order);
          if (sample) results.push({ count, variant, sample, wallMs });
        }
      }
    });
    await rm(join(root, "identity-history"), { recursive: true });
    await rm(repos, { recursive: true });
  }
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
          "Synthetic identity-history entries with present directories/files and absent states. Exact source-directory order preserved; current/invalid IDs excluded. Identity lock held. Warm caches, setup/assertions excluded, uncontrolled host load. No cold cache, Windows, concurrent identity changes or real-client latency.",
      },
      null,
      2,
    ),
  );
} finally {
  if (prior === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
  else process.env.WORKTREE_SYNC_STATE_DIR = prior;
  await rm(root, { recursive: true, force: true });
}
