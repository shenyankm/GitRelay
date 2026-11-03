import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { ensureWorkspace } from "../../src/cli/install-codex.ts";

test("an existing workspace does not allocate new stages", { skip: process.platform === "win32" }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "git-relay-workspace-repeat-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  await ensureWorkspace(root);
  const original = await readlink(root);
  const names = await readdir(parent);
  await Promise.all(Array.from({ length: 4 }, () => ensureWorkspace(root)));
  assert.equal(await readlink(root), original);
  assert.deepEqual((await readdir(parent)).sort(), names.sort());
});

test("an EEXIST winner may reference our stage", { skip: process.platform === "win32" }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "git-relay-workspace-adopt-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const original = fs.promises.symlink;
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args) => {
    warnings.push(args.join(" "));
  };
  fs.promises.symlink = async (target, path, type) => {
    if (String(path) === root) await original(target, path, type);
    return original(target, path, type);
  };
  syncBuiltinESMExports();
  try {
    await ensureWorkspace(root);
    const stage = join(parent, await readlink(root));
    assert.equal(await readFile(join(root, ".git-relay-owner"), "utf8"), "git-relay installer v1\n");
    assert.equal((await lstat(stage)).isDirectory(), true);
    assert.ok(warnings.some((message) => message.includes(stage) && message.includes("may be in use")));
  } finally {
    fs.promises.symlink = original;
    console.warn = warn;
    syncBuiltinESMExports();
  }
});

test("a failed publication preserves files added to the stage", { skip: process.platform === "win32" }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "git-relay-workspace-failure-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const original = fs.promises.symlink;
  const warn = console.warn;
  const warnings: string[] = [];
  let stage = "";
  console.warn = (...args) => {
    warnings.push(args.join(" "));
  };
  fs.promises.symlink = async (target, path, type) => {
    if (String(path) !== root) return original(target, path, type);
    stage = join(dirname(root), String(target));
    await writeFile(join(stage, "user-file"), "keep");
    throw Object.assign(new Error("injected failure"), { code: "EACCES" });
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(ensureWorkspace(root), { code: "EACCES" });
    assert.equal(await readFile(join(stage, "user-file"), "utf8"), "keep");
    assert.ok(warnings.some((message) => message.includes(stage)));
  } finally {
    fs.promises.symlink = original;
    console.warn = warn;
    syncBuiltinESMExports();
  }
});

test("a workspace owner marker collision preserves the original error and data", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "git-relay-workspace-owner-collision-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const original = fs.promises.writeFile;
  const warn = console.warn;
  const warnings: string[] = [];
  let marker = "";
  console.warn = (...args) => {
    warnings.push(args.join(" "));
  };
  fs.promises.writeFile = async (path, data, options) => {
    if (basename(String(path)) === ".git-relay-owner") {
      marker = String(path);
      await original(path, "foreign data");
      throw Object.assign(new Error("injected owner collision"), { code: "EEXIST" });
    }
    return original(path, data, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(ensureWorkspace(root), { code: "EEXIST", message: "injected owner collision" });
    assert.equal(await readFile(marker, "utf8"), "foreign data");
    assert.ok(warnings.some((message) => message.includes(dirname(marker))));
  } finally {
    fs.promises.writeFile = original;
    console.warn = warn;
    syncBuiltinESMExports();
  }
});

test("concurrent workspace publication retains the losing stage", { skip: process.platform === "win32" }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "git-relay-workspace-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const original = fs.promises.symlink;
  const warn = console.warn;
  const warnings: string[] = [];
  const stages: string[] = [];
  let release!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  console.warn = (...args) => {
    warnings.push(args.join(" "));
  };
  fs.promises.symlink = async (target, path, type) => {
    if (String(path) === root) {
      stages.push(join(parent, String(target)));
      if (stages.length === 2) release();
      await bothReady;
    }
    return original(target, path, type);
  };
  syncBuiltinESMExports();
  try {
    await Promise.all([ensureWorkspace(root), ensureWorkspace(root)]);
    assert.equal(stages.length, 2);
    assert.equal(await readFile(join(root, ".git-relay-owner"), "utf8"), "git-relay installer v1\n");
    for (const stage of stages) assert.equal((await lstat(stage)).isDirectory(), true);
    const winner = join(parent, await readlink(root));
    const loser = stages.find((stage) => stage !== winner);
    assert.ok(loser && warnings.some((message) => message.includes(loser)));
  } finally {
    fs.promises.symlink = original;
    console.warn = warn;
    syncBuiltinESMExports();
  }
});
