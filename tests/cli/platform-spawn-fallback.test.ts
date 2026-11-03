import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { detectPlatform } from "../../src/cli/platform-detection.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "git-relay-spawn-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"),
    second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const secondPath = join(second, "codex"),
    marker = join(root, "called");
  await writeFile(secondPath, "#!/bin/sh\nprintf called > \"$MARKER\"\nprintf '%s\\n' '0.164.0'\n");
  await chmod(secondPath, 0o755);
  const env = { PATH: [first, second].join(delimiter), HOME: root, TMPDIR: root, MARKER: marker };
  return { root, first, second, marker, env };
}

async function entry(dir: string, content: string) {
  const path = join(dir, "codex");
  await writeFile(path, content);
  await chmod(path, 0o755);
}

test(
  "version detection retries another PATH entry only when spawn fails",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const reason of ["ENOENT", "EACCES"] as const) {
      const f = await fixture(t),
        interpreter = join(f.root, "interpreter");
      if (reason === "EACCES") {
        await writeFile(interpreter, "#!/bin/sh\n");
        await chmod(interpreter, 0o644);
      }
      await entry(f.first, `#!${interpreter}\n`);
      const normal = spawnSync("codex", ["--version"], { env: f.env, encoding: "utf8" });
      assert.equal(normal.status, 0);
      assert.equal(normal.stdout, "0.164.0\n");
      const result = await detectPlatform("codex", f.env);
      assert.equal(result.status, "installed");
      const noFallback = await detectPlatform("codex", { ...f.env, PATH: f.first });
      assert.equal(noFallback.status, "unavailable");
      if (noFallback.status === "unavailable") assert.match(noFallback.reason, new RegExp(reason));
    }
  },
);

test(
  "an executed version command failing or timing out does not try another entry",
  { skip: process.platform === "win32", timeout: 15_000 },
  async (t) => {
    for (const script of ["#!/bin/sh\nexit 77\n", "#!/bin/sh\n/bin/sleep 30\n"]) {
      const f = await fixture(t);
      await entry(f.first, script);
      const result = await detectPlatform("codex", f.env);
      assert.equal(result.status, "unavailable");
      await assert.rejects(readFile(f.marker), { code: "ENOENT" });
    }
  },
);

test(
  "cancellation of a started version command does not try another entry",
  { skip: process.platform === "win32", timeout: 15_000 },
  async (t) => {
    const f = await fixture(t),
      started = join(f.root, "started");
    await entry(f.first, '#!/bin/sh\nprintf started > "$STARTED"\n/bin/sleep 30\n');
    const controller = new AbortController();
    const result = detectPlatform("codex", { ...f.env, STARTED: started }, controller.signal);
    try {
      let ready = false;
      for (let i = 0; i < 200 && !ready; i++) {
        ready = await readFile(started).then(
          () => true,
          () => false,
        );
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(ready, "first command did not start");
      controller.abort(new Error("test cancellation"));
      await assert.rejects(result, /test cancellation/);
      await assert.rejects(readFile(f.marker), { code: "ENOENT" });
    } finally {
      controller.abort();
      await result.catch(() => {});
    }
  },
);
