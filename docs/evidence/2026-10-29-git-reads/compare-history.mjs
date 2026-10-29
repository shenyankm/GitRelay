import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [baseline, candidate, mode, ...extra] = process.argv.slice(2);
assert.ok(baseline && candidate && !extra.length && (mode === undefined || mode === "wide"),
  "Usage: node compare-history.mjs <baseline-dist> <candidate-dist> [wide]");
const variants = {};
for (const [name, directory] of Object.entries({ baseline, candidate })) {
  const path = resolve(directory, "core/changes.js");
  variants[name] = {
    api: await import(pathToFileURL(path)),
    sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
  };
}
const temporary = await mkdtemp(join(tmpdir(), "gitrelay-history-comparison-"));
const git = (...args) => execFileSync("git", ["-C", temporary,
  "-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.test", "-c", "commit.gpgsign=false", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  git("init", "-b", "main");
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  for (const file of ["shared.txt", "other.txt"]) await writeFile(join(temporary, file), "base\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  const initial = git("rev-parse", "HEAD");
  const count = mode === "wide" ? 200 : 2000;
  const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let input = "";
  for (let i = 0; i < count; i++) {
    input += `commit refs/heads/main\nmark :${i + 1}\ncommitter Benchmark <benchmark@example.test> ${1700000000 + i} +0000\n${data("change " + i)}from ${i ? ":" + i : initial}\nM 100644 inline other.txt\n${data(i + "\n")}`;
    if (i === 2 || i === 3)
      input += `M 100644 inline shared.txt\n${data(i === 2 ? "temporary\n" : "base\n")}`;
    if (mode === "wide")
      for (let file = 0; file < 1000; file++)
        input += `M 100644 inline dir/${String(file).padStart(4, "0")}-${"x".repeat(80)}.txt\n${data(i + "\n")}`;
    input += "\n";
  }
  execFileSync("git", ["-C", temporary, "fast-import", "--quiet"], { input, encoding: "utf8" });
  const commits = git("rev-list", "--reverse", `${initial}..refs/heads/main`).split("\n");
  assert.equal(commits.length, count);
  const receiver = join(temporary, "receiver");
  git("worktree", "add", "-b", "receiver", receiver, initial);
  await writeFile(join(receiver, "shared.txt"), "local\n");
  const results = [];
  for (const count of mode === "wide" ? [200] : [100, 500, 2000]) {
    for (let round = 0; round < 6; round++) {
      const entries = Object.entries(variants);
      if (round % 2) entries.reverse();
      for (const [name, { api }] of entries) {
        const start = performance.now();
        const change = await api.inspectChange({ root: receiver, ref: "refs/heads/main", commit: initial }, commits[count - 1]);
        const wallMs = performance.now() - start;
        assert.deepEqual(change.files, ["shared.txt"]);
        assert.deepEqual(change.commits, commits.slice(0, count));
        assert.equal(change.snapshot, false);
        assert.match(change.patch, /temporary/);
        assert.deepEqual([...change.patch.matchAll(/\nCommit ([a-f0-9]+)\n/g)].map(match => match[1]), [commits[2], commits[3]]);
        results.push({ name, commits: count, round, wallMs });
      }
    }
  }
  console.log(JSON.stringify({
    environment: { node: process.version, git: git("--version"), platform: process.platform, arch: process.arch },
    moduleSha256: Object.fromEntries(Object.entries(variants).map(([name, value]) => [name, value.sha256])),
    workload: mode === "wide" ? "200 commits each changing 1000 long filenames, plus two overlapping edits including a revert" : "100/500/2000 first-parent commits; two overlapping edits including a revert",
    samples: 6, results,
    limitations: "Same real Git repository, alternating variants, warm caches, setup excluded, uncontrolled external load. No cold-cache, per-variant memory, physical I/O, network-filesystem or real-client latency comparison.",
  }));
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
