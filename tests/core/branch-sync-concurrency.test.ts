import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { syncBranch } from "../../src/core/branch-sync.ts";
import { fixture, git } from "../helpers.ts";

const posix = { skip: process.platform === "win32", timeout: 30_000 };
const run = (cwd: string, ...args: string[]) =>
  execFileSync(
    "/usr/bin/git",
    ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

async function setup(t: TestContext) {
  const f = await fixture(t);
  git(f.b, "remote", "add", "origin", f.main);
  git(f.b, "fetch", "origin");
  git(f.b, "branch", "--set-upstream-to=origin/main");
  git(f.b, "branch", "alternate");
  const next = await f.commit(f.main, "shared.txt", "incoming\n");
  const gitDir = await realpath(git(f.b, "rev-parse", "--absolute-git-dir").trim());
  return { ...f, next, gitDir };
}

type SyncFixture = Awaited<ReturnType<typeof setup>>;

async function gate(t: TestContext, f: SyncFixture, mode: string) {
  const bin = join(f.root, "wrapper"),
    entered = join(f.root, "entered"),
    release = join(f.root, "release");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}
const cp=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2),mode=${JSON.stringify(mode)};
const pause=async()=>{
  fs.writeFileSync(${JSON.stringify(entered)},'entered');
  const end=Date.now()+25000;
  while(!fs.existsSync(${JSON.stringify(release)})){
    if(Date.now()>end)process.exit(91);
    await new Promise(r=>setTimeout(r,5));
  }
};
(async()=>{
  const fetch=args.includes('fetch'),merge=args.includes('merge'),txn=args.includes('update-ref')&&args.includes('--stdin');
  if(mode==='fetch-descendant'&&fetch){
    const descendant=cp.spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore','inherit','inherit']});
    fs.writeFileSync(${JSON.stringify(join(f.root, "descendant"))},JSON.stringify({pid:descendant.pid,parent:process.pid}));
    await pause();descendant.kill('SIGKILL');
  }
  if((mode==='before-fetch'&&fetch)||(mode==='before-transaction'&&txn)||(mode==='before-merge'&&merge))await pause();
  if(mode==='before-commit'&&txn){
    const child=cp.spawn('/usr/bin/git',args,{stdio:['pipe','inherit','inherit']});
    let writes=Promise.resolve();
    process.stdin.on('data',chunk=>{writes=writes.then(async()=>{if(chunk.toString().includes('commit\\n'))await pause();child.stdin.write(chunk);});});
    process.stdin.on('end',()=>{void writes.then(()=>child.stdin.end());});
    child.stdin.on('error',()=>{});child.on('error',()=>process.exit(92));child.on('close',code=>process.exit(code??93));
    return;
  }
  const child=cp.spawn('/usr/bin/git',args,{stdio:'inherit'});
  child.on('error',()=>process.exit(92));
  child.on('close',async code=>{
    if((mode==='after-fetch'&&fetch)||(mode==='after-merge'&&merge)||(mode==='after-commit'&&txn))await pause();
    process.exit(code??93);
  });
})();
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(async () => {
    await writeFile(release, "release").catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  return {
    async entered(pending: Promise<unknown>) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const item = await lstat(entered).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (item) return;
        if (Date.now() >= deadline) throw new Error(`Git barrier ${mode} was not reached.`);
        await Promise.race([
          delay(5),
          pending.then((result) => {
            throw new Error(`Sync ended before ${mode}: ${JSON.stringify(result)}`);
          }),
        ]);
      }
    },
    release: () => writeFile(release, "release"),
  };
}

async function assertNoSyncLocks(f: SyncFixture) {
  for (const name of ["index.lock", "HEAD.lock", "locked"])
    await assert.rejects(lstat(join(f.gitDir, name)), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(f.gitDir)).filter((name) => name.startsWith("git-relay-sync-")),
    [],
  );
}

