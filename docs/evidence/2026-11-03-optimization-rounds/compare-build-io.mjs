import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.argv.length, 3, "Pass the saved baseline build script.");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const paths = { baseline: resolve(process.argv[2]), candidate: join(root, "scripts/build.mjs") };
const scripts = {},
  sourceHashes = {},
  results = [];
for (const [name, path] of Object.entries(paths)) {
  const source = await readFile(path, "utf8");
  sourceHashes[name] = createHash("sha256").update(source).digest("hex");
  assert.ok(source.includes('const root = fileURLToPath(new URL("../", import.meta.url));'));
  scripts[name] = source
    .replace('const root = fileURLToPath(new URL("../", import.meta.url));', `const root = ${JSON.stringify(root)};`)
    .replaceAll("await mkdir(", "await (mkdirCalls++, mkdir)(");
}
const snapshot = async () => {
  const files = (await readdir(join(root, "dist"), { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  const hashes = {};
  for (const f of files) {
    const p = join(f.parentPath, f.name),
      key = p.slice(join(root, "dist").length + 1);
    hashes[key] = {
      sha256: createHash("sha256")
        .update(await readFile(p))
        .digest("hex"),
      mode: (await stat(p)).mode & 0o777,
    };
  }
  return hashes;
};
let expected;
for (let sample = 0; sample <= 8; sample++) {
  const entries = Object.entries(scripts);
  if (sample % 2) entries.reverse();
  for (const [variant, source] of entries) {
    const start = performance.now();
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "let mkdirCalls = 0; const before = process.resourceUsage();\n" +
          source +
          "\nconst after = process.resourceUsage(); console.log(JSON.stringify({mkdirCalls, cpuMs: (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000}));",
      ],
      { cwd: root, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const wallMs = performance.now() - start;
    const counts = JSON.parse(output.trim().split("\n").at(-1));
    const current = await snapshot();
    if (!expected) expected = current;
    else assert.deepEqual(current, expected, "Every build must preserve emitted bytes and executable modes");
    if (sample) results.push({ variant, sample, wallMs, ...counts });
  }
}
const medians = {};
for (const variant of Object.keys(paths))
  for (const key of ["wallMs", "cpuMs", "mkdirCalls"]) {
    const values = results
      .filter((r) => r.variant === variant)
      .map((r) => r[key])
      .sort((a, b) => a - b);
    medians[`${variant}-${key}`] = (values[3] + values[4]) / 2;
  }
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: 8,
      paths,
      sourceHashes,
      medians,
      outputFiles: expected,
      results,
      limitations:
        "Alternating complete builds including declaration tsc; bytes and executable modes compared after each run. Node CPU excludes tsc child CPU. Warm filesystem caches and uncontrolled host load. Directory-call counts are logical operations, not physical I/O or latency proof alone. Eval root substitution/instrumentation is identical for both scripts.",
    },
    null,
    2,
  ),
);
