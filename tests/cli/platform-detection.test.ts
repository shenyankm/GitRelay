import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { detectPlatform } from "../../src/cli/platform-detection.ts";

test(
  "detects installed, missing and uninspectable Codex versions",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-detect-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const write = async (name: string, script: string) => {
      const path = join(dir, name);
      await writeFile(path, `#!/bin/sh\n${script}\n`);
      await chmod(path, 0o755);
    };
    const env = { ...process.env, PATH: dir };
    await write("codex", "printf 'codex-cli 0.164.0\\n'");
    assert.deepEqual(await detectPlatform("codex", env), {
      platform: "codex",
      status: "installed",
      version: "0.164.0",
      previouslyTested: true,
    });
    await write("codex", "printf 'client failed\\n' >&2; exit 3");
    const failed = await detectPlatform("codex", env);
    assert.equal(failed.status, "unavailable");
    assert.match("reason" in failed ? failed.reason : "", /client failed/);
    await rm(join(dir, "codex"));
    assert.deepEqual(await detectPlatform("codex", env), { platform: "codex", status: "missing" });
    await write("codex", "printf 'unexpected version\\n'");
    assert.equal((await detectPlatform("codex", env)).status, "unavailable");
    await write("codex", "printf '0.165.0\\n'");
    assert.deepEqual(await detectPlatform("codex", env), {
      platform: "codex",
      status: "unverified",
      version: "0.165.0",
      previouslyTested: false,
    });
    assert.equal((await detectPlatform("codex", {})).status, "unavailable");
    const earlier = join(dir, "earlier");
    await mkdir(earlier);
    await writeFile(join(earlier, "codex"), "not executable", { mode: 0o644 });
    assert.equal(
      (await detectPlatform("codex", { ...env, PATH: `${earlier}${delimiter}${dir}` })).status,
      "unverified",
    );
    assert.equal((await detectPlatform("codex", { ...env, PATH: earlier })).status, "unavailable");
    await rm(join(earlier, "codex"));
    await mkdir(join(earlier, "codex"));
    assert.equal((await detectPlatform("codex", { ...env, PATH: earlier })).status, "unavailable");
    for (const malformed of [
      "0.164.0-",
      "0.164.0+",
      "0.164.0.9",
      "0.164.0junk",
      "0.164.0+_bad",
      "0.164.0-01",
      "00.164.0",
    ]) {
      await write("codex", `printf 'codex ${malformed}\\n'`);
      assert.equal((await detectPlatform("codex", env)).status, "unavailable");
    }
  },
);

test(
  "version detection bounds and cancels a client that ignores termination",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-detect-hung-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const executable = join(dir, "codex");
    await writeFile(executable, "#!/bin/sh\ntrap '' TERM\n/bin/sleep 30 &\nwait\n", { mode: 0o755 });
    const env = { ...process.env, PATH: dir };
    const started = Date.now();
    const result = await detectPlatform("codex", env);
    assert.equal(result.status, "unavailable");
    assert.match("reason" in result ? result.reason : "", /timed out/);
    assert.ok(Date.now() - started < 8000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    t.after(() => clearTimeout(timer));
    await assert.rejects(detectPlatform("codex", env, controller.signal), { name: "AbortError" });
  },
);
