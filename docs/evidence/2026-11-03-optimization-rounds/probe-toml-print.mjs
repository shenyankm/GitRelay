import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "../../../node_modules/typescript/lib/typescript.js";

assert.equal(process.argv.length, 3, "Pass disposable output directory.");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = join(root, "vendor/smol-toml"),
  target = resolve(process.argv[2]);
assert.notEqual(target, source);
await mkdir(target, { recursive: true });
await writeFile(join(target, "package.json"), '{"type":"module"}\n');
const records = [],
  before = [],
  after = [],
  start = performance.now();
for (const name of (await readdir(source)).filter((n) => n.endsWith(".js")).sort()) {
  const original = await readFile(join(source, name), "utf8");
  const header = original.match(/^\/\*![^]*?\*\//)?.[0];
  assert.ok(header?.includes("Redistribution and use"), "Preserve each source license notice");
  const result = ts.transpileModule(original, {
    fileName: name,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics, []);
  const code = header + "\n" + result.outputText;
  await writeFile(join(target, name), code);
  before.push(Buffer.from(original));
  after.push(Buffer.from(code));
  records.push({
    name,
    originalBytes: Buffer.byteLength(original),
    candidateBytes: Buffer.byteLength(code),
    originalSha256: createHash("sha256").update(original).digest("hex"),
    candidateSha256: createHash("sha256").update(code).digest("hex"),
  });
}
const printWallMs = performance.now() - start;
const baseline = await import(pathToFileURL(join(source, "index.js"))),
  candidate = await import(pathToFileURL(join(target, "index.js")));
const corpus = [
  "",
  'title = "TOML Example"',
  "a = 1\nb = -2\nc = 1.2\nd = 0xff",
  "a = true\nb = false\nc = [1,2,3]",
  "[[products]]\nname = 'a'\n[[products]]\nname = 'b'",
  'a = { x = "工作😀", y = [1, 2] }',
  'a = """\nmultiline\ntext"""',
  "a = 1979-05-27T07:32:00Z\nb = 1979-05-27\nc = 07:32:00",
  "a = nan\nb = +inf\nc = -inf",
  "[tools.git_relay]\nenabled = true\nref = 'refs/heads/main'",
  "a = 1_000",
  "a = [1,\n2,\n]",
  "[table]\nx = 'quoted # text'",
];
for (let i = 0; i < 100; i++)
  corpus.push(`key_${i} = ${JSON.stringify("a\\b工作😀".repeat(i % 10))}\narray = [${i}, ${i + 1}]`);
const normalize = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `bigint:${v}` : v));
for (const text of corpus) {
  const a = baseline.parse(text),
    b = candidate.parse(text);
  assert.equal(normalize(a), normalize(b));
  assert.equal(baseline.stringify(a), candidate.stringify(b));
}
const invalid = [
  "x = 9223372036854775807",
  "a =",
  "a = 1\na = 2",
  "[broken",
  "a = [1,",
  "x = 0bad",
  "a = 01",
  'a = "unterminated',
  "[x]\na=1\n[x]\na=2",
];
for (const text of invalid) {
  const failures = [baseline, candidate].map((api) => {
    try {
      api.parse(text);
      assert.fail("Invalid TOML accepted");
    } catch (error) {
      return { name: error.name, message: error.message };
    }
  });
  assert.deepEqual(failures[0], failures[1]);
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      originalBytes: before.reduce((n, b) => n + b.length, 0),
      candidateBytes: after.reduce((n, b) => n + b.length, 0),
      gzipConcatenatedBytes: {
        baseline: gzipSync(Buffer.concat(before)).length,
        candidate: gzipSync(Buffer.concat(after)).length,
      },
      printWallMs,
      validCases: corpus.length,
      invalidCases: invalid.length,
      records,
      limitations:
        "Isolated generated vendor JS probe, no production build changes. Copyright/license notices preserved in every file. Gzip concatenation is not an npm tarball. Printing time excludes loading TypeScript; corpus checks are bounded and do not prove complete TOML equivalence.",
    },
    null,
    2,
  ),
);
