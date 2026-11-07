import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildPlugin } from "../../scripts/build-plugin.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("source-linked plugin survives a cache copy and observes an explicit different worktree", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "gitbeacon plugin 'quoted' "));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, "source"),
    worktree = join(temp, "user worktree");
  await mkdir(source);
  for (const name of ["plugin", "dist"]) await cp(join(root, name), join(source, name), { recursive: true });
  await cp(join(root, "package.json"), join(source, "package.json"));
  await symlink(join(root, "node_modules"), join(source, "node_modules"), "dir");
  await mkdir(worktree);
  await exec("git", ["init", "-b", "main", worktree]);
  const state = join(temp, "shared state");
  const plugin = await buildPlugin(source, {
    GITBEACON_STATE_DIR: state,
    GITBEACON_MAIN_REF: "refs/heads/develop",
    SECRET: "must-not-copy",
  });
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const manifest = await readJson(join(plugin, ".codex-plugin/plugin.json"));
  assert.deepEqual(manifest, {
    ...(await readJson(join(source, "plugin/.codex-plugin/plugin.json"))),
    version: (await readJson(join(root, "package.json"))).version,
  });
  await assert.rejects(access(join(plugin, "plugin.json")), { code: "ENOENT" });
  await access(join(plugin, manifest.onboardingSkill));
  const market = await readJson(join(source, "build/local-plugin/.agents/plugins/marketplace.json"));
  assert.equal(market.name, "gitbeacon-local");
  const cached = join(temp, "cache 'copy'");
  await cp(plugin, cached, { recursive: true });
  const config = (await readJson(join(cached, ".mcp.json"))).mcpServers.gitbeacon;
  assert.deepEqual(config.env, { GITBEACON_STATE_DIR: state, GITBEACON_MAIN_REF: "refs/heads/develop" });
  const transport = new StdioClientTransport({
    ...config,
    cwd: cached,
    env: { ...process.env, ...config.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "plugin-test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: "repository_status", arguments: { cwd: worktree } });
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.equal(result.structuredContent.repository.root, await realpath(worktree));
  assert.equal(result.structuredContent.initialized, false);
  await assert.rejects(access(state), { code: "ENOENT" });
  await exec("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  await exec("git", ["-C", worktree, "branch", "develop"]);
  const joined = await client.callTool({ name: "join_session", arguments: { cwd: worktree } });
  assert.ok(!joined.isError, JSON.stringify(joined.content));
  assert.equal(joined.structuredContent.session.ref, "refs/heads/develop");
  const scope = {
    cwd: worktree,
    ref: joined.structuredContent.session.ref,
    sessionToken: joined.structuredContent.sessionToken,
  };
  const resumed = await client.callTool({ name: "join_session", arguments: scope });
  assert.equal(resumed.structuredContent.session.key, joined.structuredContent.session.key);
  const left = await client.callTool({ name: "leave_session", arguments: scope });
  assert.ok(!left.isError, JSON.stringify(left.content));
  const hooks = (await readJson(join(cached, "hooks/hooks.json"))).hooks;
  for (const name of Object.keys(hooks)) {
    const { stdout } = await exec(
      "/bin/sh",
      ["-c", `printf '%s' '${JSON.stringify({ hook_event_name: name })}' | ${hooks[name][0].hooks[0].command}`],
      { env: { ...process.env, PLUGIN_ROOT: cached } },
    );
    assert.equal(JSON.parse(stdout).hookSpecificOutput.hookEventName, name);
  }
  await buildPlugin(source, {});
  const clean = (await readJson(join(plugin, ".mcp.json"))).mcpServers.gitbeacon;
  assert.deepEqual(clean.env, {});
  await assert.rejects(buildPlugin(source, { GITBEACON_STATE_DIR: "relative" }), /absolute/);
});

test("reminders accept only supported events, never echo input, and fail open", async () => {
  const script = join(root, "plugin/hooks/remind.mjs");
  const run = (input) =>
    new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [script], (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr }),
      );
      child.stdin.end(input);
    });
  for (const name of ["SessionStart", "UserPromptSubmit"]) {
    const output = await run(
      JSON.stringify({ hook_event_name: name, prompt: "SECRET injected instructions", cwd: "SECRET" }),
    );
    const value = JSON.parse(output.stdout).hookSpecificOutput;
    assert.equal(value.hookEventName, name);
    assert.ok(value.additionalContext.length <= 500);
    assert.ok(!output.stdout.includes("SECRET"));
    assert.equal(output.stderr, "");
  }
  for (const input of ["{", "null", "[]", '{"hook_event_name":"Stop"}', "x".repeat(1024 * 1024 + 1)]) {
    const output = await run(input);
    assert.equal(output.stdout, "");
    assert.match(output.stderr, /continuing/);
  }
});
