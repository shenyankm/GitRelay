import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { installCodex, uninstallCodex } from "../../src/cli/install-codex.ts";
import { installerDigest } from "../../src/cli/installer-digest.ts";

const exec = promisify(execFile);

async function waitForGroupGone(group: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(-group, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Process group ${group} remained after cancellation`);
}

async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-codex-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  const sourceRoot = join(dir, "source");
  const codexHome = join(dir, "codex home");
  const bin = join(dir, "bin");
  const source = fileURLToPath(new URL("../../", import.meta.url));
  await mkdir(workspace);
  await writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
  await mkdir(sourceRoot);
  await cp(join(source, "dist"), join(sourceRoot, "dist"), { recursive: true });
  await mkdir(bin);
  const codex = join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n");
  await chmod(codex, 0o755);
  await mkdir(join(codexHome, "plugins", "cache"), { recursive: true });
  const config = join(codexHome, "config.toml");
  const cache = join(codexHome, "plugins", "cache", "user-file");
  await writeFile(config, "model = 'user-model'\n");
  await writeFile(cache, "user cache\n");
  const env = { ...process.env, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH ?? ""}` };
  return { workspace, sourceRoot, codexHome, config, cache, codex, env, hook: join(codexHome, "hooks.json") };
}

test(
  "Codex upgrades legacy digests and rejects a modified runtime",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.sourceRoot, "dist", "changes.js"), "changes");
    await writeFile(join(f.sourceRoot, "dist", "cleanup.js"), "cleanup");
    await installCodex(f);
    const state = join(f.workspace, "codex-hooks.json"),
      record = JSON.parse(await readFile(state, "utf8"));
    const legacy = `${record.current.slice(0, 21)}${await installerDigest(join(f.sourceRoot, "dist"), undefined, "cs")}`;
    assert.notEqual(legacy, record.current);
    await rename(
      join(f.workspace, "runtimes", record.current.slice(21)),
      join(f.workspace, "runtimes", legacy.slice(21)),
    );
    await rename(join(f.workspace, "codex-revisions", record.current), join(f.workspace, "codex-revisions", legacy));
    await writeFile(state, JSON.stringify({ ...record, current: legacy }));
    await writeFile(join(f.sourceRoot, "dist", "upgrade"), "new source");
    await writeFile(join(f.workspace, "runtimes", legacy.slice(21), "dist", "tampered"), "x");
    await assert.rejects(installCodex(f), /runtime was modified/);
    await rm(join(f.workspace, "runtimes", legacy.slice(21), "dist", "tampered"));
    await installCodex(f);
    assert.notEqual(JSON.parse(await readFile(state, "utf8")).current, legacy);
  },
);

test(
  "Codex preserves a symlinked installation record and its target",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await installCodex(f);
    const state = join(f.workspace, "codex-hooks.json"),
      target = join(f.workspace, "codex.saved.json");
    const saved = await readFile(state, "utf8"),
      hooks = await readFile(f.hook, "utf8");
    await rename(state, target);
    await symlink("codex.saved.json", state);
    await assert.rejects(installCodex(f), /Invalid Codex installation record/);
    await assert.rejects(uninstallCodex(f), /Invalid Codex installation record/);
    assert.equal(await readlink(state), "codex.saved.json");
    assert.equal(await readFile(target, "utf8"), saved);
    assert.equal(await readFile(f.hook, "utf8"), hooks);
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
  },
);

test(
  "Codex recovers a lost anchor after the user preserves and removes the entry",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await installCodex(f);
    const record = JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8"));
    const original = await readFile(f.hook, "utf8");
    await rm(join(f.codexHome, record.anchor));
    await assert.rejects(uninstallCodex(f), /ownership cannot be established/);
    await assert.rejects(installCodex(f), /ownership cannot be established/);
    assert.equal(await readFile(f.hook, "utf8"), original);
    const backup = join(f.codexHome, "saved-hooks.json");
    await rename(f.hook, backup);
    const archive = join(record.entry, "..", ".git-relay-codex-removed-abc", "hooks.json");
    await mkdir(join(f.codexHome, ".git-relay-codex-removed-abc"));
    await writeFile(archive, "preserve pending archive");
    await writeFile(join(f.workspace, "codex-hooks.json"), JSON.stringify({ ...record, removing: archive }));
    await assert.rejects(uninstallCodex(f), /ownership cannot be established/);
    assert.equal(await readFile(archive, "utf8"), "preserve pending archive");
    await writeFile(join(f.workspace, "codex-hooks.json"), JSON.stringify(record));
    await uninstallCodex(f);
    await installCodex(f);
    assert.equal(await readFile(backup, "utf8"), original);
    assert.equal(await readFile(f.hook, "utf8"), original);
  },
);

