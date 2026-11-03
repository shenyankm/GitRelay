import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

test(
  "install dry-run detects occupied destinations and Codex conflicts without writing",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "git-relay-install-preview-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "bin"),
      home = join(dir, "codex"),
      config = join(dir, "config"),
      data = join(dir, "data");
    await mkdir(bin);
    await mkdir(home);
    const codex = join(bin, "codex");
    await writeFile(
      codex,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; else echo \'{"installed":[]}\'; fi\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
    };
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const run = promisify(execFile);
    const preview = async (platform: string) => {
      const result = await run(
        process.execPath,
        ["--experimental-strip-types", cli, "install", "--platform", platform, "--dry-run"],
        { env },
      ).then(
        () => null,
        (error) => error,
      );
      assert.ok(result, "preview should reject the conflict");
      return JSON.parse(result.stdout).results.find((item: { platform: string }) => item.platform === platform).reason;
    };
    for (const platform of ["codex"]) {
      const output = await run(
        process.execPath,
        ["--experimental-strip-types", cli, "install", "--platform", platform, "--dry-run"],
        { env },
      );
      assert.equal(JSON.parse(output.stdout).failed, false);
      await assert.rejects(lstat(join(data, "git-relay")), { code: "ENOENT" });
    }
    const hook = join(home, "hooks.json");
    await writeFile(hook, '{"user":true}');
    assert.match(await preview("codex"), /not owned/);
    assert.equal(await readFile(hook, "utf8"), '{"user":true}');
    await rm(hook);
    await writeFile(
      codex,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; else echo \'{"installed":[{"name":"git-relay"}]}\'; fi\n',
      { mode: 0o755 },
    );
    assert.match(await preview("codex"), /compatible Codex plugin/);
    await writeFile(
      codex,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; else echo \'{"installed":[]}\'; fi\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(home, "config.toml"),
      '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "git-relay hook codex"\n',
    );
    assert.match(await preview("codex"), /inline hooks.*already contain GitRelay/);
    await rm(join(home, "config.toml"));
    for (const platform of ["codex"]) {
      await run(process.execPath, ["--experimental-strip-types", cli, "install", "--platform", platform], { env });
    }
    const workspace = join(data, "git-relay");
    for (const platform of ["codex"]) {
      const revisions = join(workspace, `${platform}-revisions`);
      const invalid = join(revisions, "unexpected");
      await writeFile(invalid, "keep");
      assert.match(await preview(platform), /Unexpected .* revision/);
      assert.equal(await readFile(invalid, "utf8"), "keep");
      await rm(invalid);
      const record = JSON.parse(await readFile(join(workspace, "codex-hooks.json"), "utf8"));
      const runtimePackage = join(workspace, "runtimes", record.current.slice(21), "package.json");
      const original = await readFile(runtimePackage, "utf8");
      await writeFile(runtimePackage, "changed");
      assert.match(await preview(platform), /runtime was modified/);
      assert.equal(await readFile(runtimePackage, "utf8"), "changed");
      await writeFile(runtimePackage, original);
    }
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
      (await run(process.execPath, ["--experimental-strip-types", cli, "install"], { env })).stdout,
    );
    assert.deepEqual(
      result.results.map((item: { platform: string }) => item.platform),
      ["codex"],
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

test("installer rejects removed platforms before touching configuration", async () => {
  const { install } = await import("../../src/cli/install.ts");
  for (const action of ["install", "uninstall"] as const) {
    await assert.rejects(install(action, ["opencode"]), /Unknown platform: opencode/);
    await assert.rejects(install(action, [], ["opencode"]), /Unknown platform: opencode/);
  }
});
