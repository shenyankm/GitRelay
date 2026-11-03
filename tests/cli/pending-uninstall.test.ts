import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { installCodex, uninstallCodex } from "../../src/cli/install-codex.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "gitrelay-pending-uninstall-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace"),
    sourceRoot = join(base, "source");
  const home = join(base, "home"),
    bin = join(base, "bin");
  await mkdir(workspace);
  await writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
  await mkdir(sourceRoot);
  await cp(join(source, "dist"), join(sourceRoot, "dist"), { recursive: true });
  await mkdir(home);
  await mkdir(bin);
  await writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' '{\"installed\":[]}'\n");
  await chmod(join(bin, "codex"), 0o755);
  const env = {
    HOME: base,
    CODEX_HOME: home,
    PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: base,
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const options = { workspace, sourceRoot, env, clientVersion: "0.164.0" };
  return {
    workspace,
    sourceRoot,
    env,
    state: join(workspace, "codex-hooks.json"),
    revisions: join(workspace, "codex-revisions"),
    lock: join(workspace, "codex-hooks.lock"),
    install: () => installCodex(options),
    uninstall: () => uninstallCodex(options),
  };
}

async function interruptRevision(f: Awaited<ReturnType<typeof fixture>>, phase: "before" | "after") {
  const original = fs.promises.writeFile;
  let injected = false;
  fs.promises.writeFile = async function (path, data, options) {
    if (typeof path === "string" && path.startsWith(`${f.revisions}${sep}`)) {
      injected = true;
      if (phase === "before") throw new Error("interrupted revision publication");
      await original.call(this, path, data, options);
      throw new Error("interrupted revision publication");
    }
    return original.call(this, path, data, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.install(), /interrupted revision publication/);
  } finally {
    fs.promises.writeFile = original;
    syncBuiltinESMExports();
  }
  assert.ok(injected);
}

for (const existing of [false, true])
  for (const phase of ["before", "after"] as const)
    for (const changed of [false, true]) {
      test(
        `Codex can uninstall and reinstall after ${existing ? "upgrade" : "initial install"} interrupts ${phase} revision publication${changed ? " with a changed package" : ""}`,
        { skip: process.platform === "win32" },
        async (t) => {
          const f = await fixture(t);
          if (existing) {
            await f.install();
            await writeFile(join(f.sourceRoot, "dist", "upgrade-marker"), "new version");
          }
          await interruptRevision(f, phase);
          const pending = JSON.parse(await readFile(f.state, "utf8")).pending as string;
          assert.ok(pending);
          assert.equal((await readdir(f.revisions)).includes(pending), phase === "after");
          const archive = await f.uninstall();
          const removed = JSON.parse(await readFile(f.state, "utf8"));
          assert.equal(removed.removed, true);
          assert.equal(removed.pending, pending);
          assert.equal(await f.uninstall(), archive);
          if (changed) await writeFile(join(f.sourceRoot, "dist", "later-package"), "later version");
          await f.install();
          const completed = JSON.parse(await readFile(f.state, "utf8"));
          assert.ok(completed.current);
          assert.equal(completed.pending, undefined);
          assert.equal(completed.removed, undefined);
          if (archive) assert.ok(await readFile(archive));
        },
      );
    }

test(
  `Codex preserves a modified pending revision during uninstall`,
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await f.install();
    await writeFile(join(f.sourceRoot, "dist", "upgrade-marker"), "new version");
    await interruptRevision(f, "after");
    const pending = JSON.parse(await readFile(f.state, "utf8")).pending as string;
    const path = join(f.revisions, pending);
    await writeFile(path, "modified");
    const archive = await f.uninstall();
    assert.equal(await f.uninstall(), archive);
    await assert.rejects(f.install(), /revision was modified/);
    assert.equal(await readFile(path, "utf8"), "modified");
    if (archive) assert.ok(await readFile(archive));
  },
);

test(
  `Codex can uninstall and reinstall after SIGKILL during an upgrade`,
  { timeout: 15_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await f.install();
    await writeFile(join(f.sourceRoot, "dist", "upgrade-marker"), "new version");
    const module = new URL("../../src/cli/install-codex.ts", import.meta.url).href;
    const call = `await m.installCodex({workspace:${JSON.stringify(f.workspace)},sourceRoot:${JSON.stringify(f.sourceRoot)},env:process.env,clientVersion:"0.164.0"});`;
    const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const m = await import(${JSON.stringify(module)});
    const original = fs.promises.writeFile;
    fs.promises.writeFile = async function(path, data, options) {
      await original.call(this, path, data, options);
      if (typeof path === "string" && path.startsWith(${JSON.stringify(`${f.revisions}${sep}`)})) {
        process.stdout.write("REVISION_WRITTEN\\n");
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    };
    syncBuiltinESMExports();
    ${call}
  `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("exit", (_code, signal) => resolve({ signal }));
      child.once("error", reject);
    });
    try {
      const deadline = Date.now() + 8000;
      while (!output.includes("REVISION_WRITTEN\n")) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Installer exited early: ${errors}`);
        if (Date.now() > deadline) throw new Error(`Installer did not reach revision publication: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lockBefore = await readFile(f.lock, "utf8");
      assert.equal(JSON.parse(lockBefore).pid, child.pid);
      child.kill("SIGKILL");
      assert.equal((await exited).signal, "SIGKILL");
      assert.equal(await readFile(f.lock, "utf8"), lockBefore);
      await rm(f.lock);
      const pending = JSON.parse(await readFile(f.state, "utf8")).pending as string;
      assert.ok(pending);
      const archive = await f.uninstall();
      assert.equal(JSON.parse(await readFile(f.state, "utf8")).pending, pending);
      assert.equal(await f.uninstall(), archive);
      await f.install();
      assert.equal(JSON.parse(await readFile(f.state, "utf8")).pending, undefined);
      if (archive) assert.ok(await readFile(archive));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  },
);
