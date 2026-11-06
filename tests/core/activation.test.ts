import assert from "node:assert/strict";
import { access, chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { sessionActivation } from "../../src/core/activation.ts";
import { sessionKey } from "../../src/core/mailbox.ts";
import { hash } from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

test("failed pending enables preserve successful or later activation choices", async (t) => {
  const f = await fixture(t);
  const options = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "receiver" };
  const change = (token: string, phase: "begin" | "prepare" | "failure") =>
    sessionActivation(options, true, undefined, { token, phase, repositoryId: "a".repeat(64) });
  await change("first", "begin");
  await change("second", "begin");
  await change("first", "failure");
  assert.equal(await sessionActivation(options), false);
  await change("second", "failure");
  assert.equal(await sessionActivation(options), false);
  await change("prepared", "begin");
  await change("prepared", "prepare");
  assert.equal(await sessionActivation(options), false);
  await change("prepared", "failure");
  assert.equal(await sessionActivation(options), false);
  await change("a", "begin");
  await change("b", "begin");
  await change("a", "prepare");
  await change("b", "prepare");
  await change("a", "failure");
  assert.equal(await sessionActivation(options), false);
  await change("b", "failure");
  assert.equal(await sessionActivation(options), false);
  await change("third", "begin");
  await change("fourth", "begin");
  await sessionActivation(options, true);
  await change("fourth", "failure");
  assert.equal(await sessionActivation(options), true);
  await change("fifth", "begin");
  await sessionActivation(options, false);
  await change("fifth", "failure");
  assert.equal(await sessionActivation(options), false);
  assert.equal(await change("fifth", "prepare"), false);
  await change("one", "begin");
  await change("two", "begin");
  await sessionActivation(options, true, undefined, {
    token: "one",
    phase: "prepare",
    repositoryId: "a".repeat(64),
    run: async () => {},
  });
  await sessionActivation(options, false);
  assert.equal(await change("two", "prepare"), false);
  await change("later", "begin");
  assert.equal(
    await sessionActivation(options, true, undefined, {
      token: "later",
      phase: "prepare",
      repositoryId: "a".repeat(64),
      run: async () => {},
    }),
    true,
  );
});

test("activation defaults off without creating state and is isolated by native session, instance, worktree and ref", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "receiver" };
  assert.equal(await sessionActivation(options), false);
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
  await sessionActivation(options, true);
  assert.equal(await sessionActivation(options), true);
  for (const different of [
    { session: "other" },
    { instance: hash("new-instance") },
    { cwd: f.c },
    { adapter: "cli" },
    { ref: "refs/heads/other" },
  ])
    assert.equal(await sessionActivation({ ...options, ...different }), false);
  await sessionActivation(options, false);
  assert.equal(await sessionActivation(options), false);
});

test("activation is shared within one worktree, not a nested repository", async (t) => {
  const f = await fixture(t),
    sub = join(f.b, "sub"),
    nested = join(sub, "nested"),
    options = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "receiver" };
  await mkdir(nested, { recursive: true });
  git(nested, "init");
  await sessionActivation(options, true);
  assert.equal(await sessionActivation({ ...options, cwd: sub }), true);
  assert.equal(await sessionActivation({ ...options, cwd: nested }), false);
  await sessionActivation({ ...options, cwd: sub }, false);
  assert.equal(await sessionActivation(options), false);
  await sessionActivation({ ...options, cwd: sub }, true);
  assert.equal(await sessionActivation(options), true);
  assert.equal(await sessionActivation({ ...options, cwd: f.c }), false);
  const cliInstance = { ...options, adapter: "cli", instance: hash("native-instance") };
  await sessionActivation({ ...cliInstance, cwd: sub }, true);
  assert.equal(await sessionActivation(cliInstance), true);
  assert.equal(await sessionActivation({ ...cliInstance, instance: hash("other-instance") }), false);
});

