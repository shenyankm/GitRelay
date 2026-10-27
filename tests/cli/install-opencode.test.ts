import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { installOpenCode, uninstallOpenCode } from "../../src/cli/install-opencode.ts";
import { installerDigest } from "../../src/cli/installer-digest.ts";

test("OpenCode upgrades legacy digests and rejects a modified runtime", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-opencode-legacy-digest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "root"),
    config = join(dir, "config"),
    source = join(dir, "dist");
  await mkdir(join(source, "adapters", "opencode"), { recursive: true });
  await writeFile(
    join(source, "adapters", "opencode", "index.js"),
    "export default { id: 'git-relay', setup() {} };\n",
  );
  await writeFile(join(source, "changes.js"), "changes");
  await writeFile(join(source, "cleanup.js"), "cleanup");
  await installOpenCode(root, config, source);
  const state = join(root, "opencode.json"),
    record = JSON.parse(await readFile(state, "utf8"));
  const legacy = `${record.current.slice(0, 21)}${await installerDigest(source, undefined, "cs")}`;
  assert.notEqual(legacy, record.current);
  await rename(join(root, "runtimes", record.current.slice(21)), join(root, "runtimes", legacy.slice(21)));
  await rename(join(root, "opencode-revisions", record.current), join(root, "opencode-revisions", legacy));
  await writeFile(state, JSON.stringify({ ...record, current: legacy }));
  await writeFile(join(source, "upgrade"), "new source");
  await writeFile(join(root, "runtimes", legacy.slice(21), "dist", "tampered"), "x");
  await assert.rejects(installOpenCode(root, config, source), /runtime was modified/);
  await rm(join(root, "runtimes", legacy.slice(21), "dist", "tampered"));
  await installOpenCode(root, config, source);
  assert.notEqual(JSON.parse(await readFile(state, "utf8")).current, legacy);
});

test("OpenCode recovers a lost anchor after the user preserves and removes the entry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-anchor-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "workspace"),
    config = join(dir, "config"),
    source = join(dir, "dist");
  await mkdir(join(source, "adapters", "opencode"), { recursive: true });
  await writeFile(
    join(source, "adapters", "opencode", "index.js"),
    "export default { id: 'git-relay', setup() {} };\n",
  );
  await installOpenCode(root, config, source);
  const record = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  const original = await readFile(record.entry, "utf8");
  await rm(join(config, "opencode", "plugins", record.anchor));
  await assert.rejects(uninstallOpenCode(root, config), /ownership cannot be established/);
  await assert.rejects(installOpenCode(root, config, source), /ownership cannot be established/);
  assert.equal(await readFile(record.entry, "utf8"), original);
  const backup = join(dir, "saved-entry.js");
  await rename(record.entry, backup);
  const archive = join(config, "opencode", "plugins", ".git-relay-removed-abc", "entry");
  await mkdir(join(config, "opencode", "plugins", ".git-relay-removed-abc"));
  await writeFile(archive, "preserve pending archive");
  await writeFile(join(root, "opencode.json"), JSON.stringify({ ...record, removing: archive }));
  await assert.rejects(uninstallOpenCode(root, config), /ownership cannot be established/);
  assert.equal(await readFile(archive, "utf8"), "preserve pending archive");
  await writeFile(join(root, "opencode.json"), JSON.stringify(record));
  await uninstallOpenCode(root, config);
  await installOpenCode(root, config, source);
  assert.equal(await readFile(backup, "utf8"), original);
  assert.equal(await readFile(record.entry, "utf8"), original);
});