function assertNativeWritersBlocked(f: SyncFixture) {
  for (const args of [
    ["switch", "--discard-changes", "alternate"],
    ["checkout", "-f", "alternate"],
    ["reset", "--hard", f.initial],
    ["restore", "--source", f.initial, "--staged", "--worktree", "shared.txt"],
    ["add", "shared.txt"],
    ["update-index", "--refresh"],
    ["commit", "--allow-empty", "-m", "competing commit"],
    ["symbolic-ref", "HEAD", "refs/heads/alternate"],
    ["update-ref", "HEAD", f.initial],
    ["update-ref", "refs/heads/feature/b", f.initial],
    ["update-ref", "refs/remotes/origin/main", f.initial],
  ])
    assert.throws(() => run(f.b, ...args), args.join(" "));
  assert.throws(() => run(f.main, "worktree", "move", f.b, join(f.root, "moved")));
  assert.equal(run(f.b, "symbolic-ref", "HEAD"), "refs/heads/feature/b");
  assert.equal(run(f.b, "rev-parse", "refs/heads/alternate"), f.initial);
}

for (const mode of ["before-merge", "after-merge", "before-commit"])
  test(`native Git writers are excluded at ${mode}`, posix, async (t) => {
    const f = await setup(t),
      fetchHead = await readFile(join(f.gitDir, "FETCH_HEAD"));
    run(f.b, "update-ref", "ORIG_HEAD", f.next);
    const barrier = await gate(t, f, mode);
    const pending = syncBranch(f.b, "feature/b");
    try {
      await barrier.entered(pending);
      assertNativeWritersBlocked(f);
      assert.equal(run(f.b, "rev-parse", "HEAD"), f.initial);
      assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), mode === "before-merge" ? "base\n" : "incoming\n");
    } finally {
      await barrier.release();
    }
    assert.equal((await pending).state, "updated");
    assert.equal(run(f.b, "rev-parse", "HEAD"), f.next);
    assert.equal(run(f.b, "status", "--porcelain"), "");
    assert.deepEqual(await readFile(join(f.gitDir, "FETCH_HEAD")), fetchHead);
    assert.equal(run(f.b, "rev-parse", "ORIG_HEAD"), f.next);
    await assertNoSyncLocks(f);
  });

for (const change of ["HEAD", "branch", "upstream"])
  test(`a ${change} change before prepare aborts without applying files`, posix, async (t) => {
    const f = await setup(t),
      barrier = await gate(t, f, "before-transaction");
    const pending = syncBranch(f.b, "feature/b");
    try {
      await barrier.entered(pending);
      if (change === "HEAD") run(f.b, "symbolic-ref", "HEAD", "refs/heads/alternate");
      if (change === "branch") run(f.b, "update-ref", "refs/heads/feature/b", f.next);
      if (change === "upstream") run(f.b, "update-ref", "refs/remotes/origin/main", f.initial);
    } finally {
      await barrier.release();
    }
    const result = await pending;
    assert.equal(result.state, "error", result.reason);
    assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "base\n");
    assert.equal(run(f.b, "rev-parse", "refs/heads/alternate"), f.initial);
    assert.equal(run(f.b, "rev-parse", "refs/heads/feature/b"), change === "branch" ? f.next : f.initial);
    await assertNoSyncLocks(f);
  });

test("fetch excludes checkout; a ref change during fetch is not overwritten", posix, async (t) => {
  const f = await setup(t),
    barrier = await gate(t, f, "before-fetch");
  const pending = syncBranch(f.b, "feature/b");
  try {
    await barrier.entered(pending);
    assert.throws(() => run(f.b, "switch", "--discard-changes", "alternate"));
    run(f.b, "update-ref", "refs/heads/feature/b", f.next);
  } finally {
    await barrier.release();
  }
  assert.equal((await pending).state, "blocked");
  assert.equal(run(f.b, "rev-parse", "HEAD"), f.next);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "base\n");
  await assertNoSyncLocks(f);
});

test("an upstream symref race cannot redirect fetch into another local branch", posix, async (t) => {
  const f = await setup(t),
    barrier = await gate(t, f, "before-fetch");
  const pending = syncBranch(f.b, "feature/b");
  try {
    await barrier.entered(pending);
    run(f.b, "symbolic-ref", "refs/remotes/origin/main", "refs/heads/alternate");
  } finally {
    await barrier.release();
  }
  assert.equal((await pending).state, "updated");
  assert.equal(run(f.b, "rev-parse", "refs/heads/alternate"), f.initial);
  assert.equal(run(f.b, "rev-parse", "refs/heads/feature/b"), f.next);
  assert.equal(run(f.b, "rev-parse", "refs/remotes/origin/main"), f.next);
  assert.throws(() => run(f.b, "symbolic-ref", "--quiet", "refs/remotes/origin/main"));
  await assertNoSyncLocks(f);
});

