import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { branchStatus } from "../../src/core/branch-status.ts";
import { worktreeFiles } from "../../src/core/changes.ts";
import { fixture, git } from "../helpers.ts";

test(
  "equal commits avoid history processes while retaining all working changes",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    git(f.b, "branch", "--set-upstream-to=main");
    await writeFile(join(f.b, "shared.txt"), "staged\n");
    git(f.b, "add", "shared.txt");
    await writeFile(join(f.b, "shared.txt"), "base\n");
    await writeFile(join(f.b, "other.txt"), "unstaged\n");
    await writeFile(join(f.b, "untracked"), "untracked\n");
    await writeFile(join(f.main, ".git", "info", "exclude"), "ignored\n");
    await writeFile(join(f.b, "ignored"), "ignored\n");
    const executable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(f.root, "bin"),
      calls = join(f.root, "calls");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const child = cp.spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`,
      { mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      const status = await branchStatus({ cwd: f.b });
      assert.equal(status.worktree.dirty, true);
      assert.deepEqual(status.local.tracking, { ref: "refs/heads/main", commit: f.initial, ahead: 0, behind: 0 });
      const expected = ["ignored", "other.txt", "shared.txt", "untracked"];
      assert.deepEqual([...(await worktreeFiles(f.b, f.initial))].sort(), expected);
      const initial = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.ok(!initial.some((args) => args.includes("rev-list") || args.includes("merge-base")));
      const upstream = await f.commit(f.main, "other.txt", "upstream\n");
      assert.deepEqual([...(await worktreeFiles(f.b, upstream))].sort(), expected);
      const behind = await branchStatus({ cwd: f.b });
      assert.equal(behind.local.tracking?.behind, 1);
      const all = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(all.filter((args) => args.includes("merge-base")).length, 1);
      assert.equal(all.filter((args) => args.includes("rev-list")).length, 1);
      assert.ok(!all.some((args) => args.includes("diff") && args.filter((arg) => arg === f.initial).length === 2));
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  },
);