test("OpenCode preserves an existing incomplete runtime directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-opencode-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "dist"),
    first = join(dir, "first"),
    second = join(dir, "second");
  await mkdir(join(source, "adapters", "opencode"), { recursive: true });
  await writeFile(
    join(source, "adapters", "opencode", "index.js"),
    "export default { id: 'git-relay', setup() {} };\n",
  );
  await installOpenCode(first, join(dir, "config-first"), source);
  const id = JSON.parse(await readFile(join(first, "opencode.json"), "utf8")).current.slice(21);
  await mkdir(second);
  await writeFile(join(second, ".git-relay-owner"), "git-relay installer v1\n");
  const runtime = join(second, "runtimes", id);
  await mkdir(runtime, { recursive: true });
  const inode = await lstat(runtime);
  await assert.rejects(
    installOpenCode(second, join(dir, "config-second"), source),
    /runtime is incomplete or was modified; preserved/,
  );
  assert.equal((await lstat(runtime)).ino, inode.ino);
  assert.deepEqual(await readdir(runtime), []);
  await writeFile(join(runtime, "user-data"), "preserve");
  await assert.rejects(
    installOpenCode(second, join(dir, "config-second"), source),
    /runtime is incomplete or was modified; preserved/,
  );
  assert.equal((await lstat(runtime)).ino, inode.ino);
  assert.equal(await readFile(join(runtime, "user-data"), "utf8"), "preserve");
});

test("OpenCode install is repeatable, recovers its journal, and preserves unrelated or modified files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git relay install "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "data", "git-relay");
  const config = join(dir, "config");
  const source = join(dir, "dist");
  const entry = join(config, "opencode", "plugins", "git-relay.js");
  const state = join(root, "opencode.json");
  await mkdir(join(source, "adapters", "opencode"), { recursive: true });
  const module = join(source, "adapters", "opencode", "index.js");
  await writeFile(module, "export default { id: 'git-relay', setup() {}, version: 1 };\n");
  await writeFile(join(source, "a"), "Xb\0Y");
  await mkdir(join(config, "opencode", "plugins"), { recursive: true });
  const other = join(config, "opencode", "plugins", "other.js");
  await writeFile(other, "user plugin\n");
  await writeFile(entry, "user content\n");
  await assert.rejects(installOpenCode(root, config, source), /not owned/);
  assert.equal(await readFile(entry, "utf8"), "user content\n");
  await rm(entry);
  await installOpenCode(root, config, source);
  const original = await readFile(entry, "utf8");
  const savedState = await readFile(state, "utf8");
  const backup = join(root, "opencode.saved.json");
  await rename(state, backup);
  for (const target of ["missing-record", "opencode.saved.json"]) {
    await symlink(target, state);
    await assert.rejects(installOpenCode(root, config, source), /Invalid OpenCode installation record/);
    await assert.rejects(uninstallOpenCode(root, config), /Invalid OpenCode installation record/);
    assert.equal(await readlink(state), target);
    assert.equal(await readFile(backup, "utf8"), savedState);
    assert.equal(await readFile(entry, "utf8"), original);
    await rm(state);
  }
  await rename(backup, state);
  const pointer = join(root, "opencode-current.mjs");
  const originalPointer = await readFile(pointer, "utf8");
  const originalRevision = JSON.parse(await readFile(state, "utf8")).current;
  assert.equal((await import(`${pathToFileURL(pointer).href}?first`)).default.version, 1);
  assert.match(original, /export \{ default \} from "file:/);
  await installOpenCode(root, config, source);
  assert.equal(await readFile(entry, "utf8"), original);
  await writeFile(join(source, "a"), "X");
  await writeFile(join(source, "b"), "Y");
  await installOpenCode(root, config, source);
  const updated = await readFile(entry, "utf8");
  assert.equal(updated, original);
  const updatedPointer = await readFile(pointer, "utf8");
  assert.equal(updatedPointer, originalPointer);
  const updatedRevision = JSON.parse(await readFile(state, "utf8")).current;
  assert.notEqual(updatedRevision, originalRevision);
  const anchor = JSON.parse(await readFile(state, "utf8")).anchor;
  await writeFile(
    state,
    JSON.stringify({ entry, content: original, anchor, current: originalRevision, pending: updatedRevision }),
  );
  await installOpenCode(root, config, source);
  assert.equal(JSON.parse(await readFile(state, "utf8")).current, updatedRevision);
  await writeFile(module, "export default { id: 'git-relay', setup() {}, version: 2 };\n");
  await installOpenCode(root, config, source);
  assert.equal((await import(`${pathToFileURL(pointer).href}?updated`)).default.version, 2);
  const latestRevision = JSON.parse(await readFile(state, "utf8")).current;
  await rm(join(root, "opencode-revisions", latestRevision));
  await assert.rejects(import(`${pathToFileURL(pointer).href}?missing-revision`), /Invalid GitRelay OpenCode revision/);
  await writeFile(join(root, "opencode-revisions", latestRevision), "", { flag: "wx" });
  const beforeBroken = JSON.parse(await readFile(state, "utf8")).current;
  await rm(module);
  await assert.rejects(installOpenCode(root, config, source));
  assert.equal(JSON.parse(await readFile(state, "utf8")).current, beforeBroken);
  await writeFile(module, "import './missing.js'; export default { id: 'git-relay', setup() {} };\n");
  await assert.rejects(installOpenCode(root, config, source));
  assert.equal(JSON.parse(await readFile(state, "utf8")).current, beforeBroken);
  await writeFile(module, "export default { id: 'git-relay', setup() {}, version: 2 };\n");
  await writeFile(entry, "edited by user\n");
  await assert.rejects(uninstallOpenCode(root, config), /modified; preserved/);
  await assert.rejects(installOpenCode(root, config, source), /modified; preserved/);
  assert.equal(await readFile(entry, "utf8"), "edited by user\n");
  await rm(entry);
  await writeFile(join(config, "opencode", "plugins", anchor), original);
  await symlink(other, entry);
  await assert.rejects(uninstallOpenCode(root, config), /Not a small regular file/);
  await rm(entry);
  await uninstallOpenCode(root, config);
  assert.equal(await readFile(other, "utf8"), "user plugin\n");
  assert.equal((await readFile(join(root, ".git-relay-owner"), "utf8")).trim(), "git-relay installer v1");
  await installOpenCode(root, config, source);
  const lock = join(root, "install.lock");
  await writeFile(lock, "", { flag: "wx" });
  await assert.rejects(uninstallOpenCode(root, config), /lock remains busy/);
  assert.equal(await readFile(lock, "utf8"), "");
  await rm(lock);
  const record = JSON.parse(await readFile(state, "utf8"));
  const archiveDirectory = await mkdtemp(join(config, "opencode", "plugins", ".git-relay-removed-"));
  const recoveryArchive = join(archiveDirectory, "entry");
  await writeFile(state, JSON.stringify({ ...record, removing: recoveryArchive }));
  await rename(entry, recoveryArchive);
  const archive = await uninstallOpenCode(root, config);
  assert.equal(archive, recoveryArchive);
  await assert.rejects(readFile(entry), { code: "ENOENT" });
  assert.equal(await readFile(archive!, "utf8"), original);
  await installOpenCode(root, config, source);
  await writeFile(archive!, "old archive edit\n");
  assert.equal(await readFile(entry, "utf8"), original);
  await uninstallOpenCode(root, config);
  await writeFile(entry, original);
  await assert.rejects(installOpenCode(root, config, source), /recreated after uninstall/);
  assert.equal(await readFile(entry, "utf8"), original);
});