test("an upstream update during fetch is preserved by compare-and-swap", posix, async (t) => {
  const f = await setup(t),
    barrier = await gate(t, f, "after-fetch");
  const pending = syncBranch(f.b, "feature/b");
  try {
    await barrier.entered(pending);
    run(f.b, "update-ref", "refs/remotes/origin/main", f.next);
  } finally {
    await barrier.release();
  }
  assert.equal((await pending).state, "error");
  assert.equal(run(f.b, "rev-parse", "refs/remotes/origin/main"), f.next);
  assert.equal(run(f.b, "rev-parse", "HEAD"), f.initial);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "base\n");
  await assertNoSyncLocks(f);
});

for (const mode of ["after-merge", "before-commit", "after-commit"])
  test(`cancellation at ${mode} preserves recovery data without rollback or retry`, posix, async (t) => {
    const f = await setup(t),
      barrier = await gate(t, f, mode),
      controller = new AbortController();
    const pending = syncBranch(f.b, "feature/b", controller.signal);
    const rejected = assert.rejects(
      pending,
      (error: Error) => error.name === "AbortError" && /recovery data were retained/.test(error.message),
    );
    await barrier.entered(pending);
    controller.abort();
    await rejected;
    const lock = JSON.parse(await readFile(join(f.gitDir, "index.lock"), "utf8"));
    const journal = JSON.parse(await readFile(lock.recovery, "utf8"));
    assert.equal(journal.ref, "refs/heads/feature/b");
    assert.equal(journal.before, f.initial);
    assert.equal(journal.after, f.next);
    assert.equal(run(f.b, "rev-parse", "HEAD"), mode === "after-commit" ? f.next : f.initial);
    assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "incoming\n");
    const retained = await readFile(lock.recovery);
    assert.equal((await syncBranch(f.b, "feature/b")).state, "blocked");
    assert.deepEqual(await readFile(lock.recovery), retained);
    assert.throws(() => run(f.b, "switch", "--discard-changes", "alternate"));
  });

test("index publication failure retains both indexes and leaves the branch unchanged", posix, async (t) => {
  const f = await setup(t),
    original = fs.promises.rename;
  let injected = false;
  fs.promises.rename = (async (source: any, target: any) => {
    if (
      String(source).startsWith(join(f.gitDir, "git-relay-sync-")) &&
      String(source).endsWith("/index") &&
      String(target) === join(f.gitDir, "index")
    ) {
      injected = true;
      throw Object.assign(new Error("injected index publication failure"), { code: "EIO" });
    }
    return original(source, target);
  }) as typeof fs.promises.rename;
  syncBuiltinESMExports();
  let result;
  try {
    result = await syncBranch(f.b, "feature/b");
  } finally {
    fs.promises.rename = original;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(result.state, "error");
  assert.match(result.reason ?? "", /may be partial.*publishing-index/);
  assert.equal(run(f.b, "rev-parse", "HEAD"), f.initial);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "incoming\n");
  const lock = JSON.parse(await readFile(join(f.gitDir, "index.lock"), "utf8"));
  const directory = join(lock.recovery, "..");
  assert.deepEqual(await readFile(join(directory, "original-index")), await readFile(join(f.gitDir, "index")));
  assert.notDeepEqual(await readFile(join(directory, "index")), await readFile(join(directory, "original-index")));
  assert.equal((await syncBranch(f.b, "feature/b")).state, "blocked");
});

test("cancelling fetch settles the Git group before releasing owned guards", posix, async (t) => {
  const f = await setup(t),
    barrier = await gate(t, f, "fetch-descendant"),
    controller = new AbortController();
  const pending = syncBranch(f.b, "feature/b", controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await barrier.entered(pending);
  const descendant = JSON.parse(await readFile(join(f.root, "descendant"), "utf8"));
  const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(descendant.pid)], { encoding: "utf8" }).trim();
  assert.equal(pgid, String(descendant.parent));
  controller.abort();
  await rejected;
  let state = "";
  try {
    state = execFileSync("ps", ["-o", "stat=", "-p", String(descendant.pid)], { encoding: "utf8" }).trim();
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  assert.ok(!state || state.startsWith("Z"), `Descendant still running: ${state}`);
  assert.equal(run(f.b, "rev-parse", "refs/remotes/origin/main"), f.initial);
  assert.equal(run(f.b, "rev-parse", "HEAD"), f.initial);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "base\n");
  await assertNoSyncLocks(f);
});