test(
  "Codex reinstalls a missing owned runtime and upgrades after it is removed",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await installCodex(f);
    const state = join(f.workspace, "codex-hooks.json");
    const runtime = () =>
      readFile(state, "utf8").then((value) => join(f.workspace, "runtimes", JSON.parse(value).current.slice(21)));
    const first = await runtime();
    await rm(first, { recursive: true });
    await installCodex(f);
    assert.ok((await stat(join(first, "dist"))).isDirectory());
    await rm(join(first, "dist"), { recursive: true });
    await writeFile(join(first, "user-data"), "preserve");
    await assert.rejects(installCodex(f), /runtime is incomplete or was modified; preserved/);
    assert.equal(await readFile(join(first, "user-data"), "utf8"), "preserve");
    await rm(first, { recursive: true });
    await writeFile(join(f.sourceRoot, "dist", "upgrade-marker.txt"), "upgrade");
    await installCodex(f);
    assert.notEqual(await runtime(), first);
    assert.equal(await readFile(join(await runtime(), "dist", "upgrade-marker.txt"), "utf8"), "upgrade");
  },
);

test("Codex preserves an existing incomplete runtime directory", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await installCodex(f);
  const id = JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).current.slice(21);
  const workspace = join(f.workspace, "other-workspace"),
    runtime = join(workspace, "runtimes", id);
  await mkdir(runtime, { recursive: true });
  await writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
  const inode = await stat(runtime);
  const options = { ...f, workspace, env: { ...f.env, CODEX_HOME: join(workspace, "codex-home") } };
  await assert.rejects(installCodex(options), /runtime is incomplete or was modified; preserved/);
  assert.equal((await stat(runtime)).ino, inode.ino);
  assert.deepEqual(await readdir(runtime), []);
  await writeFile(join(runtime, "user-data"), "preserve");
  await assert.rejects(installCodex(options), /runtime is incomplete or was modified; preserved/);
  assert.equal((await stat(runtime)).ino, inode.ino);
  assert.equal(await readFile(join(runtime, "user-data"), "utf8"), "preserve");
});

test(
  "Codex user hooks install, repeat, upgrade, uninstall and reinstall preserve user data",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await installCodex(f);
    const contents = await readFile(f.hook, "utf8");
    const hooks = JSON.parse(contents).hooks;
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) assert.ok(hooks[event]);
    const inode = await stat(f.hook);
    await installCodex(f);
    assert.equal(await readFile(f.hook, "utf8"), contents);
    assert.equal((await stat(f.hook)).ino, inode.ino);

    await writeFile(join(f.sourceRoot, "dist", "upgrade-marker.txt"), "second runtime\n");
    await installCodex(f);
    assert.equal(await readFile(f.hook, "utf8"), contents);
    assert.equal((await stat(f.hook)).ino, inode.ino);
    const beforeBroken = JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).current;

    await rm(join(f.sourceRoot, "dist", "cli", "main.js"));
    await assert.rejects(installCodex(f));
    assert.equal(await readFile(f.hook, "utf8"), contents);
    assert.equal((await stat(f.hook)).ino, inode.ino);
    assert.equal(JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).current, beforeBroken);

    const archive = await uninstallCodex(f);
    assert.ok(archive);
    assert.equal(await readFile(archive, "utf8"), contents);
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    await cp(
      join(fileURLToPath(new URL("../../", import.meta.url)), "dist", "cli", "main.js"),
      join(f.sourceRoot, "dist", "cli", "main.js"),
    );
    await installCodex(f);
    assert.notEqual((await stat(f.hook)).ino, (await stat(archive)).ino);
    await writeFile(archive, "archived user edit\n");
    assert.equal(await readFile(f.hook, "utf8"), contents);
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
    assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
  },
);

test(
  "Codex never adopts an existing or replaced user hooks file",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.hook, "user hooks\n");
    await assert.rejects(installCodex(f), /owned|exists|preserv/i);
    assert.equal(await readFile(f.hook, "utf8"), "user hooks\n");
    await rm(f.hook);
    await installCodex(f);
    const contents = await readFile(f.hook, "utf8");
    await rm(f.hook);
    await writeFile(f.hook, contents, { flag: "wx" });
    await assert.rejects(installCodex(f), /owned|ownership|modified|preserv/i);
    await assert.rejects(uninstallCodex(f), /owned|ownership|modified|preserv/i);
    assert.equal(await readFile(f.hook, "utf8"), contents);
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
    assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
  },
);

test("Codex installer does not adopt an unowned workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "git-relay-codex-unowned-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await assert.rejects(installCodex({ workspace, sourceRoot: workspace }));
});

test("Codex reports unsupported Windows before writing hooks", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(installCodex(f), /not supported on Windows/);
  await assert.rejects(readFile(f.hook), { code: "ENOENT" });
  assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
});

