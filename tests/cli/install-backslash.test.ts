import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { install } from "../../src/cli/install.ts";
import { installCodex } from "../../src/cli/install-codex.ts";

test(
  `Codex rejects backslashes in a POSIX runtime path before installation`,
  { skip: process.platform === "win32" },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "git-relay-backslash-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const workspace = join(base, "back\\slash", "workspace");
    const source = join(base, "source");
    const bin = join(base, "bin");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
    await mkdir(join(source, "dist", "cli"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n", { mode: 0o755 });
    const env = { ...process.env, CODEX_HOME: join(base, "codex"), PATH: [bin, process.env.PATH].join(delimiter) };
    for (const dryRun of [false, true]) {
      await assert.rejects(
        installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0", dryRun }),
        /data directory path contains a backslash.*XDG_DATA_HOME/,
      );
    }
    assert.deepEqual(await readdir(workspace), [".git-relay-owner"]);
  },
);

test("dry-run reports an unsupported POSIX data directory", { skip: process.platform === "win32" }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "git-relay-backslash-preview-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '0.164.0'\n", { mode: 0o755 });
  const before = { ...process.env };
  process.env.PATH = bin;
  process.env.XDG_DATA_HOME = join(base, "back\\slash");
  try {
    const result = await install("install", ["codex"], [], true);
    assert.equal(result.failed, true);
    assert.match(JSON.stringify(result.results), /data directory path contains a backslash.*XDG_DATA_HOME/);
    await assert.rejects(readdir(process.env.XDG_DATA_HOME!), { code: "ENOENT" });
  } finally {
    process.env = before;
  }
});
