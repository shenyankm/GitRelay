import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectPlatform } from "../../src/cli/platform-detection.ts";
import { commandOutput } from "../../src/cli/command-output.ts";

test("version detection rejects distinct version candidates", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-version-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, "codex");
  await writeFile(command, "#!/bin/sh\nprintf '%s\\n' \"$VERSION_TEXT\"\n");
  await chmod(command, 0o755);
  const detect = (output: string) => detectPlatform("codex", { PATH: dir, VERSION_TEXT: output });

  for (const output of [
    "runtime 0.164.0\ncodex 3.0.0",
    "runtime 3.0.0\ncodex 0.164.0",
    "codex v0.164.0,2.1.3",
    "codex 0.164.0-01 then 0.164.0",
    "codex 0.164.0+one and 0.164.0+two",
  ]) {
    const result = await detect(output);
    assert.equal(result.status, "unavailable");
    assert.match("reason" in result ? result.reason : "", /Ambiguous version output/);
  }
  assert.deepEqual(await detect("codex v0.164.0 and 0.164.0"), {
    platform: "codex",
    status: "installed",
    version: "0.164.0",
    previouslyTested: true,
  });
  assert.equal((await detect("wrapper started\ncodex 3.0.0")).status, "unverified");
  assert.equal((await detect("codex 0.164.0-rc.1+build-123")).status, "unverified");
  assert.equal((await detect("codex 00.164.0")).status, "unavailable");
  assert.equal((await detect("no version present")).status, "unavailable");
});

test(
  "version detection rejects npm-incompatible length and numeric ranges",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-version-range-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const command = join(dir, "codex");
    await writeFile(command, "#!/bin/sh\nprintf '%s\\n' \"$VERSION_TEXT\"\n");
    await chmod(command, 0o755);
    const detect = (platform: "codex", version: string) =>
      detectPlatform(platform, { PATH: dir, VERSION_TEXT: version });
    for (const version of [
      "9007199254740992.1.2",
      "2.9007199254740992.0",
      "2.1.9007199254740992",
      `0.164.0+${"x".repeat(249)}`,
    ]) {
      assert.equal((await detect("codex", version)).status, "unavailable", `Codex: ${version}`);
    }
    assert.equal((await detect("codex", "2.9007199254740991.0")).status, "unverified");
    assert.equal((await detect("codex", `0.164.0+${"x".repeat(248)}`)).status, "unverified");
    assert.equal((await detect("codex", `v0.164.0+${"x".repeat(247)}`)).status, "unverified");
    assert.equal((await detect("codex", `v0.164.0+${"x".repeat(248)}`)).status, "unavailable");
    assert.equal((await detect("codex", "0.164.0-rc.1+build-123")).status, "unverified");
    assert.equal((await detect("codex", "0.164.0")).status, "installed");
  },
);

test("version detection still responds to cancellation", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "git-relay-version-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, "codex");
  await writeFile(command, "#!/bin/sh\n/bin/sleep 5\n");
  await chmod(command, 0o755);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(detectPlatform("codex", { PATH: dir }, controller.signal), { name: "AbortError" });
  } finally {
    clearTimeout(timer);
  }
});

test(
  "version detection uses stderr only to reject ambiguous output",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-version-streams-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const executable = join(dir, "codex");
    await writeFile(
      executable,
      '#!/bin/sh\nprintf \'%s\' "$VERSION_STDOUT"\nprintf \'%s\' "$VERSION_STDERR" >&2\nexit "${VERSION_EXIT:-0}"\n',
    );
    await chmod(executable, 0o755);
    const env = (stdout: string, stderr: string) => ({ PATH: dir, VERSION_STDOUT: stdout, VERSION_STDERR: stderr });
    const detect = (stdout: string, stderr: string) => detectPlatform("codex", env(stdout, stderr));
    assert.equal((await detect("runtime 0.164.0", "codex 3.0.0")).status, "unavailable");
    assert.equal((await detect("runtime 0.164.0\ncodex-v3.0.0", "")).status, "unavailable");
    assert.equal((await detect("starting tool", "dependency 0.164.0")).status, "unavailable");
    assert.equal((await detect("codex 0.164.0", "warning 0.164.0")).status, "installed");
    assert.equal(
      (await detect("codex 0.164.0", "WARNING: config /tmp/app-2.0.0/path; update 0.164.0 -> 2.2.0")).status,
      "installed",
    );
    assert.equal((await detect("codex 0.164.0", "WARNING: codex 3.0.0 is active")).status, "unavailable");
    assert.equal((await detect("codex 0.164.0", "INFO: codex version 3.0.0 is running")).status, "unavailable");
    assert.equal((await detect("codex 0.164.0", "WARNING: codex 3.0.0 is available")).status, "installed");
    assert.equal((await detect("codex 0.164.0", "WARNING: codex-3.0.0.log is active")).status, "installed");
    assert.equal((await detect("codex 0.164.0", "codex-2.0.0.log: cannot open")).status, "installed");
    assert.equal((await detect("codex 0.164.0", "codex 3.0.0-rc.1+build")).status, "unavailable");
    assert.equal((await detect("codex 0.164.0", "codex version 3.0.0")).status, "unavailable");
    assert.equal((await detect("codex 0.164.0", "codex-2.0.0/cache: cannot open")).status, "installed");
    assert.equal((await detect("codex 0.164.0", "codex-2.0.0\\cache: cannot open")).status, "installed");
    assert.equal((await detect("codex 0.164.0", "codex 3.0.0, unsupported")).status, "unavailable");
    assert.equal((await detect("codex 0.164.0", "codex 3.0.0")).status, "unavailable");
    assert.equal((await detect("codex 0.164.0", "codex 0.164.0 update available: 3.0.0")).status, "installed");
    assert.equal((await detect("codex 0.164.0", "codex-v3.0.0")).status, "unavailable");
    assert.equal(
      (await detectPlatform("codex", env("codex-cli 0.164.0", 'WARNING: CODEX_HOME "/tmp/app-2.0.0"'))).status,
      "installed",
    );
    assert.equal((await detectPlatform("codex", env("codex-cli 0.164.0", "codex-cli 0.165.0"))).status, "unavailable");
    assert.equal((await detect("codex 0.164.0-rc.3.0.0", "")).status, "unverified");
    assert.equal(await commandOutput(executable, [], env("stdout", "stderr"), 5000, 1024), "stdout");
    await assert.rejects(commandOutput(executable, [], env("", "x".repeat(300)), 5000, 100), /too large/);
    await assert.rejects(
      commandOutput(executable, [], { ...env("", "failure"), VERSION_EXIT: "1" }, 5000, 1024),
      /Command failed: failure/,
    );
  },
);