test("first install retries when journal was written before revision publication", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-initial-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "git-relay");
  const config = join(dir, "config");
  const source = join(dir, "dist");
  await mkdir(join(source, "adapters", "opencode"), { recursive: true });
  await writeFile(
    join(source, "adapters", "opencode", "index.js"),
    "export default { id: 'git-relay', setup() {} };\n",
  );
  await installOpenCode(root, config, source);
  const state = join(root, "opencode.json");
  const record = JSON.parse(await readFile(state, "utf8"));
  await rm(join(root, "opencode-revisions", record.current));
  await writeFile(state, JSON.stringify({ ...record, current: null, pending: record.current }));
  await installOpenCode(root, config, source);
  assert.equal(JSON.parse(await readFile(state, "utf8")).current, record.current);
  await rm(record.entry);
  await writeFile(state, JSON.stringify({ ...record, current: null, pending: record.current }));
  await writeFile(record.entry, record.content, { flag: "wx" });
  await assert.rejects(installOpenCode(root, config, source), /ownership cannot be established/);
  await assert.rejects(uninstallOpenCode(root, config), /ownership cannot be established/);
  assert.equal(await readFile(record.entry, "utf8"), record.content);
});

test("workspace publication refuses an existing unowned empty directory and ignores abandoned staging", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "git-relay");
  const config = join(dir, "config");
  const source = join(dir, "dist");
  await mkdir(join(source, "adapters", "opencode"), { recursive: true });
  await writeFile(
    join(source, "adapters", "opencode", "index.js"),
    "export default { id: 'git-relay', setup() {} };\n",
  );
  await mkdir(root);
  await assert.rejects(installOpenCode(root, config, source), /not an owned|Not an owned/);
  await rm(root, { recursive: true });
  const abandoned = join(dir, ".git-relay-abandoned");
  await mkdir(abandoned);
  await writeFile(join(abandoned, ".git-relay-owner"), "git-relay installer v1\n");
  await installOpenCode(root, config, source);
  assert.equal(await readFile(join(abandoned, ".git-relay-owner"), "utf8"), "git-relay installer v1\n");
  await uninstallOpenCode(root, config);
});

