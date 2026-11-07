import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { addWorktree } from "../../src/core/git.ts";
import { fixture } from "../helpers.ts";
import { connectMcp } from "./helpers.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);

test("the source project stays private without npm distribution entry points or lifecycle builds", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.private, true);
  for (const field of ["bin", "files", "exports", "types", "publishConfig"])
    assert.equal(Object.hasOwn(pkg, field), false, field);
  for (const metadata of [lock, lock.packages[""]]) {
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
  }
  assert.equal(Object.hasOwn(lock.packages[""], "bin"), false);
  assert.equal(Object.hasOwn(pkg.scripts, "prepare"), false);
  assert.equal(Object.hasOwn(pkg.scripts, "check:release"), false);
  assert.doesNotMatch(
    `${pkg.scripts.check}\n${pkg.scripts.test}`,
    /npm\s+(?:pack|publish)|check-release|package\.integration/,
  );
});

test("the built source entry serves stdio from a worktree with spaces without a package shim or declarations", async (t) => {
  const f = await fixture(t);
  const cwd = await addWorktree(f.main, join(f.root, "worktree with spaces"), "source-runtime", true);
  const entry = join(root, "dist", "mcp", "main.js");
  await access(entry);
  await assert.rejects(access(join(root, "dist", "index.js")), { code: "ENOENT" });
  const output = await readdir(join(root, "dist"), { recursive: true, withFileTypes: true });
  assert.ok(output.every((entry) => !entry.name.endsWith(".d.ts")));
  const { call, stderr } = await connectMcp(t, cwd, entry);
  assert.equal((await call("branch_status")).worktree.branch, "source-runtime");
  assert.equal(stderr(), "");
  const { stdout: help } = await exec(process.execPath, [entry, "--help"], { cwd: f.root });
  assert.match(help, /GitRelay MCP server/);
  assert.match(help, /Usage: node .*dist\/mcp\/main\.js/);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { stdout: version } = await exec(process.execPath, [entry, "--version"], { cwd: f.root });
  assert.equal(version.trim(), pkg.version);
  await assert.rejects(exec(process.execPath, [entry, "hook", "codex"], { cwd: f.root }));
});
