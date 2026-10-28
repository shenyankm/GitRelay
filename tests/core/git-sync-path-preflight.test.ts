import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixture, git } from "../helpers.ts";
import { syncBranch } from "../../src/core/branch-sync.ts";
import { git as readGit, gitPathLine } from "../../src/core/git.ts";

async function remoteFixture(t: TestContext) {
  const f = await fixture(t),
    remote = join(f.root, "remote.git"),
    writer = join(f.root, "writer");
  git(f.root, "init", "--bare", "-b", "main", remote);
  git(f.main, "remote", "add", "origin", remote);
  git(f.main, "push", "-u", "origin", "main");
  git(f.root, "clone", remote, writer);
  await writeFile(join(writer, "shared.txt"), "incoming\n");
  git(writer, "add", "shared.txt");
  git(writer, "commit", "-m", "incoming");
  git(writer, "push", "origin", "main");
  return f;
}

async function gitWrapper(f: Awaited<ReturnType<typeof fixture>>, mode: "invalid-path" | "marker-after-fetch") {
  const bin = join(f.root, "wrapper-bin"),
    calls = join(f.root, "calls.log"),
    done = join(f.root, "settled");
  const operation = join(f.main, ".git", "MERGE_HEAD");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2), mode=${JSON.stringify(mode)}, calls=${JSON.stringify(calls)};
fs.appendFileSync(calls,JSON.stringify(args)+'\\n');
if(mode==='invalid-path' && args.includes('--git-path') && args.at(-1)==='MERGE_HEAD') { process.stdout.write(Buffer.from([255,10])); process.exit(0); }
if(mode==='invalid-path' && args.includes('--git-path') && args.at(-1)==='CHERRY_PICK_HEAD') { cp.spawnSync('/bin/sleep',['0.2']); fs.writeFileSync(${JSON.stringify(done)},'settled'); }
const child=cp.spawnSync('/usr/bin/git',args,{encoding:null});
if(mode==='marker-after-fetch' && child.status===0 && args.includes('fetch')) fs.writeFileSync(${JSON.stringify(operation)},${JSON.stringify(f.initial + "\n")});
if(child.stdout)process.stdout.write(child.stdout);if(child.stderr)process.stderr.write(child.stderr);process.exit(child.status??1);
`,
  );
  await chmod(join(bin, "git"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old ?? ""}`;
  return {
    calls,
    done,
    operation,
    restore() {
      if (old === undefined) delete process.env.PATH;
      else process.env.PATH = old;
    },
  };
}

const names = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

test(
  "Git operation-path reader rejects invalid UTF-8 without fetching or changing files",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const f = await remoteFixture(t);
    const before = git(f.main, "rev-parse", "refs/remotes/origin/main").trim();
    const w = await gitWrapper(f, "invalid-path");
    try {
      await assert.rejects(
        readGit(f.main, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"], undefined, "paths"),
        /not valid UTF-8/i,
      );
      const calls = await names(w.calls);
      assert.equal(calls.length, 1);
      assert.ok(!calls.some((a) => a.includes("fetch") || a.includes("merge")));
    } finally {
      w.restore();
    }
    const path = gitPathLine(
      await readGit(f.main, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"], undefined, "paths"),
    );
    assert.equal(path, w.operation);
    assert.equal(git(f.main, "rev-parse", "refs/remotes/origin/main").trim(), before);
    assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "base\n");
  },
);

test(
  "unrepresentable git-path fails before fetch and waits for sibling processes",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const f = await remoteFixture(t),
      before = git(f.main, "rev-parse", "refs/remotes/origin/main").trim();
    const w = await gitWrapper(f, "invalid-path");
    try {
      const result = await syncBranch(f.main, "main");
      assert.equal(result.state, "error");
      assert.match(result.reason ?? "", /not valid UTF-8/i);
      assert.equal(await readFile(w.done, "utf8"), "settled");
      const calls = await names(w.calls);
      assert.ok(!calls.some((a) => a.includes("fetch") || a.includes("merge")));
      assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "base\n");
    } finally {
      w.restore();
    }
    assert.equal(git(f.main, "rev-parse", "refs/remotes/origin/main").trim(), before);
  },
);

test(
  "operation marker appearing during fetch blocks merge; valid state can then fast-forward",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const f = await remoteFixture(t),
      w = await gitWrapper(f, "marker-after-fetch");
    try {
      const result = await syncBranch(f.main, "main");
      assert.equal(result.state, "blocked");
      assert.match(result.reason ?? "", /MERGE_HEAD/);
      const calls = await names(w.calls);
      assert.ok(calls.some((a) => a.includes("fetch")));
      assert.ok(!calls.some((a) => a.includes("merge")));
      assert.ok(await stat(w.operation));
      assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "base\n");
    } finally {
      w.restore();
    }
    await rm(w.operation);
    const result = await syncBranch(f.main, "main");
    assert.equal(result.state, "updated", JSON.stringify(result));
    assert.equal(await readFile(join(f.main, "shared.txt"), "utf8"), "incoming\n");
  },
);
