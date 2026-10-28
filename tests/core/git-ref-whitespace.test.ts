import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { branchStatus } from "../../src/core/branch-status.ts";
import { syncBranch } from "../../src/core/branch-sync.ts";
import { addWorktree, git as readGit, gitRefLine } from "../../src/core/git.ts";
import { fixture, git } from "../helpers.ts";

const nbsp = "\u00a0";

for (const remote of ["origin", `origin${nbsp}`]) {
  test(`status preserves Unicode whitespace in upstream and remote: ${JSON.stringify(remote)}`, async (t) => {
    const f = await fixture(t),
      bare = join(f.root, "remote.git");
    git(f.root, "init", "--bare", bare);
    git(f.main, "remote", "add", remote, bare);
    git(f.main, "push", remote, "HEAD:refs/heads/topic");
    const incoming = await f.commit(f.main, "shared.txt", "Unicode upstream\n");
    git(f.main, "push", remote, `HEAD:refs/heads/topic${nbsp}`);
    git(f.a, "fetch", remote);
    git(f.a, "config", "branch.feature/a.remote", remote);
    git(f.a, "config", "branch.feature/a.merge", `refs/heads/topic${nbsp}`);
    const status = await branchStatus({ cwd: f.a, branch: "feature/a" });
    assert.equal(status.local.tracking?.ref, `refs/remotes/${remote}/topic${nbsp}`);
    assert.equal(status.local.tracking?.commit, incoming);
    assert.equal(status.local.tracking?.behind, 1);
    assert.equal(status.local.commit, f.initial);
    assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "base\n");
  });
}

for (const remote of ["origin", `origin${nbsp}`]) {
  test(`sync preserves trailing Unicode whitespace in upstream and remote: ${JSON.stringify(remote)}`, async (t) => {
    const f = await fixture(t),
      bare = join(f.root, "remote.git");
    git(f.root, "init", "--bare", bare);
    git(f.main, "remote", "add", remote, bare);
    git(f.main, "push", remote, `HEAD:refs/heads/topic`, `HEAD:refs/heads/topic${nbsp}`);
    git(f.a, "fetch", remote);
    git(f.a, "config", "branch.feature/a.remote", remote);
    git(f.a, "config", "branch.feature/a.merge", `refs/heads/topic${nbsp}`);
    await f.commit(f.main, "shared.txt", "WRONG BRANCH\n");
    git(f.main, "push", remote, "HEAD:refs/heads/topic");
    await f.commit(f.main, "shared.txt", "CORRECT BRANCH\n");
    git(f.main, "push", remote, `HEAD:refs/heads/topic${nbsp}`);
    const status = await branchStatus({ cwd: f.a, branch: "feature/a" });
    assert.equal(status.local.tracking?.ref, `refs/remotes/${remote}/topic${nbsp}`);
    const result = await syncBranch(f.a, "feature/a");
    assert.equal(result.state, "updated", JSON.stringify(result));
    assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "CORRECT BRANCH\n");
  });
}

test("worktree add rejects a branch/tag ambiguity ending in Unicode whitespace", async (t) => {
  const f = await fixture(t),
    name = `topic${nbsp}`;
  git(f.main, "branch", name);
  await f.commit(f.main, "shared.txt", "tag commit\n");
  git(f.main, "tag", name);
  await assert.rejects(
    addWorktree(f.main, join(f.root, "new"), "feature-new", true, name),
    /matches both a branch and a tag/,
  );
});

for (const name of ["topic", `topic${nbsp}`]) {
  test(`CLI status pins the exact branch despite a same-name tag: ${JSON.stringify(name)}`, async (t) => {
    const f = await fixture(t);
    git(f.a, "branch", "-m", name);
    git(f.main, "tag", name);
    const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
    for (const flags of [[], ["--no-auto-sync"], ["--auto-sync"]]) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", cli, "status", "--cwd", f.a, ...flags],
        { encoding: "utf8", env: process.env },
      );
      assert.ifError(result.error);
      assert.equal(result.status, flags.includes("--auto-sync") ? 1 : 0, result.stderr);
      const record = JSON.parse(result.stdout);
      assert.equal(record.worktree.branch, name);
      assert.equal(record.local.ref, `refs/heads/${name}`);
      assert.equal(record.local.commit, f.initial);
      assert.equal(record.sync?.state, flags.includes("--auto-sync") ? "blocked" : undefined);
    }
    assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "base\n");
    assert.equal(git(f.a, "rev-parse", `refs/heads/${name}`).trim(), f.initial);
  });
}

test("CLI auto-sync rejects non-branch HEAD unless a monitoring branch is explicit", async (t) => {
  const f = await fixture(t);
  git(f.main, "tag", "target");
  git(f.a, "symbolic-ref", "HEAD", "refs/tags/target");
  const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
  for (const flags of [[], ["--branch", "feature/a"]]) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "status", "--cwd", f.a, "--auto-sync", ...flags],
      { encoding: "utf8", env: process.env },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    if (!flags.length) assert.match(result.stderr, /HEAD does not point to a local branch/);
    else {
      const record = JSON.parse(result.stdout);
      assert.equal(record.worktree.branch, null);
      assert.equal(record.local.ref, "refs/heads/feature/a");
      assert.equal(record.local.commit, f.initial);
      assert.equal(record.sync.state, "blocked");
    }
  }
  assert.equal(git(f.a, "symbolic-ref", "HEAD").trim(), "refs/tags/target");
});