test("legacy subdirectory activation never overrides a newer worktree choice", async (t) => {
  const f = await fixture(t),
    sub = join(f.b, "sub"),
    options = { cwd: sub, ref: "refs/heads/main", adapter: "codex", session: "receiver" },
    directory = join(f.root, "state", "activations");
  await mkdir(sub);
  await mkdir(directory, { recursive: true });
  const key = sessionKey({ root: sub }, options, options.ref);
  await writeFile(join(directory, `${key}.json`), JSON.stringify({ key, enabled: true }));
  assert.equal(await sessionActivation(options), true);
  await sessionActivation({ ...options, cwd: f.b }, false);
  assert.equal(await sessionActivation(options), false);
  await sessionActivation({ ...options, cwd: f.b }, true);
  assert.equal(await sessionActivation(options), true);
});

test("explicit Git worktrees outside cwd retain their activation", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.root, ref: "refs/heads/main", adapter: "codex", session: "receiver" },
    oldGitDir = process.env.GIT_DIR,
    oldWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = join(f.main, ".git");
  process.env.GIT_WORK_TREE = f.main;
  t.after(() => {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
    if (oldWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = oldWorkTree;
  });
  await sessionActivation(options, true);
  assert.equal(await sessionActivation(options), true);
  assert.equal(await sessionActivation({ ...options, session: "other" }), false);
  const bin = join(f.root, "bin"),
    previousPath = process.env.PATH;
  await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\nexit 128\n");
  await chmod(join(bin, "git"), 0o755);
  if (process.platform !== "win32") {
    process.env.PATH = bin;
    try {
      await assert.rejects(sessionActivation(options, false));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(await sessionActivation(options), true);
  }
  await sessionActivation(options, false);
  assert.equal(await sessionActivation(options), false);
});

test(
  "failed worktree discovery cannot silently disable the wrong path",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      sub = join(f.b, "sub"),
      bin = join(f.root, "bin"),
      options = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "receiver" },
      previousPath = process.env.PATH;
    await mkdir(sub);
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nexit 128\n");
    await chmod(join(bin, "git"), 0o755);
    await sessionActivation(options, true);
    process.env.PATH = bin;
    try {
      await assert.rejects(sessionActivation({ ...options, cwd: sub }, false));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(await sessionActivation(options), true);
    await sessionActivation({ ...options, cwd: sub }, false);
    assert.equal(await sessionActivation(options), false);
  },
);

test("invalid activation state and managed symlinks fail closed", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t),
    options = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "receiver" };
  const directory = join(f.root, "state", "activations");
  await mkdir(directory, { recursive: true });
  const key = sessionKey({ root: f.b }, options, options.ref);
  const path = join(directory, `${key}.json`);
  await writeFile(path, JSON.stringify({ key, enabled: "true" }));
  await assert.rejects(sessionActivation(options), /Invalid GitRelay activation/);
  await writeFile(
    path,
    JSON.stringify({ key, enabled: false, prepared: [{ token: "a", repositoryId: "a".repeat(64) }] }),
  );
  await assert.rejects(sessionActivation(options), /Invalid GitRelay activation/);
  await writeFile(
    path,
    JSON.stringify({
      key,
      enabled: false,
      committed: false,
      pending: ["a"],
      prepared: [{ token: "a", repositoryId: "a".repeat(64), subscriptionKey: "../outside" }],
    }),
  );
  await assert.rejects(sessionActivation(options), /Invalid GitRelay activation/);
  const other = { ...options, session: "symlink" };
  await symlink(path, join(directory, `${sessionKey({ root: f.b }, other, other.ref)}.json`));
  await assert.rejects(sessionActivation(other), /not a regular file/);
});

test(
  "pending activation does not follow a managed repos symlink",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      options = { cwd: f.b, ref: "refs/heads/main", adapter: "codex", session: "receiver" };
    const directory = join(f.root, "state", "activations"),
      key = sessionKey({ root: f.b }, options, options.ref);
    await mkdir(directory, { recursive: true });
    await mkdir(join(f.root, "outside"));
    await symlink(join(f.root, "outside"), join(f.root, "state", "repos"));
    await writeFile(
      join(directory, `${key}.json`),
      JSON.stringify({
        key,
        enabled: false,
        committed: false,
        pending: ["a"],
        prepared: [{ token: "a", repositoryId: "a".repeat(64) }],
      }),
    );
    await assert.rejects(sessionActivation(options), /Invalid GitRelay state directory/);
  },
);
