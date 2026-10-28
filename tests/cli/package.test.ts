import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "../helpers.ts";

const exec = promisify(execFile);

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("package exposes the CLI and only Codex and OpenCode adapters", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.name, "git-relay");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.bin["git-relay"], "./dist/cli/main.js");
  assert.equal(manifest.bin["worktree-relay"], manifest.bin["git-relay"]);
  assert.equal(manifest.bin["worktree-sync"], manifest.bin["git-relay"]);
  assert.match(await read("README.md"), /^# GitRelay\n/);
  assert.ok(await read("dist/cli/main.js"));
  for (const name of ["publisher", "sessions", "cleanup", "daemon-state", "daemon"])
    assert.ok(await read(`dist/core/${name}.js`));
  for (const name of ["maintenance", "acceptance"]) assert.ok(await read(`docs/${name}.md`));
  assert.equal(manifest.pi, undefined);
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], undefined);
  assert.ok(await read("src/adapters/opencode/index.ts"));
  const skill = await read("skills/worktree-coordination/SKILL.md");
  assert.match(skill, /^---\nname: worktree-coordination\ndescription:/);
  assert.match(skill, /first check establishes a baseline/);
  for (const agent of ["codex"]) {
    const hooks = JSON.parse(await read(`src/adapters/${agent}/hooks.json`));
    assert.ok(hooks.hooks);
    assert.ok(JSON.stringify(hooks).includes(`git-relay hook ${agent}`));
  }
});

test(
  "Codex plugin bundles its runtime and runs hooks from an installed path containing spaces",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    await exec(process.execPath, [join(root, "scripts/build-codex-plugin.mjs")]);
    const installed = join(f.root, "installed plugin");
    await cp(join(root, ".codex/plugin-build"), installed, { recursive: true });
    const installedPackage = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(installedPackage.license, "MIT");
    assert.equal(await readFile(join(installed, "LICENSE"), "utf8"), await read("LICENSE"));
    assert.equal(await readFile(join(installed, "CONTRIBUTING.md"), "utf8"), await read("CONTRIBUTING.md"));
    assert.equal(await readFile(join(installed, "CHANGELOG.md"), "utf8"), await read("CHANGELOG.md"));
    const plugin = JSON.parse(await readFile(join(installed, ".codex-plugin/plugin.json"), "utf8"));
    const catalog = JSON.parse(await read(".agents/plugins/marketplace.json"));
    assert.equal(catalog.plugins[0].name, plugin.name);
    assert.equal(plugin.interface.displayName, "GitRelay");
    assert.equal(plugin.interface.category, "Developer Tools");
    assert.equal(catalog.plugins[0].category, "Developer Tools");
    assert.equal(plugin.license, "MIT");
    assert.ok([...plugin.interface.shortDescription].length <= 30);
    assert.ok(plugin.interface.defaultPrompt.length <= 3);
    for (const prompt of plugin.interface.defaultPrompt) assert.ok([...prompt].length <= 128);
    for (const key of ["logo", "composerIcon"]) {
      const asset = await readFile(join(installed, plugin.interface[key]), "utf8");
      assert.match(asset, /<svg\b/);
      assert.match(asset, /viewBox="0 0 128 128"/);
    }
    for (const name of ["git-relay", "git-relay-sync", "git-relay-help", "worktree-coordination"]) {
      await access(join(installed, plugin.skills, name, "SKILL.md"));
      await access(join(installed, plugin.skills, name, "agents/openai.yaml"));
    }
    await access(join(installed, "docs/integrations.md"));
    await assert.rejects(access(join(installed, "node_modules")));
    assert.match(await readFile(join(installed, "dist/vendor/smol-toml/LICENSE"), "utf8"), /Redistribution and use/);
    const hooks = JSON.parse(await readFile(join(installed, plugin.hooks), "utf8"));
    const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(!command.includes("auto-sync"));
    const child = exec("/bin/sh", ["-c", command], { cwd: f.b, env: { ...process.env, PLUGIN_ROOT: installed } });
    child.child.stdin!.end(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "Enable GitRelay",
        session_id: "installed-plugin",
        cwd: f.b,
      }),
    );
    const result = JSON.parse((await child).stdout);
    assert.match(result.systemMessage, /feature\/b/);
    assert.match(result.systemMessage, /Auto-sync.*Off/);
  },
);
