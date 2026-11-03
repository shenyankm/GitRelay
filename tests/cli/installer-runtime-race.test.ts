import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { installCodex } from "../../src/cli/install-codex.ts";

test(
  `Codex rejects a conflicting runtime published during the rename`,
  { skip: process.platform === "win32" },
  async (t) => {
    const base = await fs.promises.mkdtemp(join(tmpdir(), "git-relay-runtime-conflict-"));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
    const workspace = join(base, "workspace"),
      source = join(base, "source"),
      bin = join(base, "bin");
    await fs.promises.mkdir(workspace);
    await fs.promises.writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
    await fs.promises.mkdir(join(source, "dist", "cli"), { recursive: true });
    await fs.promises.writeFile(join(source, "dist", "cli", "main.js"), "console.log('git-relay hook');\n");
    await fs.promises.mkdir(bin);
    await fs.promises.writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n", {
      mode: 0o755,
    });
    const env = { ...process.env, CODEX_HOME: join(base, "codex"), PATH: [bin, process.env.PATH].join(delimiter) };
    const rename = fs.promises.rename;
    let published: string | undefined;
    fs.promises.rename = (async (from, to) => {
      if (typeof to === "string" && /\/runtimes\/[a-f0-9]{64}$/.test(to)) {
        published = to;
        await fs.promises.mkdir(join(to, "dist"), { recursive: true });
        await fs.promises.writeFile(join(to, "dist", "user-data"), "preserve");
        await fs.promises.writeFile(join(to, "package.json"), '{"type":"module"}\n');
      }
      return rename(from, to);
    }) as typeof rename;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0" }),
        /runtime was modified/,
      );
    } finally {
      fs.promises.rename = rename;
      syncBuiltinESMExports();
    }
    assert.ok(published);
    assert.equal(await fs.promises.readFile(join(published, "dist", "user-data"), "utf8"), "preserve");
  },
);

for (const priorRevision of [false, true]) {
  for (const { dryRun, valid } of [
    { dryRun: false, valid: true },
    { dryRun: true, valid: true },
    { dryRun: true, valid: false },
  ]) {
    test(
      `Codex ${valid ? "accepts" : "rejects"} a ${valid ? "complete" : "modified"} runtime published after a missing digest${priorRevision ? " for an existing revision" : ""}${dryRun ? " during dry run" : ""}`,
      { skip: process.platform === "win32" },
      async (t) => {
        const base = await fs.promises.mkdtemp(join(tmpdir(), "git-relay-runtime-publication-"));
        t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
        const workspace = join(base, "workspace"),
          source = join(base, "source"),
          bin = join(base, "bin");
        await fs.promises.mkdir(workspace);
        await fs.promises.writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
        await fs.promises.mkdir(join(source, "dist", "cli"), { recursive: true });
        await fs.promises.writeFile(join(source, "dist", "cli", "main.js"), "console.log('git-relay hook');\n");
        await fs.promises.mkdir(bin);
        await fs.promises.writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n", {
          mode: 0o755,
        });
        const env = {
          ...process.env,
          CODEX_HOME: join(base, "codex"),
          PATH: [bin, process.env.PATH].join(delimiter),
        };
        const install = (preview = false) =>
          installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0", dryRun: preview });
        const { installerDigest } = await import("../../src/cli/installer-digest.ts");
        const id = await installerDigest(join(source, "dist"));
        const runtime = join(workspace, "runtimes", id);
        if (priorRevision) {
          await install();
          await fs.promises.rm(runtime, { recursive: true });
        }
        const lstat = fs.promises.lstat;
        let published = false;
        fs.promises.lstat = (async (...args: Parameters<typeof lstat>) => {
          if (!published && args[0] === runtime) {
            published = true;
            await fs.promises.mkdir(runtime, { recursive: true });
            await fs.promises.cp(join(source, "dist"), join(runtime, "dist"), { recursive: true });
            await fs.promises.writeFile(join(runtime, "package.json"), valid ? '{"type":"module"}\n' : "modified");
          }
          return lstat(...args);
        }) as typeof lstat;
        syncBuiltinESMExports();
        try {
          if (valid) await install(dryRun);
          else await assert.rejects(install(dryRun), /runtime (?:is incomplete or was modified|was modified)/);
        } finally {
          fs.promises.lstat = lstat;
          syncBuiltinESMExports();
        }
        assert.equal(published, true);
        if (!valid) assert.equal(await fs.promises.readFile(join(runtime, "package.json"), "utf8"), "modified");
      },
    );
  }
}
