import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const scripts = {
  mailbox: "benchmark.mjs",
  history: "benchmark-history.mjs",
  delivery: "benchmark-delivery.mjs",
  maintenance: "benchmark-maintenance.mjs",
  concurrency: "benchmark-concurrency.mjs",
  hooks: "benchmark-hooks.mjs",
  sync: "benchmark-sync.mjs",
};
const [name, output, ...extra] = process.argv.slice(2);
assert.ok(
  Object.hasOwn(scripts, name) && output && !extra.length,
  `Usage: node scripts/record-benchmark.mjs <${Object.keys(scripts).join("|")}> <new-output.json>`,
);
const git = async (...args) => (await exec("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout;
const paths = (
  await git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "src",
    "scripts",
    "vendor",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  )
)
  .split("\0")
  .filter(Boolean)
  .sort();
const fingerprint = async (files) => {
  const hash = createHash("sha256");
  for (const path of files)
    hash
      .update(path)
      .update("\0")
      .update(await readFile(resolve(root, path)))
      .update("\0");
  return hash.digest("hex");
};
const buildPaths = (await readdir(resolve(root, "dist"), { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => relative(root, resolve(entry.parentPath, entry.name)))
  .sort();
assert.ok(buildPaths.length, "Build the runtime before recording a benchmark");
const sourceSha256 = await fingerprint(paths);
const buildSha256 = await fingerprint(buildPaths);
const command = [process.execPath, `scripts/${scripts[name]}`];
const startedAt = new Date().toISOString();
const { stdout, stderr } = await exec(command[0], command.slice(1), {
  cwd: root,
  maxBuffer: 16 * 1024 * 1024,
  timeout: 600_000,
});
let rows;
try {
  rows = [JSON.parse(stdout)];
} catch {
  rows = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
assert.ok(
  rows.length > 0 && rows.every((row) => row && typeof row === "object"),
  "Benchmark must emit JSON result records",
);
assert.equal(
  await fingerprint(paths),
  sourceSha256,
  "Source changed during measurement; rerun against a stable checkout",
);
assert.equal(
  await fingerprint(buildPaths),
  buildSha256,
  "Build changed during measurement; do not rebuild concurrently",
);
const record = {
  startedAt,
  completedAt: new Date().toISOString(),
  source: {
    commit: (await git("rev-parse", "HEAD")).trim(),
    dirty: Boolean((await git("status", "--porcelain")).trim()),
    sha256: sourceSha256,
    buildSha256,
  },
  environment: {
    node: process.version,
    git: (await git("--version")).trim(),
    platform: platform(),
    release: release(),
    arch: arch(),
  },
  command,
  results: rows,
  stdout,
  stderr,
  limitations:
    "Single local run. No baseline comparison, cold-cache guarantee, physical I/O measurement or real-client latency claim.",
};
await writeFile(resolve(output), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
console.log(`Benchmark evidence written to ${resolve(output)}`);
