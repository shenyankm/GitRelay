import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { formatChange, inspectChange, resolveMain, watchRoot } from "../../src/core/changes.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";

test("one merged worktree informs two overlapping worktrees but not the clean source", async (t) => {
  const f = await fixture(t);
  await f.commit(f.b, "shared.txt", "B committed\n");
  await writeFile(join(f.c, "shared.txt"), "C uncommitted\n");
  await f.commit(f.a, "shared.txt", "A upstream\n");
  git(f.main, "merge", "--no-ff", "feature/a", "-m", "merge A");
  const current = await resolveMain(f.main, ref);
  for (const root of [f.b, f.c]) {
    const change = await inspectChange({ root, ref, commit: f.initial }, current);
    assert.deepEqual(change?.files, ["shared.txt"]);
    assert.ok(change?.patch.includes("A upstream"));
    assert.equal(change?.rewritten, false);
    assert.match(formatChange(change!), /does not authorize merge/);
  }
  assert.equal(await inspectChange({ root: f.a, ref, commit: f.initial }, current), undefined);
  assert.equal(git(f.b, "show", "HEAD:shared.txt"), "B committed\n");
  assert.equal(git(f.c, "diff", "--name-only").trim(), "shared.txt");
});

test("detects staging, untracked files, deletions and both sides of renames", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "staged\n");
  git(f.b, "add", "shared.txt");
  await writeFile(join(f.b, "shared.txt"), "base\n"); // Staged/unstaged cancel in net diff.
  await writeFile(join(f.b, "new.txt"), "untracked\n");
  await rename(join(f.a, "shared.txt"), join(f.a, "renamed.txt"));
  await writeFile(join(f.a, "new.txt"), "upstream new\n");
  git(f.a, "add", ".");
  git(f.a, "commit", "-m", "rename and add");
  git(f.main, "merge", "--ff-only", "feature/a");
  const change = await inspectChange({ root: f.b, ref, commit: f.initial }, await resolveMain(f.main, ref));
  assert.deepEqual(change?.files, ["new.txt", "shared.txt"]);
});

test("does not lose intermediate edits reverted before the next poll", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await f.commit(f.main, "shared.txt", "temporary\n");
  await f.commit(f.main, "shared.txt", "base\n");
  const change = await inspectChange({ root: f.b, ref, commit: f.initial }, await resolveMain(f.main, ref));
  assert.deepEqual(change?.files, ["shared.txt"]);
  assert.equal(change?.commits.length, 2);
  assert.ok(change?.patch.includes("temporary"));
});

test("history read batches preserve commit and patch order across empty and unrelated commits", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  git(f.main, "config", "gc.auto", "0");
  git(f.main, "config", "maintenance.auto", "false");
  let history = "";
  for (let index = 0; index < 515; index++) {
    history += `commit ${ref}\nmark :${index + 1}\ncommitter Test <test@example.com> ${1700000000 + index} +0000\ndata 6\nchange\nfrom ${index ? `:${index}` : f.initial}\n`;
    if (![31, 32, 287, 288, 514].includes(index)) {
      const relevant = index === 0 || index === 513;
      const text = relevant ? (index === 0 ? "temporary\n" : "base\n") : `${index}\n`;
      history += `M 100644 inline ${relevant ? "shared.txt" : "other.txt"}\ndata ${Buffer.byteLength(text)}\n${text}\n`;
    }
    history += `\nget-mark :${index + 1}\n`;
  }
  const commits = execFileSync("git", ["-C", f.main, "fast-import", "--quiet"], { input: history, encoding: "utf8" })
    .trim()
    .split(/\r?\n/);
  assert.equal(commits.length, 515);
  const change = await inspectChange({ root: f.b, ref, commit: f.initial }, commits.at(-1)!);
  assert.deepEqual(change?.files, ["shared.txt"]);
  assert.deepEqual(change?.commits, commits);
  assert.deepEqual(
    [...change!.patch.matchAll(/\nCommit ([a-f0-9]+)\n/g)].map((match) => match[1]),
    [commits[0], commits[513]],
  );
  assert.match(change!.patch, /temporary/);
});

test("batched history preserves merge files, leading newlines and hash-shaped filenames", async (t) => {
  const f = await fixture(t);
  const files = ["\n[shared]* 中文\n.txt", f.initial];
  for (const file of files) {
    await writeFile(join(f.b, file), "local\n");
    await f.commit(f.a, file, "upstream\n");
  }
  git(f.main, "merge", "--no-ff", "feature/a", "-m", "merge");
  const merge = git(f.main, "rev-parse", "HEAD").trim();
  git(f.main, "commit", "--allow-empty", "-m", "empty");
  const empty = git(f.main, "rev-parse", "HEAD").trim();
  const current = await f.commit(f.main, "other.txt", "unrelated\n");
  git(f.main, "config", "log.diffMerges", "separate");
  git(f.main, "config", "log.showSignature", "true");
  git(f.main, "config", "color.ui", "always");
  const change = await inspectChange({ root: f.b, ref, commit: f.initial }, current);
  assert.deepEqual(change?.files, files.sort());
  assert.deepEqual(change?.commits, [merge, empty, current]);
  assert.deepEqual(
    [...change!.patch.matchAll(/\nCommit ([a-f0-9]+)\n/g)].map((match) => match[1]),
    [merge],
  );
});

