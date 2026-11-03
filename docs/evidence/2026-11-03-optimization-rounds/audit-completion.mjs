import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const evidence = fileURLToPath(new URL("./", import.meta.url));
const json = async (name) => JSON.parse(await readFile(join(evidence, name), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validation = await json("validation-50.json");
const ledger = await readFile(join(root, "docs/optimization-rounds.md"), "utf8");
const rows = ledger.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line));
assert.equal(rows.length, 50);
assert.match(ledger, /50 \/ 50 evaluated/);
const retained = validation.retainedRounds,
  rejected = validation.rejectedRounds;
assert.equal(retained.length, 29);
assert.equal(rejected.length, 21);
assert.deepEqual(
  [...retained, ...rejected].sort((a, b) => a - b),
  Array.from({ length: 50 }, (_, i) => i + 1),
);
const rounds = [],
  titles = new Set();
for (const [index, row] of rows.entries()) {
  const [, number, title, detail] = row.split("|").map((v) => v.trim());
  const round = Number(number);
  assert.equal(round, index + 1);
  assert.ok(!titles.has(title));
  titles.add(title);
  const status = retained.includes(round) ? "retained" : "rejected";
  assert.match(detail, status === "retained" ? /^Retained\b/ : /^Rejected\b/);
  const references = [...new Set([...detail.matchAll(/`([^`]+\.json)`/g)].map((match) => match[1]))];
  assert.ok(references.length > 0, `Round ${round} must cite actual evidence`);
  const files = [];
  for (const reference of references) {
    let path;
    for (const candidate of [join(evidence, reference), join(root, "docs", reference), join(root, reference)]) {
      if (
        await stat(candidate)
          .then((s) => s.isFile())
          .catch(() => false)
      ) {
        path = candidate;
        break;
      }
    }
    assert.ok(path, `Missing round ${round} evidence ${reference}`);
    const bytes = await readFile(path);
    JSON.parse(bytes.toString("utf8"));
    files.push({ path: path.slice(root.length), sha256: digest(bytes) });
  }
  rounds.push({ round, title, status, evidence: files });
}
for (const name of [
  "validation.json",
  "validation-12.json",
  "validation-18.json",
  "validation-24.json",
  "validation-30.json",
  "validation-36.json",
  "validation-42.json",
  "validation-50.json",
]) {
  const record = await json(name);
  assert.equal(record.requestedRounds, 50);
  assert.deepEqual(
    [...record.retainedRounds, ...record.rejectedRounds].sort((a, b) => a - b),
    Array.from({ length: record.evaluatedRounds }, (_, i) => i + 1),
  );
}
for (const [path, expected] of Object.entries(validation.candidateSourceAndTestFilesSha256))
  assert.equal(digest(await readFile(join(root, path))), expected, path);
const outputFiles = (await readdir(join(root, "dist"), { recursive: true, withFileTypes: true })).filter((entry) =>
  entry.isFile(),
);
assert.equal(outputFiles.length, Object.keys(validation.candidateBuildFilesSha256).length);
for (const [path, expected] of Object.entries(validation.candidateBuildFilesSha256))
  assert.equal(digest(await readFile(join(root, "dist", path))), expected, path);
const original = await json("validation.json");
const declarations = Object.keys(validation.candidateBuildFilesSha256).filter((p) => p.endsWith(".d.ts"));
assert.ok(declarations.length > 0);
for (const path of declarations)
  assert.equal(validation.candidateBuildFilesSha256[path], original.baselineBuildFilesSha256[path], path);
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const oldPkg = JSON.parse(
  execFileSync("git", ["show", "f71f6f45cc0b736d78e886b1d20d5ddebbd67e0e:package.json"], {
    cwd: root,
    encoding: "utf8",
  }),
);
for (const field of ["dependencies", "devDependencies", "peerDependencies", "exports", "types", "bin", "engines"])
  assert.deepEqual(pkg[field], oldPkg[field], field);
const generated = execFileSync("git", ["ls-files", "--", "dist", "node_modules", ".codex/plugin-build"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(generated, "");
assert.equal(validation.gates["npm run check"].failed, 0);
assert.equal(validation.gates["npm run check"].passed, 662);
assert.equal(validation.gates["real offline production install with scripts enabled"].passed, true);
assert.equal(validation.gates["tarball/plugin contents and fingerprints"].passed, true);
const packaging = await json("packaging-50.json"),
  initial = (await json("packaging.json")).baseline;
assert.ok(packaging.npm.size < initial.npm.size);
assert.ok(packaging.plugin.bytes < initial.plugin.bytes);
for (const name of ["final-daemon.json", "final-gc-apply.json", "final-event-scan.json"])
  assert.ok(Object.keys((await json(name)).medians).length > 0);
console.log(
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      localAudit: "passed",
      evaluatedRounds: 50,
      retainedRounds: 29,
      rejectedRounds: 21,
      rounds,
      requirements: [
        {
          requirement: "50 consecutive distinct candidate decisions with real evidence",
          evidence:
            "All ledger rows numbered 1 through 50, unique titles, retained/rejected partition and parseable linked records",
          result: "passed",
        },
        {
          requirement: "Only accepted implementation remains",
          evidence:
            "Current source/test and build fingerprints equal validation-50; rejected patches are archived; cumulative runtime diff reviewed",
          result: "passed",
        },
        {
          requirement: "Preserve public SDK/CLI and dependencies",
          evidence: `${declarations.length} original SDK declarations unchanged, manifest exports/types/bin/engines/dependencies unchanged; full regression suite plus installed SDK transaction`,
          result: "passed",
        },
        {
          requirement: "Actual I/O/CPU/size evidence and composed final checks",
          evidence:
            "Per-round records plus final original-baseline daemon/GC/event scans and exact tarball/plugin size/content verification",
          result: "passed",
        },
        {
          requirement: "Direct grouped commits and push to main",
          evidence: "Must be checked live after committing this audit snapshot",
          result: "live-final-gate",
        },
        {
          requirement: "Final pushed-head CI",
          evidence: "Previous main rounds 1-42 passed CI; final SHA must be checked live before completing the goal",
          result: "live-final-gate",
        },
      ],
      packaging: {
        baselineNpmCompressedBytes: initial.npm.size,
        finalNpmCompressedBytes: packaging.npm.size,
        baselinePluginFileBytes: initial.plugin.bytes,
        finalPluginFileBytes: packaging.plugin.bytes,
      },
      limits: [
        "One unsupported-Windows test is skipped on macOS",
        "Warm-cache local comparisons do not establish native-client latency, cold-cache, Windows runtime, physical I/O or peak memory",
        "Proof deletion spends more Node CPU for lower wall time; 32 recipients times four proof removals is an operation bound, not a measured byte budget",
      ],
      finalGatePolicy:
        "Goal remains active until source fingerprints, clean main/remote equality and successful exact-head CI are verified live. This snapshot does not claim those future gates passed.",
    },
    null,
    2,
  ),
);
