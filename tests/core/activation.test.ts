import assert from "node:assert/strict";
import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { requestedActivation, sessionActivation } from "../../src/core/activation.ts";
import { sessionKey } from "../../src/core/mailbox.ts";
import { hash } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

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
    "```text\nEnable GitRelay\n```",
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
