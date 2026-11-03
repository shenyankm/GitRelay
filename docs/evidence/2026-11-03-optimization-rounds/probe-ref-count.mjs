import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass saved round-27 dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {};
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/branch-status.js")))).branchStatus;
const root = await mkdtemp(join(tmpdir(), "gitrelay-ref-count-")),
  cwd = join(root, "repo"),
  template = join(root, "template");
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${template}`,
      ...args,
    ],
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
const outcome = async (run) => {
  try {
    return { accepted: true, result: await run({ cwd }) };
  } catch (error) {
    return { accepted: false, errorClass: error.constructor.name, error: error.message };
  }
};
try {
  await mkdir(cwd);
  await mkdir(template);
  git("init", "--template", template, "-b", "main");
  git("commit", "--allow-empty", "-m", "initial");
  const commit = git("rev-parse", "HEAD");
  git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git("config", "branch.main.remote", "origin");
  git("config", "branch.main.merge", "refs/heads/family");
  const packed = join(cwd, ".git", "packed-refs"),
    header = "# pack-refs with: peeled fully-peeled sorted \n";
  await writeFile(packed, header + `${commit} refs/remotes/origin/family/a\n${commit} refs/remotes/origin/family/z\n`);
  const normal = {};
  for (const [name, run] of Object.entries(apis)) normal[name] = await outcome(run);
  assert.deepEqual(normal.candidate, normal.baseline);
  assert.equal(normal.baseline.accepted, true);
  await writeFile(
    packed,
    Buffer.concat([
      Buffer.from(header + `${commit} refs/remotes/origin/family/a\n${commit} refs/remotes/origin/family/z-`),
      Buffer.from([255]),
      Buffer.from("\n"),
    ]),
  );
  const malformed = {};
  for (const [name, run] of Object.entries(apis)) malformed[name] = await outcome(run);
  assert.equal(malformed.baseline.accepted, false);
  assert.equal(malformed.baseline.errorClass, "GitPathOutputError");
  assert.equal(malformed.candidate.accepted, true);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        variants,
        normal,
        malformed,
        decision:
          "Rejected before timing: --count=1 silently omits a later non-UTF-8 ref that previously failed strict decoding. Preserve the existing validation/error behavior.",
        limitations:
          "Real Git packed refs and an intentionally malformed UTF-8 child name in an isolated repository. Correctness gate only; no speed or memory claim.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