test(
  "CLI reports Codex hooks pending trust rather than claiming delivery is configured",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      f.codex,
      "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'codex-cli 0.164.0\\n'; else printf '%s\\n' '{\"installed\":[]}'; fi\n",
    );
    const env = { ...f.env, XDG_DATA_HOME: join(f.sourceRoot, "data") };
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const run = (args: string[]) => exec(process.execPath, ["--experimental-strip-types", cli, ...args], { env });
    const result = JSON.parse((await run(["install", "--platform", "codex"])).stdout);
    const codex = result.results.find((item: { platform: string }) => item.platform === "codex");
    assert.equal(result.failed, false);
    assert.equal(codex.status, "pending-trust");
    assert.match(codex.action, /\/hooks/);
    await readFile(f.hook);
    const removed = JSON.parse((await run(["uninstall", "--platform", "codex"])).stdout);
    const item = removed.results.find((value: { platform: string }) => value.platform === "codex");
    assert.equal(item.status, "removed");
    await readFile(item.archive);
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
    assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
  },
);

test(
  "Codex user hooks do not duplicate a legacy managed plugin installation",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const legacy = join(f.workspace, "codex-install.json");
    await writeFile(legacy, '{"pluginOwned":true}\n');
    await assert.rejects(installCodex(f), /legacy|existing|plugin/i);
    assert.equal(await readFile(legacy, "utf8"), '{"pluginOwned":true}\n');
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
    assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
  },
);

test(
  "Codex checks inline hooks without starting an app server or changing user files",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const appServer = join(f.workspace, "app-server-started"),
      database = join(f.sourceRoot, "user-db"),
      logs = join(f.sourceRoot, "user-logs");
    await mkdir(database);
    await mkdir(logs);
    await writeFile(
      f.codex,
      '#!/bin/sh\nif [ "$1" = app-server ]; then : > "$GITRELAY_APP_SERVER"; exit 9; fi\nprintf \'%s\\n\' \'{"installed":[]}\'\n',
    );
    const config = `sqlite_home = ${JSON.stringify(database)}\nlog_dir = ${JSON.stringify(logs)}\n# git-relay documentation\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo 'git-relay is useful'"\n`;
    await writeFile(f.config, config);
    const env = { ...f.env, GITRELAY_APP_SERVER: appServer };
    await installCodex({ ...f, env });
    assert.equal(await readFile(f.config, "utf8"), config);
    await assert.rejects(readFile(appServer), { code: "ENOENT" });
    assert.deepEqual(await readdir(database), []);
    assert.deepEqual(await readdir(logs), []);
    await uninstallCodex({ ...f, env });
    const unrelated =
      '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "node /projects/git-relay/tools/audit.js"\n';
    await writeFile(f.config, unrelated);
    await installCodex({ ...f, env });
    assert.equal(await readFile(f.config, "utf8"), unrelated);
    await uninstallCodex({ ...f, env });
    const unknown = '[[hooks.FutureEvent]]\nnote = "keep user content"\n';
    await writeFile(f.config, unknown);
    await assert.rejects(
      installCodex({ ...f, env, clientVersion: "0.165.0" }),
      /Cannot verify unknown Codex hook event/,
    );
    assert.equal(await readFile(f.config, "utf8"), unknown);
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    await installCodex({ ...f, env, clientVersion: "0.164.0" });
    assert.equal(await readFile(f.config, "utf8"), unknown);
    await uninstallCodex({ ...f, env });
    for (const command of [
      "git-relay hook codex",
      "sh -c 'worktree-relay hook codex'",
      "node /tmp/codex-current.mjs hook codex",
    ]) {
      const text = `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\n`;
      await writeFile(f.config, text);
      await assert.rejects(installCodex({ ...f, env }), /inline hooks.*already contain GitRelay/);
      assert.equal(await readFile(f.config, "utf8"), text);
      await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    }
    const encoded =
      '["\\u0068ooks"]\nSessionStart = [{ hooks = [{ type = "command", command = "git-relay hook codex" }] }]\n';
    await writeFile(f.config, encoded);
    await assert.rejects(installCodex({ ...f, env }), /inline hooks.*already contain GitRelay/);
    assert.equal(await readFile(f.config, "utf8"), encoded);
    await writeFile(f.config, "[hooks\n");
    await assert.rejects(installCodex({ ...f, env }), /Cannot inspect Codex configuration/);
    assert.equal(await readFile(f.config, "utf8"), "[hooks\n");
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
  },
);

test(
  "Codex checks inline hooks in symlinked profile files without creating a temporary copy",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const profile = join(f.codexHome, "test.config.toml"),
      target = join(f.sourceRoot, "profile.toml");
    const text =
      '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "git-relay hook codex"\n';
    await writeFile(target, text);
    await symlink(target, profile);
    await assert.rejects(installCodex(f), /inline hooks.*already contain GitRelay/);
    assert.equal(await readFile(profile, "utf8"), text);
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    await rm(target);
    await assert.rejects(installCodex(f), /Cannot inspect Codex configuration/);
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
  },
);