test("CLI auto-sync preserves the current branch ending in Unicode whitespace", async (t) => {
  const f = await fixture(t),
    name = `feature${nbsp}`,
    remote = join(f.root, "remote.git");
  git(f.a, "branch", "-m", name);
  git(f.root, "init", "--bare", remote);
  git(f.main, "remote", "add", "origin", remote);
  git(f.main, "push", "origin", "HEAD:refs/heads/topic");
  git(f.a, "fetch", "origin");
  git(f.a, "config", `branch.${name}.remote`, "origin");
  git(f.a, "config", `branch.${name}.merge`, "refs/heads/topic");
  await f.commit(f.main, "shared.txt", "EXPECTED\n");
  git(f.main, "push", "origin", "HEAD:refs/heads/topic");
  const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", cli, "status", "--cwd", f.a, "--auto-sync"],
    { encoding: "utf8", env: process.env },
  );
  const record = JSON.parse(output);
  assert.equal(record.local.ref, `refs/heads/${name}`);
  assert.equal(record.sync.state, "updated");
  assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "EXPECTED\n");
});

test("worktree creation permits a Unicode whitespace-only pathname", async (t) => {
  const f = await fixture(t);
  const created = await addWorktree(f.main, nbsp, "feature-unicode-path", true);
  assert.equal(created, join(f.main, nbsp));
});

test("ref line parser rejects incomplete or multiple config records without trimming", async () => {
  const { gitRefLine, gitRefLines } = await import("../../src/core/git.ts");
  assert.equal(gitRefLine(`topic${nbsp}\n`), `topic${nbsp}`);
  assert.deepEqual(gitRefLines(`topic${nbsp}\ntopic\n`), [`topic${nbsp}`, "topic", ""]);
  assert.throws(() => gitRefLine("topic\nother\n"), /multiple or invalid ref values/);
  assert.throws(() => gitRefLine("topic"), /unterminated/);
  assert.throws(() => gitRefLines("topic"), /unterminated/);
  assert.deepEqual(gitRefLines(""), [""]);
});

test("ref parser removes Windows CRLF delimiters without trimming Unicode", async () => {
  const { gitRefLine, gitRefLines } = await import("../../src/core/git.ts");
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    assert.equal(gitRefLine(`refs/heads/topic${nbsp}\r\n`), `refs/heads/topic${nbsp}`);
    assert.deepEqual(gitRefLines(`refs/heads/topic${nbsp}\r\nrefs/heads/other\r\n`), [
      `refs/heads/topic${nbsp}`,
      "refs/heads/other",
      "",
    ]);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

for (const field of ["remote", "merge"] as const) {
  test(`Git config reader preserves Unicode and rejects multiple ${field} records`, async (t) => {
    const f = await fixture(t);
    const key = `branch.feature/a.${field}`;
    const value = field === "remote" ? `origin${nbsp}` : `refs/heads/topic${nbsp}`;
    git(f.a, "config", key, value);
    const config = join(f.main, ".git", "config");
    const before = await readFile(config);
    const read = async () => gitRefLine(await readGit(f.a, ["config", "--get-all", key], undefined, "paths"));
    assert.equal(await read(), value);
    assert.deepEqual(await readFile(config), before);
    git(f.a, "config", "--add", key, value);
    const duplicate = await readFile(config);
    await assert.rejects(read(), /multiple or invalid ref values/);
    assert.deepEqual(await readFile(config), duplicate);
    assert.equal(git(f.a, "rev-parse", "HEAD").trim(), f.initial);
    assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "base\n");
  });
}

for (const field of ["remote", "merge"] as const) {
  test(`multiple branch ${field} config values prevent auto-sync before fetch`, async (t) => {
    const f = await fixture(t),
      bare = join(f.root, "remote.git");
    git(f.root, "init", "--bare", bare);
    git(f.main, "remote", "add", "origin", bare);
    git(f.main, "push", "origin", "HEAD:refs/heads/topic");
    git(f.a, "fetch", "origin");
    git(f.a, "config", "branch.feature/a.remote", "origin");
    git(f.a, "config", "branch.feature/a.merge", "refs/heads/topic");
    git(f.a, "config", "--add", `branch.feature/a.${field}`, field === "remote" ? "origin" : "refs/heads/topic");
    const before = git(f.a, "rev-parse", "refs/remotes/origin/topic").trim();
    await f.commit(f.main, "shared.txt", "must not be fetched\n");
    git(f.main, "push", "origin", "HEAD:refs/heads/topic");
    // Both worktrees share the local remote-tracking ref; reset its fixture value
    // so the assertion detects an accidental fetch by syncBranch.
    git(f.a, "update-ref", "refs/remotes/origin/topic", before);
    const result = await syncBranch(f.a, "feature/a");
    assert.equal(result.state, "error", JSON.stringify(result));
    assert.match(result.reason ?? "", /multiple or invalid ref values/);
    assert.equal(git(f.a, "rev-parse", "refs/remotes/origin/topic").trim(), before);
    assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "base\n");
  });
}