test("an existing index lock is never removed or rewritten", posix, async (t) => {
  const f = await setup(t),
    path = join(f.gitDir, "index.lock");
  await writeFile(path, "another writer");
  assert.equal((await syncBranch(f.b, "feature/b")).state, "blocked");
  assert.equal(await readFile(path, "utf8"), "another writer");
  await assert.rejects(lstat(join(f.gitDir, "locked")), { code: "ENOENT" });
  assert.equal(run(f.b, "rev-parse", "refs/remotes/origin/main"), f.initial);
});

test("reference-transaction policy can reject a fast-forward before working files change", posix, async (t) => {
  const f = await setup(t),
    hooks = join(f.root, "hooks"),
    rejected = join(f.root, "policy-rejected");
  await mkdir(hooks);
  await writeFile(
    join(hooks, "reference-transaction"),
    `#!${process.execPath}
const fs=require('node:fs'), input=fs.readFileSync(0,'utf8');
if(process.argv[2]==='prepared'&&input.split('\\n').some(line=>line.endsWith(' refs/heads/feature/b'))){
  fs.writeFileSync(${JSON.stringify(rejected)},input);process.exit(1);
}
`,
    { mode: 0o755 },
  );
  git(f.b, "config", "core.hooksPath", hooks);
  const result = await syncBranch(f.b, "feature/b");
  assert.equal(result.state, "error", result.reason);
  assert.match(await readFile(rejected, "utf8"), /refs\/heads\/feature\/b/);
  assert.equal(run(f.b, "rev-parse", "HEAD"), f.initial);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "base\n");
  await assertNoSyncLocks(f);
});

for (const name of ["post-merge", "post-index-change"])
  test(`a ${name} policy is not silently bypassed`, posix, async (t) => {
    const f = await setup(t),
      hooks = join(f.root, "hooks");
    await mkdir(hooks);
    await writeFile(join(hooks, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git(f.b, "config", "core.hooksPath", hooks);
    const result = await syncBranch(f.b, "feature/b");
    assert.equal(result.state, "blocked", result.reason);
    assert.match(result.reason ?? "", /hook.*policy/);
    assert.equal(run(f.b, "rev-parse", "refs/remotes/origin/main"), f.initial);
    await assertNoSyncLocks(f);
  });

for (const flag of ["--split-index", "--assume-unchanged", "--skip-worktree"])
  test(`unsupported index mode ${flag} blocks before fetch`, posix, async (t) => {
    const f = await setup(t);
    git(f.b, "update-index", flag, ...(flag === "--split-index" ? [] : ["shared.txt"]));
    await writeFile(join(f.b, "shared.txt"), "unfinished\n");
    const result = await syncBranch(f.b, "feature/b");
    assert.equal(result.state, "blocked", result.reason);
    assert.equal(run(f.b, "rev-parse", "refs/remotes/origin/main"), f.initial);
    assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "unfinished\n");
    await assertNoSyncLocks(f);
  });

for (const [key, value] of [
  ["core.sparseCheckout", "yes"],
  ["core.splitIndex", "on"],
  ["extensions.worktreeConfig", "1"],
  ["includeIf.onbranch:feature/*.path", join("/", "nonexistent-config")],
  ["branch.feature/b.mergeOptions", "--verify-signatures"],
])
  test(`unsupported config ${key} is rejected before fetch`, posix, async (t) => {
    const f = await setup(t);
    git(f.b, "config", key, value);
    const result = await syncBranch(f.b, "feature/b");
    assert.equal(result.state, "blocked", result.reason);
    assert.match(result.reason ?? "", /does not support/);
    assert.equal(run(f.b, "rev-parse", "refs/remotes/origin/main"), f.initial);
    await assertNoSyncLocks(f);
  });