test("Codex accepts inline matcher groups without handlers", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const profile = join(f.codexHome, "work.config.toml");
  const config = "[[hooks.SessionStart]]\n";
  const profileConfig = '[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n';
  await writeFile(f.config, config);
  await writeFile(profile, profileConfig);
  await installCodex(f);
  assert.equal(await readFile(f.config, "utf8"), config);
  assert.equal(await readFile(profile, "utf8"), profileConfig);
  assert.ok(await readFile(f.hook, "utf8"));
});

test(
  "Codex refuses malformed known inline hook events and handlers",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const profile = join(f.codexHome, "work.config.toml");
    const invalid = [
      '[hooks]\nSessionStart = "git-relay hook codex"\n',
      '[[hooks.Stop]]\nhooks = "invalid"\n',
      '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\n',
      '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "mcp_tool"\nserver = "example"\n',
    ];
    for (const text of invalid) {
      for (const path of [f.config, profile]) {
        await writeFile(path, text);
        await assert.rejects(installCodex(f), /Cannot interpret Codex inline hooks/);
        assert.equal(await readFile(path, "utf8"), text);
        await assert.rejects(readFile(f.hook), { code: "ENOENT" });
        if (path === f.config) await writeFile(f.config, "model = 'user-model'\n");
        else await rm(profile);
      }
    }
  },
);

test(
  "CLI uses the detected Codex version when checking unknown hook events",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const config = '[[hooks.FutureEvent]]\nnote = "keep user content"\n';
    await writeFile(f.config, config);
    const env = { ...f.env, XDG_DATA_HOME: join(f.sourceRoot, "data") };
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const run = (args: string[]) => exec(process.execPath, ["--experimental-strip-types", cli, ...args], { env });
    const command = (version: string) =>
      `#!/bin/sh\nif [ "$1" = --version ]; then printf 'codex-cli ${version}\\n'; else printf '%s\\n' '{"installed":[]}'; fi\n`;
    await writeFile(f.codex, command("0.165.0"));
    const error = await run(["install", "--platform", "codex", "--allow-unverified"]).then(
      () => null,
      (failure) => failure,
    );
    assert.equal(JSON.parse(error.stdout).failed, true);
    assert.match(error.stdout, /Cannot verify unknown Codex hook event/);
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    await writeFile(f.codex, command("0.164.0"));
    const result = JSON.parse((await run(["install", "--platform", "codex"])).stdout);
    assert.equal(result.results[0].status, "pending-trust");
    assert.equal(await readFile(f.config, "utf8"), config);
  },
);

test(
  "Codex preserves oversized or non-UTF-8 configuration without publishing hooks",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    for (const data of [Buffer.alloc(2 * 1024 * 1024 + 1, 0x23), Buffer.from([0xff, 0xfe])]) {
      await writeFile(f.config, data);
      await assert.rejects(installCodex(f), /Cannot inspect Codex configuration/);
      assert.deepEqual(await readFile(f.config), data);
      await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    }
  },
);

test(
  "Codex refuses a FIFO configuration without blocking",
  { skip: process.platform === "win32", timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const backup = join(f.codexHome, "user-config-backup");
    await copyFile(f.config, backup);
    await rm(f.config);
    await exec("mkfifo", [f.config]);
    await assert.rejects(installCodex(f), /Cannot inspect Codex configuration/);
    assert.ok((await stat(f.config)).isFIFO());
    assert.equal(await readFile(backup, "utf8"), "model = 'user-model'\n");
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
  },
);

test(
  "Codex withdraws newly published hooks if an inline relay hook appears during installation",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const first = join(f.sourceRoot, "plugin-list-first");
    const changed =
      '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "git-relay hook codex"\n';
    await writeFile(
      f.codex,
      '#!/bin/sh\nif [ -e "$GITRELAY_TEST_FIRST" ]; then printf \'%s\\n\' "$GITRELAY_TEST_CONFIG" > "$CODEX_HOME/config.toml"; else : > "$GITRELAY_TEST_FIRST"; fi\nprintf \'%s\\n\' \'{"installed":[]}\'\n',
    );
    const env = { ...f.env, GITRELAY_TEST_FIRST: first, GITRELAY_TEST_CONFIG: changed.trimEnd() };
    await assert.rejects(installCodex({ ...f, env }), /inline hooks.*already contain GitRelay/);
    assert.equal(await readFile(f.config, "utf8"), changed);
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    const record = JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8"));
    assert.equal(record.removed, true);
    assert.equal(await readFile(record.archive, "utf8"), record.content);
    assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
  },
);

test(
  "Codex preserves existing hooks when plugin inspection finds a conflict or fails",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const original = '{"hooks":{"SessionStart":[]}}\n';
    await writeFile(f.hook, original);
    for (const script of [
      'printf \'%s\\n\' \'{"installed":[{"name":"git-relay","enabled":false}]}\'',
      "exit 3",
      "printf '%s\\n' '{\"installed\":{}}'",
    ]) {
      await writeFile(f.codex, `#!/bin/sh\n${script}\n`);
      await assert.rejects(installCodex(f), /plugin|inspect|interpret/i);
      assert.equal(await readFile(f.hook, "utf8"), original);
      assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
      assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
    }
  },
);

