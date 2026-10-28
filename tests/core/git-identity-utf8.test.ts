import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixture, git } from "../helpers.ts";
import { git as readGit, gitRefLine, listWorktrees, removeWorktree } from "../../src/core/git.ts";
import { branchStatus } from "../../src/core/branch-status.ts";
import { syncBranch } from "../../src/core/branch-sync.ts";

const invalidUtf8 = /not valid UTF-8/i;

test(
  "unrepresentable worktree entry cannot remove an unrelated U+FFFD worktree",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const good = join(f.root, "wt_\ufffd"),
      marker = join(good, "ignored-marker");
    git(f.main, "worktree", "add", "-b", "valid-target", good);
    await mkdir(join(f.main, ".git", "info"), { recursive: true });
    await writeFile(join(f.main, ".git", "info", "exclude"), "ignored-marker\n", { flag: "a" });
    await writeFile(marker, "preserve");
    const gitdir = join(f.main, ".git", "worktrees", "c", "gitdir");
    await writeFile(gitdir, Buffer.concat([Buffer.from(f.root + "/wt_"), Buffer.from([255]), Buffer.from("/.git\n")]));
    const raw = execFileSync("git", ["-C", f.main, "worktree", "list", "--porcelain", "-z"]);
    assert.ok(raw.includes(Buffer.from([255])));
    assert.ok(raw.includes(Buffer.from("wt_\ufffd")));
    await assert.rejects(listWorktrees(f.main), invalidUtf8);
    await assert.rejects(removeWorktree(f.main, good), invalidUtf8);
    assert.equal(await readFile(marker, "utf8"), "preserve");
  },
);

async function invalidHeadFixture(t: TestContext) {
  const f = await fixture(t),
    remote = join(f.root, "remote.git"),
    writer = join(f.root, "writer"),
    name = "b_\ufffd";
  git(f.root, "init", "--bare", "-b", "main", remote);
  git(f.main, "remote", "add", "origin", remote);
  git(f.main, "push", "-u", "origin", "main");
  git(f.main, "branch", name);
  git(f.main, "branch", "--set-upstream-to=origin/main", name);
  git(f.root, "clone", remote, writer);
  await writeFile(join(writer, "shared.txt"), "incoming\n");
  git(writer, "add", "shared.txt");
  git(writer, "commit", "-m", "incoming");
  git(writer, "push", "origin", "main");
  git(f.main, "pack-refs", "--all");
  const path = join(f.main, ".git", "packed-refs"),
    rawPacked = await readFile(path);
  const lines = rawPacked.toString("latin1").split("\n").filter(Boolean);
  const headers = lines.filter((line) => line.startsWith("#"));
  const rows = lines.filter((line) => !line.startsWith("#")).map((line) => Buffer.from(line, "latin1"));
  rows.push(Buffer.concat([Buffer.from(`${f.initial} refs/heads/b_`), Buffer.from([255])]));
  rows.sort((a, b) => Buffer.compare(a.subarray(a.indexOf(32) + 1), b.subarray(b.indexOf(32) + 1)));
  await writeFile(
    path,
    Buffer.concat([
      ...headers.map((line) => Buffer.from(line + "\n")),
      ...rows.flatMap((line) => [line, Buffer.from("\n")]),
    ]),
  );
  await writeFile(
    join(f.main, ".git", "HEAD"),
    Buffer.concat([Buffer.from("ref: refs/heads/b_"), Buffer.from([255, 10])]),
  );
  const status = execFileSync("git", ["-C", f.main, "status", "--porcelain=v2", "--branch", "-z"]);
  assert.ok(status.includes(Buffer.from([255])));
  return { f, name, path, writer };
}