test(
  "OpenCode anchor and archive follow an existing plugin-directory symlink",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-plugin-link-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "git-relay");
    const config = join(dir, "config");
    const source = join(dir, "dist");
    const target = join(dir, "external-plugins");
    await mkdir(join(source, "adapters", "opencode"), { recursive: true });
    await writeFile(
      join(source, "adapters", "opencode", "index.js"),
      "export default { id: 'git-relay', setup() {} };\n",
    );
    await mkdir(join(config, "opencode"), { recursive: true });
    await mkdir(target);
    await symlink(target, join(config, "opencode", "plugins"), "dir");
    await installOpenCode(root, config, source);
    const record = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
    await readFile(join(target, record.anchor));
    const archive = await uninstallOpenCode(root, config);
    assert.equal(await readFile(archive!, "utf8"), record.content);
  },
);

test(
  "CLI configures selected OpenCode and supports alias-safe uninstall preview",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-cli-install-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "bin");
    await mkdir(bin);
    for (const [name, version] of [
      ["codex", "codex-cli 0.164.0"],
      ["opencode", "opencode v2.1.2"],
    ]) {
      const path = join(bin, name);
      await writeFile(path, `#!/bin/sh\nprintf '${version}\\n'\n`);
      await chmod(path, 0o755);
    }
    const brokenCodex = join(bin, "codex");
    await writeFile(brokenCodex, "#!/bin/sh\nexit 3\n");
    await chmod(brokenCodex, 0o755);
    const env = { ...process.env, PATH: bin, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config") };
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const run = promisify(execFile);
    const unowned = join(env.XDG_DATA_HOME, "git-relay");
    await mkdir(unowned, { recursive: true });
    for (const extra of [[], ["--dry-run"]]) {
      const error = await run(
        process.execPath,
        ["--experimental-strip-types", cli, "install", "--platform", "opencode", ...extra],
        { env },
      ).then(
        () => null,
        (failure) => failure,
      );
      assert.match(
        JSON.parse(error.stdout).results.find((item: { platform: string }) => item.platform === "opencode").reason,
        /Not an owned GitRelay workspace/,
      );
    }
    await rm(unowned, { recursive: true });
    const result = JSON.parse(
      (await run(process.execPath, ["--experimental-strip-types", cli, "install", "--platform", "opencode"], { env }))
        .stdout,
    );
    assert.equal(result.failed, false);
    assert.equal(
      result.results.find((item: { platform: string }) => item.platform === "opencode").status,
      "configured",
    );
    const entry = join(env.XDG_CONFIG_HOME, "opencode", "plugins", "git-relay.js");
    assert.match(await readFile(entry, "utf8"), /file:/);
    const failed = await run(
      process.execPath,
      ["--experimental-strip-types", cli, "install", "--platform", "codex", "--platform", "opencode"],
      { env },
    ).then(
      () => null,
      (error) => error,
    );
    const partial = JSON.parse(failed.stdout);
    assert.equal(partial.failed, true);
    assert.equal(partial.results.find((item: { platform: string }) => item.platform === "codex").status, "unavailable");
    assert.equal(
      partial.results.find((item: { platform: string }) => item.platform === "opencode").status,
      "configured",
    );
    const openCodeState = join(result.workspace, "opencode.json");
    const savedOpenCode = await readFile(openCodeState, "utf8");
    await writeFile(openCodeState, JSON.stringify({ ...JSON.parse(savedOpenCode), removed: "false" }));
    for (const args of [
      ["install", "--platform", "opencode"],
      ["install", "--platform", "opencode", "--dry-run"],
      ["uninstall", "--platform", "opencode"],
      ["uninstall", "--platform", "opencode", "--dry-run"],
    ]) {
      const error = await run(process.execPath, ["--experimental-strip-types", cli, ...args], { env }).then(
        () => null,
        (failure) => failure,
      );
      const output = JSON.parse(error.stdout);
      assert.equal(output.failed, true);
      assert.match(
        output.results.find((item: { platform: string }) => item.platform === "opencode").reason,
        /Invalid OpenCode installation record/,
      );
      await readFile(entry);
    }
    await writeFile(
      openCodeState,
      JSON.stringify({
        ...JSON.parse(savedOpenCode),
        removing: join(JSON.parse(savedOpenCode).entry, "..", ".git-relay-removed-abc", "entry"),
      }),
    );
    for (const extra of [[], ["--dry-run"]]) {
      const error = await run(
        process.execPath,
        ["--experimental-strip-types", cli, "install", "--platform", "opencode", ...extra],
        { env },
      ).then(
        () => null,
        (failure) => failure,
      );
      assert.match(
        JSON.parse(error.stdout).results.find((item: { platform: string }) => item.platform === "opencode").reason,
        /uninstall is incomplete/,
      );
    }
    await writeFile(openCodeState, savedOpenCode);
    const savedRecordPath = join(result.workspace, "opencode.saved.json");
    await rename(openCodeState, savedRecordPath);
    await symlink("opencode.saved.json", openCodeState);
    for (const args of [
      ["install", "--platform", "opencode"],
      ["install", "--platform", "opencode", "--dry-run"],
      ["uninstall", "--platform", "opencode"],
      ["uninstall", "--platform", "opencode", "--dry-run"],
    ]) {
      const error = await run(process.execPath, ["--experimental-strip-types", cli, ...args], { env }).then(
        () => null,
        (failure) => failure,
      );
      const output = JSON.parse(error.stdout);
      assert.equal(output.failed, true);
      assert.match(
        output.results.find((item: { platform: string }) => item.platform === "opencode").reason,
        /Invalid OpenCode installation record/,
      );
      assert.equal(await readlink(openCodeState), "opencode.saved.json");
      assert.equal(await readFile(savedRecordPath, "utf8"), savedOpenCode);
      assert.match(await readFile(entry, "utf8"), /file:/);
    }
    await rm(openCodeState);
    await rename(savedRecordPath, openCodeState);

    const codexState = join(result.workspace, "codex-install.json");
    await writeFile(codexState, JSON.stringify({ pluginOwned: true }));
    const blocked = await run(
      process.execPath,
      ["--experimental-strip-types", cli, "uninstall", "--platform", "codex"],
      { env },
    ).then(
      () => null,
      (error) => error,
    );
    const blockedResult = JSON.parse(blocked.stdout);
    assert.equal(blockedResult.failed, true);
    assert.match(
      blockedResult.results.find((item: { platform: string }) => item.platform === "codex").reason,
      /uninstall is unavailable/,
    );
    assert.deepEqual(JSON.parse(await readFile(codexState, "utf8")), { pluginOwned: true });
    const alias = join(dir, "config-alias");
    await symlink(env.XDG_CONFIG_HOME, alias, "dir");
    const aliasEnv = { ...env, XDG_CONFIG_HOME: alias };
    await run(process.execPath, ["--experimental-strip-types", cli, "install", "--platform", "opencode"], {
      env: aliasEnv,
    });
    const preview = JSON.parse(
      (
        await run(
          process.execPath,
          ["--experimental-strip-types", cli, "uninstall", "--platform", "opencode", "--dry-run"],
          { env: aliasEnv },
        )
      ).stdout,
    );
    assert.equal(
      preview.results.find((item: { platform: string }) => item.platform === "opencode").status,
      "would-check-and-remove",
    );
    const originalEntry = await readFile(entry, "utf8");
    await writeFile(entry, "user edit\n");
    const changedPreview = JSON.parse(
      (
        await run(
          process.execPath,
          ["--experimental-strip-types", cli, "uninstall", "--platform", "opencode", "--dry-run"],
          { env: aliasEnv },
        )
      ).stdout,
    );
    assert.equal(
      changedPreview.results.find((item: { platform: string }) => item.platform === "opencode").status,
      "would-check-and-remove",
    );
    const refused = await run(
      process.execPath,
      ["--experimental-strip-types", cli, "uninstall", "--platform", "opencode"],
      { env: aliasEnv },
    ).then(
      () => null,
      (error) => error,
    );
    assert.equal(JSON.parse(refused.stdout).failed, true);
    assert.equal(await readFile(entry, "utf8"), "user edit\n");
    await writeFile(entry, originalEntry);
    await readFile(entry);
    await run(process.execPath, ["--experimental-strip-types", cli, "uninstall", "--platform", "opencode"], {
      env: aliasEnv,
    });
    await assert.rejects(readFile(entry), { code: "ENOENT" });
  },
);