test(
  "Codex allows a slow successful plugin inspection without assuming a timeout is empty",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const marker = join(f.workspace, "slow-plugin-check");
    const env = { ...f.env, PATH: join(f.sourceRoot, "..", "bin"), GITRELAY_TEST_MARKER: marker };
    await writeFile(
      f.codex,
      '#!/bin/sh\nif [ ! -e "$GITRELAY_TEST_MARKER" ]; then : > "$GITRELAY_TEST_MARKER"; /bin/sleep 11; else printf x >> "$GITRELAY_TEST_MARKER"; fi\nprintf \'%s\\n\' \'{"installed":[]}\'\n',
    );
    const start = Date.now();
    await installCodex({ ...f, env });
    assert.ok(Date.now() - start >= 10000);
    assert.equal(await readFile(marker, "utf8"), "x");
    assert.ok(JSON.parse(await readFile(f.hook, "utf8")).hooks.SessionStart);
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
    assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
  },
);

test(
  "Codex refuses installation when plugin inspection actually times out",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const parentPid = join(f.workspace, "fake-codex-pid");
    const childPid = join(f.workspace, "fake-child-pid");
    const env = {
      ...f.env,
      PATH: join(f.sourceRoot, "..", "bin"),
      GITRELAY_PARENT_PID: parentPid,
      GITRELAY_CHILD_PID: childPid,
    };
    await writeFile(
      f.codex,
      '#!/bin/sh\ntrap \'\' TERM\n/bin/sleep 1\necho $$ > "$GITRELAY_PARENT_PID"\n/bin/sh -c \'trap "" TERM; echo $$ > "$GITRELAY_CHILD_PID"; while :; do /bin/sleep 1; done\' &\nwait\n',
    );
    const module = pathToFileURL(fileURLToPath(new URL("../../src/cli/install-codex.ts", import.meta.url))).href;
    const options = JSON.stringify({ workspace: f.workspace, sourceRoot: f.sourceRoot });
    const script = `
    const original = globalThis.setTimeout;
    const { readFileSync } = await import('node:fs');
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== 60000) return original(callback, delay, ...args);
      // Fire the simulated deadline only after both fixture processes exist.
      const expire = () => {
        try {
          if ([process.env.GITRELAY_PARENT_PID, process.env.GITRELAY_CHILD_PID].every(
            path => /^[1-9][0-9]*\\n$/.test(readFileSync(path, 'utf8'))
          )) { callback(...args); return; }
        } catch {}
        original(expire, 10);
      };
      return original(expire, 10);
    };
    const { installCodex } = await import(${JSON.stringify(module)});
    try { await installCodex(${options}); process.exitCode = 1; }
    catch (error) { if (!/Cannot inspect Codex plugins/.test(error.message)) throw error; }
  `;
    let stopped = false;
    try {
      await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
        env,
        timeout: 10000,
      });
      const group = Number(await readFile(parentPid, "utf8"));
      const child = Number(await readFile(childPid, "utf8"));
      assert.ok(Number.isInteger(group) && group > 0 && Number.isInteger(child) && child > 0);
      await waitForGroupGone(group);
      stopped = true;
      await assert.rejects(readFile(f.hook), { code: "ENOENT" });
      await assert.rejects(readFile(join(f.workspace, "codex-hooks.json")), { code: "ENOENT" });
      assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
      assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
    } finally {
      if (!stopped)
        try {
          const pid = Number(await readFile(parentPid, "utf8"));
          if (Number.isInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
        } catch {
          /* Test process already exited. */
        }
    }
  },
);