test(
  "read-only status rejects invalid HEAD bytes without confusing a legal U+FFFD branch",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const { f, name } = await invalidHeadFixture(t);
    const head = join(f.main, ".git", "HEAD");
    const before = await readFile(head);
    await assert.rejects(branchStatus({ cwd: f.main, branch: name }), invalidUtf8);
    await assert.rejects(readGit(f.main, ["symbolic-ref", "HEAD"], undefined, "paths"), invalidUtf8);
    assert.deepEqual(await readFile(head), before);
    assert.equal(git(f.main, "rev-parse", `refs/heads/${name}`).trim(), f.initial);
    assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "base\n");
    await writeFile(head, `ref: refs/heads/${name}\n`);
    assert.equal(gitRefLine(await readGit(f.main, ["symbolic-ref", "HEAD"], undefined, "paths")), `refs/heads/${name}`);
    const status = await branchStatus({ cwd: f.main });
    assert.equal(status.worktree.branch, name);
    assert.equal(status.local.ref, `refs/heads/${name}`);
    assert.equal(status.local.commit, f.initial);
  },
);

test(
  "invalid HEAD ref cannot auto-sync the U+FFFD branch, but valid ref can",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const { f, name, path, writer } = await invalidHeadFixture(t);
    const rejected = await syncBranch(f.main, name);
    assert.equal(rejected.state, "error");
    assert.match(rejected.reason ?? "", invalidUtf8);
    assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "base\n");
    assert.equal(git(f.main, "rev-parse", name).trim(), f.initial);
    await writeFile(join(f.main, ".git", "HEAD"), `ref: refs/heads/${name}\n`);
    const accepted = await syncBranch(f.main, name);
    assert.equal(accepted.state, "updated", JSON.stringify(accepted));
    assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "incoming\n");

    // A non-cooperating writer switches HEAD after the final status snapshot.
    // symbolic-ref must reject invalid bytes before the subsequent merge.
    const beforeNext = git(f.main, "rev-parse", name).trim();
    const refs = await readFile(path);
    const oldRef = Buffer.concat([Buffer.from(`${f.initial} refs/heads/b_`), Buffer.from([255])]);
    const newRef = Buffer.concat([Buffer.from(`${beforeNext} refs/heads/b_`), Buffer.from([255])]);
    const at = refs.indexOf(oldRef);
    assert.ok(at >= 0);
    assert.equal(refs.indexOf(oldRef, at + 1), -1);
    await writeFile(path, Buffer.concat([refs.subarray(0, at), newRef, refs.subarray(at + oldRef.length)]));
    await writeFile(join(writer, "shared.txt"), "next\n");
    git(writer, "add", "shared.txt");
    git(writer, "commit", "-m", "next");
    git(writer, "push", "origin", "main");
    const bin = join(f.root, "git-wrapper"),
      counter = join(f.root, "status-count");
    await mkdir(bin);
    const head = join(f.main, ".git", "HEAD");
    await writeFile(
      join(bin, "git"),
      `#!/usr/bin/env node
const cp = require('node:child_process'), fs = require('node:fs');
const args=process.argv.slice(2), child=cp.spawnSync('/usr/bin/git', args, { encoding: null });
if (child.status===0 && args.includes('status')) {
  const file=${JSON.stringify(counter)}; let n=0; try { n=Number(fs.readFileSync(file,'utf8')); } catch {}
  fs.writeFileSync(file,String(++n));
  if (n===2) fs.writeFileSync(${JSON.stringify(head)},Buffer.concat([Buffer.from('ref: refs/heads/b_'),Buffer.from([255,10])]));
}
if(child.stdout)process.stdout.write(child.stdout); if(child.stderr)process.stderr.write(child.stderr);process.exit(child.status ?? 1);
`,
    );
    await chmod(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      const raced = await syncBranch(f.main, name);
      assert.equal(raced.state, "error");
      assert.match(raced.reason ?? "", invalidUtf8);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
    assert.equal(await readFile(counter, "utf8"), "2");
    assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "incoming\n");
    assert.equal(git(f.main, "rev-parse", name).trim(), beforeNext);
  },
);