test(
  "CLI connects Codex hooks, reports trust, and preserves existing or damaged configuration",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-cli-codex-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "bin"),
      home = join(dir, "codex");
    await mkdir(bin);
    await mkdir(home);
    const fakeCodex = join(bin, "codex");
    await writeFile(
      fakeCodex,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'codex-cli 0.164.0\\n'; else printf '%s\\n' '{"installed":[]}'; fi\n`,
    );
    await chmod(fakeCodex, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_HOME: home,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CONFIG_HOME: join(dir, "config"),
    };
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const run = promisify(execFile),
      hooks = join(home, "hooks.json");
    await writeFile(hooks, '{"hooks":{"user":"keep"}}\n');
    const conflict = await run(
      process.execPath,
      ["--experimental-strip-types", cli, "install", "--platform", "codex"],
      { env },
    ).then(
      () => null,
      (failure) => failure,
    );
    assert.equal(JSON.parse(conflict.stdout).failed, true);
    assert.equal(await readFile(hooks, "utf8"), '{"hooks":{"user":"keep"}}\n');
    await rm(hooks);
    const result = JSON.parse(
      (await run(process.execPath, ["--experimental-strip-types", cli, "install", "--platform", "codex"], { env }))
        .stdout,
    );
    const codex = result.results.find((item: { platform: string }) => item.platform === "codex");
    assert.equal(codex.status, "pending-trust");
    assert.match(codex.action, /\/hooks/);
    const state = join(result.workspace, "codex-hooks.json"),
      saved = await readFile(state, "utf8");
    await writeFile(state, JSON.stringify({ ...JSON.parse(saved), removed: "false" }));
    for (const args of [
      ["install", "--platform", "codex"],
      ["install", "--platform", "codex", "--dry-run"],
      ["uninstall", "--platform", "codex"],
      ["uninstall", "--platform", "codex", "--dry-run"],
    ]) {
      const error = await run(process.execPath, ["--experimental-strip-types", cli, ...args], { env }).then(
        () => null,
        (failure) => failure,
      );
      const output = JSON.parse(error.stdout);
      assert.equal(output.failed, true);
      assert.match(
        output.results.find((item: { platform: string }) => item.platform === "codex").reason,
        /Invalid Codex installation record/,
      );
      await readFile(hooks);
    }
    await writeFile(state, saved);
    const legacy = join(result.workspace, "codex-install.json");
    await writeFile(legacy, "{}");
    for (const extra of [[], ["--dry-run"]]) {
      const error = await run(
        process.execPath,
        ["--experimental-strip-types", cli, "install", "--platform", "codex", ...extra],
        { env },
      ).then(
        () => null,
        (failure) => failure,
      );
      assert.match(
        JSON.parse(error.stdout).results.find((item: { platform: string }) => item.platform === "codex").reason,
        /previous Codex plugin installation record/,
      );
    }
    await rm(legacy);
    const target = join(result.workspace, "codex.saved.json"),
      savedHooks = await readFile(hooks, "utf8");
    await rename(state, target);
    await symlink("codex.saved.json", state);
    for (const args of [
      ["install", "--platform", "codex"],
      ["install", "--platform", "codex", "--dry-run"],
      ["uninstall", "--platform", "codex"],
      ["uninstall", "--platform", "codex", "--dry-run"],
    ]) {
      const error = await run(process.execPath, ["--experimental-strip-types", cli, ...args], { env }).then(
        () => null,
        (failure) => failure,
      );
      const output = JSON.parse(error.stdout);
      assert.equal(output.failed, true);
      assert.match(
        output.results.find((item: { platform: string }) => item.platform === "codex").reason,
        /Invalid Codex installation record/,
      );
      assert.equal(await readlink(state), "codex.saved.json");
      assert.equal(await readFile(target, "utf8"), saved);
      assert.equal(await readFile(hooks, "utf8"), savedHooks);
    }
    await rm(state);
    await rename(target, state);
    const removed = JSON.parse(
      (await run(process.execPath, ["--experimental-strip-types", cli, "uninstall", "--platform", "codex"], { env }))
        .stdout,
    );
    assert.equal(removed.results.find((item: { platform: string }) => item.platform === "codex").status, "removed");
    await assert.rejects(readFile(hooks), { code: "ENOENT" });
  },
);

test(
  "slow Codex inspection runs after other installations while results keep their order",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-slow-codex-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "bin"),
      started = join(dir, "started"),
      release = join(dir, "release");
    await mkdir(bin);
    await writeFile(join(bin, "opencode"), "#!/bin/sh\nprintf 'opencode v2.1.2\\n'\n", { mode: 0o755 });
    await writeFile(
      join(bin, "codex"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'codex-cli 0.164.0\\n\'; else printf started > "$TASK_STARTED"; while [ ! -e "$TASK_RELEASE" ]; do /bin/sleep 0.05; done; printf \'%s\\n\' \'{"installed":[]}\'; fi\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_HOME: join(dir, "codex"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CONFIG_HOME: join(dir, "config"),
      TASK_STARTED: started,
      TASK_RELEASE: release,
    };
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", cli, "install", "--platform", "codex", "--platform", "opencode"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      let seen = false;
      for (let attempt = 0; attempt < 400 && !seen; attempt++) {
        seen = await access(started).then(
          () => true,
          () => false,
        );
        if (!seen) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(seen, true, "Codex inspection did not start");
      await access(join(env.XDG_CONFIG_HOME, "opencode", "plugins", "git-relay.js"));
    } finally {
      await writeFile(release, "release");
    }
    assert.equal(await finished, 0, stderr);
    const result = JSON.parse(stdout);
    assert.deepEqual(
      result.results.map((item: { platform: string }) => item.platform),
      ["codex", "opencode"],
    );
    assert.equal(result.results[0].status, "pending-trust");
    assert.equal(result.results[1].status, "configured");
  },
);

test(
  "interrupting a Codex installation stops without reporting a successful result",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-interrupt-codex-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "bin"),
      started = join(dir, "started");
    await mkdir(bin);
    await writeFile(
      join(bin, "codex"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'codex-cli 0.164.0\\n\'; else printf started > "$TASK_STARTED"; exec /bin/sleep 3; fi\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_HOME: join(dir, "codex"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CONFIG_HOME: join(dir, "config"),
      TASK_STARTED: started,
    };
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "install", "--platform", "codex"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let seen = false;
    for (let attempt = 0; attempt < 200 && !seen; attempt++) {
      seen = await access(started).then(
        () => true,
        () => false,
      );
      if (!seen) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(seen, true, "Codex inspection did not start");
    child.kill("SIGINT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([
        finished,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cancellation did not finish promptly")), 2000);
        }),
      ]);
      assert.equal(exit, 130);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
    assert.equal(stdout, "");
    await assert.rejects(access(join(env.CODEX_HOME, "hooks.json")), { code: "ENOENT" });
  },
);