test(
  "interrupting Codex installation kills a hung inspection process group",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const parentPid = join(f.workspace, "interrupted-codex-pid");
    const childPid = join(f.workspace, "interrupted-child-pid");
    const data = join(f.sourceRoot, "data");
    const env = { ...f.env, XDG_DATA_HOME: data, GITRELAY_PARENT_PID: parentPid, GITRELAY_CHILD_PID: childPid };
    await writeFile(
      f.codex,
      '#!/bin/sh\nif [ "$1" = --version ]; then printf \'codex-cli 0.164.0\\n\'; exit 0; fi\ntrap \'\' TERM\necho $$ > "$GITRELAY_PARENT_PID"\n/bin/sh -c \'trap "" TERM; echo $$ > "$GITRELAY_CHILD_PID"; while :; do /bin/sleep 1; done\' &\nwait\n',
    );
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const cliProcess = spawn(process.execPath, ["--experimental-strip-types", cli, "install", "--platform", "codex"], {
      env,
    });
    cliProcess.stdout.resume();
    cliProcess.stderr.resume();
    const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      cliProcess.once("error", reject);
      cliProcess.once("close", (code, signal) => resolve({ code, signal }));
    });
    let stopped = false;
    try {
      let group = 0,
        child = 0;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          group = Number(await readFile(parentPid, "utf8"));
          child = Number(await readFile(childPid, "utf8"));
          if (group > 0 && child > 0) break;
        } catch {
          /* Wait for the test process to start. */
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(group > 0 && child > 0, "inspection process group did not start");
      cliProcess.kill("SIGINT");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result;
      try {
        result = await Promise.race([
          finished,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("CLI did not exit after SIGINT")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(result.code, 130);
      await waitForGroupGone(group);
      stopped = true;
      await assert.rejects(readFile(f.hook), { code: "ENOENT" });
      await assert.rejects(readFile(join(data, "git-relay", "codex-hooks.lock")), { code: "ENOENT" });
      assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
      assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
    } finally {
      if (!stopped) {
        cliProcess.kill("SIGKILL");
        try {
          const pid = Number(await readFile(parentPid, "utf8"));
          if (Number.isInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
        } catch {
          /* Test process already exited. */
        }
      }
    }
  },
);

test(
  "interrupting the post-install inspection withdraws new hooks but preserves existing hooks",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    for (const existing of [false, true]) {
      const f = await fixture(t);
      const data = join(f.sourceRoot, "data");
      const first = join(f.workspace, "first-plugin-check");
      const parentPid = join(f.workspace, "post-check-pid"),
        childPid = join(f.workspace, "post-check-child-pid");
      const env = {
        ...f.env,
        XDG_DATA_HOME: data,
        GITRELAY_FIRST_CHECK: first,
        GITRELAY_PARENT_PID: parentPid,
        GITRELAY_CHILD_PID: childPid,
      };
      const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
      const args = ["--experimental-strip-types", cli, "install", "--platform", "codex"];
      const success =
        "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'codex-cli 0.164.0\\n'; else printf '%s\\n' '{\"installed\":[]}'; fi\n";
      await writeFile(f.codex, success);
      let original = "",
        inode = 0;
      if (existing) {
        await exec(process.execPath, args, { env });
        original = await readFile(f.hook, "utf8");
        inode = (await stat(f.hook)).ino;
      }
      await writeFile(
        f.codex,
        '#!/bin/sh\nif [ "$1" = --version ]; then printf \'codex-cli 0.164.0\\n\'; exit 0; fi\nif [ ! -e "$GITRELAY_FIRST_CHECK" ]; then : > "$GITRELAY_FIRST_CHECK"; printf \'%s\\n\' \'{"installed":[]}\'; exit 0; fi\ntrap \'\' TERM\necho $$ > "$GITRELAY_PARENT_PID"\n/bin/sh -c \'trap "" TERM; echo $$ > "$GITRELAY_CHILD_PID"; while :; do /bin/sleep 1; done\' &\nwait\n',
      );
      const cliProcess = spawn(process.execPath, args, { env });
      cliProcess.stdout.resume();
      cliProcess.stderr.resume();
      const finished = new Promise<number | null>((resolve, reject) => {
        cliProcess.once("error", reject);
        cliProcess.once("close", (code) => resolve(code));
      });
      let stopped = false;
      try {
        let group = 0,
          child = 0;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          try {
            group = Number(await readFile(parentPid, "utf8"));
            child = Number(await readFile(childPid, "utf8"));
            if (group > 0 && child > 0) break;
          } catch {
            /* Wait for the test process to start. */
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(group > 0 && child > 0, "post-install inspection did not start");
        await readFile(f.hook);
        cliProcess.kill("SIGINT");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let code;
        try {
          code = await Promise.race([
            finished,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("CLI did not exit after SIGINT")), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        assert.equal(code, 130);
        await waitForGroupGone(group);
        stopped = true;
        const state = JSON.parse(await readFile(join(data, "git-relay", "codex-hooks.json"), "utf8"));
        if (existing) {
          assert.equal(await readFile(f.hook, "utf8"), original);
          assert.equal((await stat(f.hook)).ino, inode);
          assert.notEqual(state.removed, true);
        } else {
          await assert.rejects(readFile(f.hook), { code: "ENOENT" });
          assert.equal(state.removed, true);
          assert.equal(await readFile(state.archive, "utf8"), state.content);
        }
        await assert.rejects(readFile(join(data, "git-relay", "codex-hooks.lock")), { code: "ENOENT" });
        assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
        assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
      } finally {
        if (!stopped) {
          cliProcess.kill("SIGKILL");
          try {
            const pid = Number(await readFile(parentPid, "utf8"));
            if (Number.isInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
          } catch {
            /* Test process already exited. */
          }
        }
      }
    }
  },
);

test(
  "Codex archives newly published hooks when a post-publication plugin check fails",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const second of ['printf \'%s\\n\' \'{"installed":[{"name":"git-relay","enabled":false}]}\'', "exit 2"]) {
      const f = await fixture(t);
      const env = { ...f.env, GITRELAY_TEST_MARKER: join(f.workspace, "plugin-check-ran") };
      await writeFile(
        f.codex,
        `#!/bin/sh\nif [ ! -e "$GITRELAY_TEST_MARKER" ]; then : > "$GITRELAY_TEST_MARKER"; printf '%s\\n' '{"installed":[]}'; else ${second}; fi\n`,
      );
      await assert.rejects(installCodex({ ...f, env }), /plugin|inspect/i);
      await assert.rejects(readFile(f.hook), { code: "ENOENT" });
      const record = JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8"));
      assert.equal(record.removed, true);
      assert.equal(await readFile(record.archive, "utf8"), record.content);
      assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
      assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
    }
  },
);

test(
  "Codex preserves already-installed hooks when a later plugin check fails",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const second of ['printf \'%s\\n\' \'{"installed":[{"name":"git-relay","enabled":true}]}\'', "exit 2"]) {
      const f = await fixture(t);
      await installCodex(f);
      const original = await readFile(f.hook, "utf8");
      const inode = (await stat(f.hook)).ino;
      const env = { ...f.env, GITRELAY_TEST_MARKER: join(f.workspace, "plugin-check-ran") };
      await writeFile(
        f.codex,
        `#!/bin/sh\nif [ ! -e "$GITRELAY_TEST_MARKER" ]; then : > "$GITRELAY_TEST_MARKER"; printf '%s\\n' '{"installed":[]}'; else ${second}; fi\n`,
      );
      await assert.rejects(installCodex({ ...f, env }), /plugin|inspect/i);
      assert.equal(await readFile(f.hook, "utf8"), original);
      assert.equal((await stat(f.hook)).ino, inode);
      assert.notEqual(JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).removed, true);
      assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
      assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
    }
  },
);

