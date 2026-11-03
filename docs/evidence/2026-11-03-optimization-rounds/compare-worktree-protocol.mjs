import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass the saved pre-change dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = await import(pathToFileURL(join(path, "core/git.js")));
const root = await mkdtemp(join(tmpdir(), "gitrelay-worktree-protocol-")),
  bin = join(root, "bin"),
  payload = join(root, "output"),
  results = [],
  allocations = [];
const args = ["worktree", "list", "--porcelain", "-z"],
  options = { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_RELAY_WORKTREE_OUTPUT: payload } },
  sha = "a".repeat(40);
const run = async (api) => api.parseWorktrees(await api.git(root, args, undefined, "worktree-records", options));
try {
  await mkdir(bin);
  await writeFile(join(bin, "git"), '#!/bin/sh\nexec /bin/cat "$GIT_RELAY_WORKTREE_OUTPUT"\n', { mode: 0o755 });
  await writeFile(payload, Buffer.concat([Buffer.from("worktree /bad-"), Buffer.from([255]), Buffer.from("\0\0")]));
  for (const api of Object.values(apis)) await assert.rejects(run(api), /not valid UTF-8/);
  await writeFile(payload, Buffer.from("\ufeff/fixture/root\n"));
  for (const api of Object.values(apis))
    assert.equal(
      await api.git(root, ["rev-parse", "--show-toplevel"], undefined, "paths", options),
      "\ufeff/fixture/root\n",
    );
  for (const count of [0, 1, 1000, 10000]) {
    const expected = Array.from({ length: count }, (_, i) => ({
      path: `/fixture/工作/😀/tree-${i}`,
      head: sha,
      branch: `topic-${i}`,
      locked: "note-�",
    }));
    await writeFile(
      payload,
      Buffer.concat(
        expected.map((e) =>
          Buffer.concat([
            Buffer.from(`worktree ${e.path}\0HEAD ${sha}\0branch refs/heads/${e.branch}\0locked note-`),
            Buffer.from([255]),
            Buffer.from("\0\0"),
          ]),
        ),
      ),
    );
    for (let sample = 0; sample < 13; sample++) {
      const entries = Object.entries(apis);
      if (sample % 2) entries.reverse();
      for (const [variant, api] of entries) {
        const usage = process.resourceUsage(),
          start = performance.now(),
          trees = await run(api),
          wallMs = performance.now() - start,
          after = process.resourceUsage(),
          cpuMs = (after.userCPUTime + after.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 1000;
        assert.deepEqual(trees, expected);
        if (sample) results.push({ count, variant, sample, wallMs, cpuMs });
      }
    }
    for (const [variant, api] of Object.entries(apis)) {
      const original = Buffer.from;
      let calls = 0,
        bytes = 0;
      Buffer.from = function (value, ...rest) {
        const buffer = original(value, ...rest);
        if (value === "worktree " || value === "branch ") {
          calls++;
          bytes += buffer.length;
        }
        return buffer;
      };
      try {
        assert.deepEqual(await run(api), expected);
      } finally {
        Buffer.from = original;
      }
      allocations.push({ count, variant, prefixCalls: calls, prefixBytes: bytes });
    }
  }
  const medians = {};
  for (const count of [0, 1, 1000, 10000])
    for (const variant of Object.keys(apis))
      for (const key of ["wallMs", "cpuMs"]) {
        const s = results
          .filter((r) => r.count === count && r.variant === variant)
          .map((r) => r[key])
          .toSorted((a, b) => a - b);
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
        allocations,
        results,
        limitations:
          "Synthetic porcelain byte stream emitted by a local cat shim, including invalid free-text UTF-8, valid Unicode paths, and bad-path then valid-BOM recovery. Measures subprocess read + validation/parsing, not real Git worktree discovery. Warm local caches, uncontrolled host load. Allocation instrumentation is separate, not peak RSS; Node CPU excludes children. No cold cache, Windows or real-client comparison.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
