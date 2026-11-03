import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass the saved round-22 dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/repository.js")))).repository;
const root = await mkdtemp(join(tmpdir(), "gitrelay-owner-reads-")),
  cwd = join(root, "repo"),
  nested = join(cwd, "nested"),
  template = join(root, "template"),
  prior = process.env.WORKTREE_SYNC_STATE_DIR,
  results = [];
process.env.WORKTREE_SYNC_STATE_DIR = join(root, "state");
try {
  await mkdir(cwd);
  await mkdir(nested);
  await mkdir(template);
  execFileSync("git", ["-C", cwd, "init", "--template", template, "-b", "main"], { stdio: "pipe" });
  const expected = await apis.baseline(cwd),
    ready = await readFile(join(expected.directory, "identity-ready.json")),
    owner = await readFile(join(expected.directory, "identity-owner.json"));
  for (const workload of ["root", "nested"])
    for (let sample = 0; sample < 13; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, run] of entries) {
        const usage = process.resourceUsage(),
          start = performance.now();
        for (let i = 0; i < 10; i++) assert.deepEqual(await run(workload === "root" ? cwd : nested), expected);
        const wallMs = (performance.now() - start) / 10,
          after = process.resourceUsage(),
          cpuMs = (after.userCPUTime + after.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 10000;
        if (sample) results.push({ workload, variant, sample, wallMs, cpuMs });
      }
    }
  assert.deepEqual(await readFile(join(expected.directory, "identity-ready.json")), ready);
  assert.deepEqual(await readFile(join(expected.directory, "identity-owner.json")), owner);
  const medians = {};
  for (const workload of ["root", "nested"])
    for (const variant of Object.keys(apis))
      for (const key of ["wallMs", "cpuMs"]) {
        const s = results
          .filter((r) => r.workload === workload && r.variant === variant)
          .map((r) => r[key])
          .toSorted((a, b) => a - b);
        medians[`${workload}-${variant}-${key}`] = (s[5] + s[6]) / 2;
      }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples: 12,
        callsPerSample: 10,
        variants,
        medians,
        results,
        limitations:
          "Full repository discovery/identity lock and existing-state validation from root or nested cwd, not just two JSON reads. Warm local caches, setup excluded; exact returned identity/state bytes asserted. Uncontrolled host load, no cold cache, Windows, network filesystem, peak memory or native-client comparison.",
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