test(
  "combined history handles overflow and rejects incomplete or misordered output",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.b, "shared.txt"), "local\n");
    const first = await f.commit(f.main, "shared.txt", "temporary\n");
    const current = await f.commit(f.main, "shared.txt", "base\n");
    const executable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(f.root, "bin");
    const response = join(f.root, "log-response");
    await mkdir(bin);
    await writeFile(response, "x".repeat(17 * 1024 * 1024));
    await writeFile(
      join(bin, "git"),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[2] === 'log') process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(response)}));
else {
  const child = spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}
`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      const change = await inspectChange({ root: f.b, ref, commit: f.initial }, current);
      assert.deepEqual(change?.files, ["shared.txt"]);
      assert.deepEqual(change?.commits, [first, current]);
      assert.match(change!.patch, /temporary/);
      for (const output of [
        "",
        `\0${first}\0`,
        `\0${current}\0\0${first}\0`,
        `\0${first}\0shared.txt\0\0${current}\0`,
        `\0${first}\0\0${current}\0\nshared`,
      ]) {
        await writeFile(response, output);
        await assert.rejects(inspectChange({ root: f.b, ref, commit: f.initial }, current), /Git history/);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

test(
  "oversized history batches retry smaller combined reads in order",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.b, "shared.txt"), "local\n");
    const commits = [await f.commit(f.main, "shared.txt", "temporary\n")];
    for (let index = 0; index < 63; index++) {
      git(f.main, "commit", "--allow-empty", "-m", "empty");
      commits.push(git(f.main, "rev-parse", "HEAD").trim());
    }
    commits.push(await f.commit(f.main, "shared.txt", "base\n"));
    const executable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(f.root, "bin"),
      calls = join(f.root, "calls");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[2] === 'log') {
  const count = args.filter(arg => /^[a-f0-9]{40,64}$/.test(arg)).length;
  fs.appendFileSync(${JSON.stringify(calls)}, count + '\\n');
  if (count > 32) { process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 120)); return; }
}
const child = cp.spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`,
      { mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      const change = await inspectChange({ root: f.b, ref, commit: f.initial }, commits.at(-1)!);
      assert.deepEqual(change?.files, ["shared.txt"]);
      assert.deepEqual(change?.commits, commits);
      assert.deepEqual(
        [...change!.patch.matchAll(/\nCommit ([a-f0-9]+)\n/g)].map((match) => match[1]),
        [commits[0], commits.at(-1)],
      );
      assert.match(change!.patch, /temporary/);
      const sizes = (await readFile(calls, "utf8")).trim().split("\n").map(Number);
      assert.ok(sizes.some((size) => size > 32));
      assert.ok(sizes.some((size) => size > 1 && size <= 32));
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  },
);

test("unrelated updates do not trigger, ref rewind is identified, subdirectories resolve to root", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const unrelated = await f.commit(f.main, "other.txt", "unrelated\n");
  assert.equal(await inspectChange({ root: f.b, ref, commit: f.initial }, unrelated), undefined);
  const changed = await f.commit(f.main, "shared.txt", "upstream\n");
  const rewrite = await inspectChange({ root: f.b, ref, commit: changed }, f.initial);
  assert.equal(rewrite?.rewritten, true);
  await mkdir(join(f.b, "sub"));
  assert.equal(await watchRoot(join(f.b, "sub")), f.b);
  await assert.rejects(resolveMain(f.main, "--help"), /full branch ref/);
});

test("fast-forward through a second parent compares snapshots without replaying old main edits", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const previous = await f.commit(f.main, "shared.txt", "already on main\n");
  await f.commit(f.a, "other.txt", "side change\n");
  git(f.a, "merge", "--no-ff", "main", "-m", "merge main into side");
  git(f.main, "merge", "--ff-only", "feature/a");
  const current = await resolveMain(f.main, ref);
  assert.equal(await inspectChange({ root: f.b, ref, commit: previous }, current), undefined);
  await writeFile(join(f.b, "other.txt"), "local side\n");
  const change = await inspectChange({ root: f.b, ref, commit: previous }, current);
  assert.deepEqual(change?.files, ["other.txt"]);
  assert.equal(change?.rewritten, false);
  assert.equal(change?.snapshot, true);
  assert.match(formatChange(change!), /snapshots/);
  assert.ok(!change!.patch.includes("already on main"));
});

test("failure to run Git is not acknowledged as a missing-history notification", async (t) => {
  const f = await fixture(t);
  const path = process.env.PATH;
  try {
    process.env.PATH = "";
    await assert.rejects(inspectChange({ root: f.b, ref, commit: f.initial }, f.initial), /ENOENT/);
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});

test("unusual paths use literal pathspecs and huge diff previews are bounded", async (t) => {
  const f = await fixture(t);
  const name = "[shared]* \u4e2d\u6587\n.txt";
  await f.commit(f.main, name, "initial\n");
  git(f.b, "merge", "--ff-only", "main");
  const before = await resolveMain(f.main, ref);
  await writeFile(join(f.b, name), "local\n");
  const current = await f.commit(f.main, name, "large\n".repeat(100_000));
  const change = await inspectChange({ root: f.b, ref, commit: before }, current);
  assert.deepEqual(change?.files, [name]);
  assert.ok(change!.patch.length < 25_000);
  assert.match(change!.patch, /truncated/);
});
