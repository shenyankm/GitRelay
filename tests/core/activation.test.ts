import assert from "node:assert/strict";
import { access, chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { requestedActivation, sessionActivation } from "../../src/core/activation.ts";
import { sessionKey } from "../../src/core/mailbox.ts";
import { hash } from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

test("only direct coordination requests opt a session in or out", () => {
  for (const text of [
    "启用 GitRelay",
    "请使用 GitRelay 协作",
    "请并行开发这个功能",
    "本次用多个工作树开发",
    "请在多工作树中并行实现",
    "Enable GitRelay",
    "Please use multiple worktrees for development",
    "Implement this feature in parallel",
    "Start parallel development",
  ])
    assert.equal(requestedActivation(text), true, text);
  for (const text of [
    "关闭 GitRelay",
    "请不要并行开发",
    "停止多工作树开发",
    "Disable GitRelay",
    "Please do not use multiple worktrees",
    "Don't use GitRelay",
    "Never enable GitRelay",
    "Don't work in parallel",
    "Please do not implement this feature in parallel",
    "Never develop in parallel",
  ])
    assert.equal(requestedActivation(text), false, text);
  for (const text of [
    undefined,
    "修复这个 bug",
    "解释一下并行开发",
    "能否用多工作树开发？",
    "What is parallel development?",
    "如果要并行开发再说",
    "> 请并行开发",
    "“请并行开发”是示例",
    "“Example:\nEnable GitRelay\n    ”",
    "「例:\nDisable GitRelay\n    」",
    "```text\nEnable GitRelay\n```",
    "~~~\nEnable GitRelay\n~~~",
    "~~~text\nDisable GitRelay\n~~~",
    "- ~~~\n  Enable GitRelay\n  ~~~",
    "+ ~~~\n  Disable GitRelay\n  ~~~",
    "- \t~~~\n    Enable GitRelay\n    ~~~",
    "  - ~~~\n    Disable GitRelay\n    ~~~",
    "1. ~~~\n   Enable GitRelay\n   ~~~",
    "10. ~~~~\n    Disable GitRelay\n    ~~~~",
    "- ```text\n  Enable GitRelay\n  ```",
    "~~~~\n~~~\nEnable GitRelay\n~~~~",
    "~~~\nEnable GitRelay",
    "Here:\n\n    Disable GitRelay\n",
    "Here:\n\n\tEnable GitRelay\n",
    "The documentation says enable GitRelay",
    "Review the parallel development implementation",
    "请修改提示词，不要并行开发",
    "Please explain how to use multiple worktrees",
    "Don't forget to use GitRelay",
    "Don't hesitate to use GitRelay",
    "Please don't forget to use GitRelay",
    "Don't skip using GitRelay",
    "Do not forget to enable GitRelay",
  ])
    assert.equal(requestedActivation(text), undefined, String(text));
  for (const text of ["不要关闭 GitRelay", "Don't disable GitRelay", "```text\nEnable GitRelay"])
    assert.equal(requestedActivation(text), undefined, text);
  assert.equal(requestedActivation("~~~\nDisable GitRelay\n~~~\nEnable GitRelay"), true);
  assert.equal(requestedActivation("10. ~~~\n    Disable GitRelay\n    ~~~\nEnable GitRelay"), true);
  assert.equal(requestedActivation("- ~~~\n  example\nDisable GitRelay"), false);
  assert.equal(requestedActivation("“Example:\nEnable GitRelay\n    ”\nDisable GitRelay"), false);
  assert.equal(requestedActivation("1. ~~~\n   example\nEnable GitRelay"), true);
  assert.equal(requestedActivation("- ~~~\n\n  Enable GitRelay\n  ~~~"), undefined);
  assert.equal(requestedActivation("- \t~~~\n        ~~~\n  Enable GitRelay"), true);
  assert.equal(requestedActivation("```example```\nEnable GitRelay"), true);
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
    { adapter: "opencode" },
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
  const openCode = { ...options, adapter: "opencode", instance: hash("native-instance") };
  await sessionActivation({ ...openCode, cwd: sub }, true);
  assert.equal(await sessionActivation(openCode), true);
  assert.equal(await sessionActivation({ ...openCode, instance: hash("other-instance") }), false);
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
  const other = { ...options, session: "symlink" };
  await symlink(path, join(directory, `${sessionKey({ root: f.b }, other, other.ref)}.json`));
  await assert.rejects(sessionActivation(other), /not a regular file/);
});
