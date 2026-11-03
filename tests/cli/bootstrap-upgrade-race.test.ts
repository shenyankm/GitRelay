import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { installCodex } from "../../src/cli/install-codex.ts";

// These exercise generated launchers, not real hosts, and are unverified on Windows.
test(
  `Codex launcher tolerates an upgrade between its state and revision reads`,
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const base = await fs.promises.mkdtemp(join(tmpdir(), "gitrelay-bootstrap-race-"));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
    const home = join(base, "home"),
      source = join(base, "source"),
      workspace = join(base, "workspace");
    await fs.promises.mkdir(home, { recursive: true });
    let install: () => Promise<void>, target: string, marker: (version: number) => string;
    const bin = join(base, "bin");
    await fs.promises.mkdir(bin, { recursive: true });
    await fs.promises.writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n", {
      mode: 0o755,
    });
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
    target = join(source, "dist/cli/main.js");
    await fs.promises.mkdir(join(source, "dist/cli"), { recursive: true });
    const env = {
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
      TMPDIR: base,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    install = () => installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0" });
    marker = (version) =>
      `if (process.argv.includes('--help')) console.log('git-relay hook'); else globalThis.__gitrelayBootstrapVersion = ${version};\n`;

    await fs.promises.writeFile(target, marker(1));
    await install();
    const pointer = join(workspace, "codex-current.mjs");
    const currentLauncher = await fs.promises.readFile(pointer, "utf8");
    const legacyLauncher = currentLauncher
      .replace(
        "const revision = [state.pending, state.current].find((value) => revisions.includes(value));",
        "const revision = revisions.at(-1);",
      )
      .replace("if (state.removed || !revision", "if (!revision");
    assert.notEqual(legacyLauncher, currentLauncher);
    await fs.promises.writeFile(pointer, legacyLauncher);
    await install();
    assert.equal(await fs.promises.readFile(pointer, "utf8"), currentLauncher);
    const archive = (await fs.promises.readdir(workspace)).find((name) => name.startsWith(".git-relay-launcher-"));
    assert.ok(archive);
    assert.equal(await fs.promises.readFile(join(workspace, archive, "previous.mjs"), "utf8"), legacyLauncher);
    const stateName = "codex-hooks.json";
    const state = join(workspace, stateName);
    const first = JSON.parse(await fs.promises.readFile(state, "utf8")).current;
    await fs.promises.writeFile(target, marker(2));
    const read = fs.promises.readFile;
    let upgraded = false;
    fs.promises.readFile = (async (path: Parameters<typeof read>[0], options: Parameters<typeof read>[1]) => {
      const value = await read(path, options);
      if (!upgraded && path instanceof URL && path.pathname.endsWith(`/${stateName}`)) {
        upgraded = true;
        await install();
      }
      return value;
    }) as typeof read;
    syncBuiltinESMExports();
    let failure: unknown;
    const bootstrap = pathToFileURL(join(workspace, "codex-current.mjs")).href;
    try {
      await import(bootstrap);
    } catch (error) {
      failure = error;
    } finally {
      fs.promises.readFile = read;
      syncBuiltinESMExports();
    }

    const runtime = globalThis as typeof globalThis & { __gitrelayBootstrapVersion?: number };
    const duringUpgrade = runtime.__gitrelayBootstrapVersion;
    assert.ok(upgraded, "installer upgrade must follow the launcher's state read");
    assert.notEqual(JSON.parse(await read(state, "utf8")).current, first);
    await import(`${bootstrap}?after-upgrade`);
    assert.equal(runtime.__gitrelayBootstrapVersion, 2);
    if (failure) throw failure;
    assert.ok(duringUpgrade === 1 || duringUpgrade === 2);
  },
);
