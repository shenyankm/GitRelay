import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { fixture } from "../helpers.ts";
import { connectMcp } from "./helpers.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test(
  "production tarball installs its MCP dependencies and runs without source or legacy plugin surfaces",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const { stdout } = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", f.root], {
      cwd: root,
    });
    const packed = JSON.parse(stdout)[0];
    const paths = packed.files.map((file: { path: string }) => file.path);
    assert.ok(paths.includes("dist/mcp/main.js"));
    assert.ok(paths.includes("README.zh-CN.md"));
    assert.ok(
      !paths.some((path: string) =>
        /^(?:src\/|skills\/|vendor\/|\.codex-plugin\/|dist\/cli\/|dist\/adapters\/|dist\/web\/)/.test(path),
      ),
    );
    assert.ok(!paths.some((path: string) => path.startsWith("docs/evidence/") || path === "docs/performance.md"));
    const project = join(f.root, "production install with spaces");
    await mkdir(project);
    await exec(
      "npm",
      ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(f.root, packed.filename)],
      { cwd: project, timeout: 90000 },
    );
    const installed = join(project, "node_modules", "@sistine29", "git-relay");
    const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.deepEqual(pkg.bin, { "git-relay": "./dist/mcp/main.js" });
    assert.deepEqual(Object.keys(pkg.exports), ["."]);
    await assert.rejects(access(join(installed, "src")), { code: "ENOENT" });
    await assert.rejects(access(join(project, "node_modules", "typescript")), { code: "ENOENT" });
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from 'node:assert/strict';
      import * as api from '@sistine29/git-relay';
      assert.deepEqual(Object.keys(api), ['createGitRelayServer']);
      const runtime = api.createGitRelayServer({ cwd: process.argv[1] });
      assert.equal(typeof runtime.server.registerTool, 'function');
      await runtime.close();
    `,
        f.b,
      ],
      { cwd: project },
    );
    const { call } = await connectMcp(t, f.b, join(installed, "dist/mcp/main.js"));
    assert.equal((await call("branch_status")).worktree.branch, "feature/b");
    const { stdout: help } = await exec(process.execPath, [join(installed, "dist/mcp/main.js"), "--help"]);
    assert.match(help, /MCP server/);
    await assert.rejects(exec(process.execPath, [join(installed, "dist/mcp/main.js"), "hook", "codex"]));
  },
);