test(
  "Codex resumes first install after pending journal at each publication stage",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const stage of ["journal", "revision", "bootstrap", "entry"]) {
      const f = await fixture(t);
      await installCodex(f);
      const state = join(f.workspace, "codex-hooks.json");
      const record = JSON.parse(await readFile(state, "utf8"));
      const expected = await readFile(f.hook, "utf8");
      await writeFile(state, JSON.stringify({ ...record, current: null, pending: record.current }));
      if (stage === "journal") await rm(join(f.workspace, "codex-revisions", record.current));
      if (stage === "journal" || stage === "revision") await rm(join(f.workspace, "codex-current.mjs"));
      if (stage !== "entry") await rm(f.hook);
      await installCodex(f);
      assert.equal(await readFile(f.hook, "utf8"), expected, stage);
      assert.equal(JSON.parse(await readFile(state, "utf8")).current, record.current, stage);
      assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n", stage);
    }
  },
);

test(
  "Codex does not adopt same-content hooks created by another process during first publish",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await installCodex(f);
    const state = join(f.workspace, "codex-hooks.json");
    const record = JSON.parse(await readFile(state, "utf8"));
    const expected = await readFile(f.hook, "utf8");
    await rm(f.hook);
    await writeFile(state, JSON.stringify({ ...record, current: null, pending: record.current }));
    await writeFile(f.hook, expected, { flag: "wx" });
    const userInode = (await stat(f.hook)).ino;
    await assert.rejects(installCodex(f), /ownership|owned|preserv/i);
    await assert.rejects(uninstallCodex(f), /ownership|owned|preserv/i);
    assert.equal(await readFile(f.hook, "utf8"), expected);
    assert.equal((await stat(f.hook)).ino, userInode);
  },
);

test(
  "a different Node executable can upgrade and uninstall, then reinstall with a new hook definition",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await installCodex(f);
    const original = await readFile(f.hook, "utf8");
    const originalInode = (await stat(f.hook)).ino;
    const alternate = join(f.sourceRoot, "node alternate");
    await copyFile(process.execPath, alternate);
    await writeFile(join(f.sourceRoot, "dist", "node-upgrade-marker"), "new runtime\n");
    const module = pathToFileURL(fileURLToPath(new URL("../../src/cli/install-codex.ts", import.meta.url))).href;
    const options = JSON.stringify({ workspace: f.workspace, sourceRoot: f.sourceRoot });
    const run = (action: string) =>
      exec(
        alternate,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { installCodex, uninstallCodex } from ${JSON.stringify(module)}; await ${action}(${options});`,
        ],
        { env: f.env },
      );
    await run("installCodex");
    assert.equal(await readFile(f.hook, "utf8"), original);
    assert.equal((await stat(f.hook)).ino, originalInode);
    await run("uninstallCodex");
    await assert.rejects(readFile(f.hook), { code: "ENOENT" });
    await run("installCodex");
    assert.notEqual(await readFile(f.hook, "utf8"), original);
    assert.match(await readFile(f.hook, "utf8"), /node alternate/);
    assert.notEqual((await stat(f.hook)).ino, originalInode);
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
    assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
  },
);

test(
  "missing trusted Node executable blocks upgrade but permits uninstall and reinstall",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const oldNode = join(f.sourceRoot, "old-node");
    await copyFile(process.execPath, oldNode);
    const module = pathToFileURL(fileURLToPath(new URL("../../src/cli/install-codex.ts", import.meta.url))).href;
    const options = JSON.stringify({ workspace: f.workspace, sourceRoot: f.sourceRoot });
    await exec(
      oldNode,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { installCodex } from ${JSON.stringify(module)}; await installCodex(${options});`,
      ],
      { env: f.env },
    );
    const original = await readFile(f.hook, "utf8");
    assert.match(original, /old-node/);
    await rm(oldNode);
    await assert.rejects(installCodex(f), /node.*(missing|unavailable|executable)|reinstall/i);
    assert.equal(await readFile(f.hook, "utf8"), original);
    const archive = await uninstallCodex(f);
    assert.ok(archive);
    assert.equal(await readFile(archive, "utf8"), original);
    await installCodex(f);
    assert.notEqual(await readFile(f.hook, "utf8"), original);
    assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
  },
);

