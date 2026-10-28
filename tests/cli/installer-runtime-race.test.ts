import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { installCodex } from "../../src/cli/install-codex.ts";
import { installOpenCode } from "../../src/cli/install-opencode.ts";

test(
  "Codex and OpenCode publish one shared runtime concurrently",
  { skip: process.platform === "win32" },
  async (t) => {
    const base = await fs.promises.mkdtemp(join(tmpdir(), "git-relay-runtime-race-"));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
    const workspace = join(base, "workspace"),
      source = join(base, "source"),
      bin = join(base, "bin");
    await fs.promises.mkdir(workspace);
    await fs.promises.writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
    await fs.promises.mkdir(join(source, "dist", "cli"), { recursive: true });
    await fs.promises.mkdir(join(source, "dist", "adapters", "opencode"), { recursive: true });
    await fs.promises.writeFile(join(source, "dist", "cli", "main.js"), "console.log('git-relay hook');\n");
    await fs.promises.writeFile(
      join(source, "dist", "adapters", "opencode", "index.js"),
      "export default { id: 'git-relay', setup() {} };\n",
    );
    await fs.promises.mkdir(bin);
    await fs.promises.writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n", {
      mode: 0o755,
    });
    const env = { ...process.env, CODEX_HOME: join(base, "codex"), PATH: [bin, process.env.PATH].join(delimiter) };
    const cp = fs.promises.cp;
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    fs.promises.cp = (async (...args: Parameters<typeof cp>) => {
      if (++arrivals === 2) release();
      await barrier;
      return cp(...args);
    }) as typeof cp;
    syncBuiltinESMExports();
    try {
      await Promise.all([
        installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0" }),
        installOpenCode(workspace, join(base, "config"), join(source, "dist")),
      ]);
    } finally {
      fs.promises.cp = cp;
      syncBuiltinESMExports();
    }
    const runtimes = await fs.promises.readdir(join(workspace, "runtimes"));
    assert.equal(runtimes.length, 1);
    const codex = JSON.parse(await fs.promises.readFile(join(workspace, "codex-hooks.json"), "utf8"));
    const opencode = JSON.parse(await fs.promises.readFile(join(workspace, "opencode.json"), "utf8"));
    assert.equal(codex.current.slice(21), opencode.current.slice(21));
    assert.equal(runtimes[0], codex.current.slice(21));
  },
);

for (const platform of ["codex", "opencode"] as const) {
  test(
    `${platform} rejects a conflicting runtime published during the rename`,
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
      await fs.promises.mkdir(join(source, "dist", "adapters", "opencode"), { recursive: true });
      await fs.promises.writeFile(join(source, "dist", "cli", "main.js"), "console.log('git-relay hook');\n");
      await fs.promises.writeFile(
        join(source, "dist", "adapters", "opencode", "index.js"),
        "export default { id: 'git-relay', setup() {} };\n",
      );
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
          platform === "codex"
            ? installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0" })
            : installOpenCode(workspace, join(base, "config"), join(source, "dist")),
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
}

for (const platform of ["codex", "opencode"] as const) {
  for (const priorRevision of [false, true]) {
    test(
      `${platform} accepts a complete runtime published after a missing digest${priorRevision ? " for an existing revision" : ""}`,
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
        await fs.promises.mkdir(join(source, "dist", "adapters", "opencode"), { recursive: true });
        await fs.promises.writeFile(join(source, "dist", "cli", "main.js"), "console.log('git-relay hook');\n");
        await fs.promises.writeFile(
          join(source, "dist", "adapters", "opencode", "index.js"),
          "export default { id: 'git-relay', setup() {} };\n",
        );
        await fs.promises.mkdir(bin);
        await fs.promises.writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n", {
          mode: 0o755,
        });
        const env = { ...process.env, CODEX_HOME: join(base, "codex"), PATH: [bin, process.env.PATH].join(delimiter) };
        const install = () =>
          platform === "codex"
            ? installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0" })
            : installOpenCode(workspace, join(base, "config"), join(source, "dist"));
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
            await fs.promises.writeFile(join(runtime, "package.json"), '{"type":"module"}\n');
          }
          return lstat(...args);
        }) as typeof lstat;
        syncBuiltinESMExports();
        try {
          await install();
        } finally {
          fs.promises.lstat = lstat;
          syncBuiltinESMExports();
        }
        assert.equal(published, true);
      },
    );
  }
}
