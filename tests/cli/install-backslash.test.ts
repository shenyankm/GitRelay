import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { install } from "../../src/cli/install.ts";
import { installCodex } from "../../src/cli/install-codex.ts";
import { installOpenCode } from "../../src/cli/install-opencode.ts";

for (const platform of ["codex", "opencode"] as const) {
  test(
    `${platform} rejects backslashes in a POSIX runtime path before installation`,
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
      await mkdir(join(source, "dist", "adapters", "opencode"), { recursive: true });
      await writeFile(join(source, "dist", "cli", "main.js"), "console.log('git-relay hook');\n");
      await writeFile(
        join(source, "dist", "adapters", "opencode", "index.js"),
        "export default { id: 'git-relay', setup() {} };\n",
      );
      await mkdir(bin);
      await writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n", { mode: 0o755 });
      const env = { ...process.env, CODEX_HOME: join(base, "codex"), PATH: [bin, process.env.PATH].join(delimiter) };
      await assert.rejects(
        platform === "codex"
          ? installCodex({ workspace, sourceRoot: source, env, clientVersion: "0.164.0" })
          : installOpenCode(workspace, join(base, "config"), join(source, "dist")),
        /data directory path contains a backslash.*XDG_DATA_HOME/,
      );
      assert.deepEqual(await readdir(workspace), [".git-relay-owner"]);
    },
  );
}

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
  } finally {
    process.env = before;
  }
});