test(
  "a replaced trusted Node executable cannot publish a runtime upgrade",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const fake of ["exit 2", "if [ \"$1\" = --version ]; then printf 'v99.0.0\\n'; else exit 0; fi"]) {
      const f = await fixture(t);
      const oldNode = join(f.sourceRoot, "old-node");
      await copyFile(process.execPath, oldNode);
      const module = pathToFileURL(fileURLToPath(new URL("../../src/cli/install-codex.ts", import.meta.url))).href;
      const options = JSON.stringify({ workspace: f.workspace, sourceRoot: f.sourceRoot });
      await exec(
        oldNode,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { installCodex } from ${JSON.stringify(module)}; await installCodex(${options});`,
        ],
        { env: f.env },
      );
      const original = await readFile(f.hook, "utf8");
      const before = JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).current;
      await writeFile(oldNode, `#!/bin/sh\n${fake}\n`);
      await writeFile(join(f.sourceRoot, "dist", "update-marker"), "new runtime\n");
      await assert.rejects(installCodex(f));
      assert.equal(await readFile(f.hook, "utf8"), original);
      assert.equal(JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).current, before);
      assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
    }
  },
);

test(
  "hung trusted Node probes are killed without changing existing hooks",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    for (const stage of ["version", "runtime"]) {
      const f = await fixture(t);
      const oldNode = join(f.sourceRoot, "old-node");
      await copyFile(process.execPath, oldNode);
      const module = pathToFileURL(fileURLToPath(new URL("../../src/cli/install-codex.ts", import.meta.url))).href;
      const options = JSON.stringify({ workspace: f.workspace, sourceRoot: f.sourceRoot });
      await exec(
        oldNode,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { installCodex } from ${JSON.stringify(module)}; await installCodex(${options});`,
        ],
        { env: f.env },
      );
      const original = await readFile(f.hook, "utf8");
      const inode = (await stat(f.hook)).ino;
      const before = JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).current;
      const parentPid = join(f.workspace, "node-probe-pid"),
        childPid = join(f.workspace, "node-probe-child-pid");
      const env = { ...f.env, GITRELAY_PARENT_PID: parentPid, GITRELAY_CHILD_PID: childPid };
      const version = stage === "runtime" ? "if [ \"$1\" = --version ]; then printf 'v22.23.2\\n'; exit 0; fi\n" : "";
      await writeFile(
        oldNode,
        `#!/bin/sh\n${version}trap '' TERM\necho $$ > "$GITRELAY_PARENT_PID"\n/bin/sh -c 'trap "" TERM; echo $$ > "$GITRELAY_CHILD_PID"; while :; do /bin/sleep 1; done' &\nwait\n`,
      );
      await writeFile(join(f.sourceRoot, "dist", "probe-upgrade-marker"), "new runtime\n");
      const script = `
      const original = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 5000 ? 500 : delay, ...args);
      const { installCodex } = await import(${JSON.stringify(module)});
      try { await installCodex(${options}); process.exitCode = 1; }
      catch (error) { if (!/Node executable|runtime cannot run/.test(error.message)) throw error; }
    `;
      let stopped = false;
      try {
        await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
          env,
          timeout: 10000,
        });
        const group = Number(await readFile(parentPid, "utf8")),
          child = Number(await readFile(childPid, "utf8"));
        assert.ok(Number.isInteger(group) && group > 0 && Number.isInteger(child) && child > 0);
        await waitForGroupGone(group);
        stopped = true;
        assert.equal(await readFile(f.hook, "utf8"), original);
        assert.equal((await stat(f.hook)).ino, inode);
        assert.equal(JSON.parse(await readFile(join(f.workspace, "codex-hooks.json"), "utf8")).current, before);
        assert.equal(await readFile(f.config, "utf8"), "model = 'user-model'\n");
        assert.equal(await readFile(f.cache, "utf8"), "user cache\n");
      } finally {
        if (!stopped)
          try {
            const pid = Number(await readFile(parentPid, "utf8"));
            if (Number.isInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
          } catch {
            /* Test process already exited. */
          }
      }
    }
  },
);
