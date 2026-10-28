import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { installCodex, uninstallCodex } from "../../src/cli/install-codex.ts";
import { withLock } from "../../src/core/store.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gitrelay-codex-generation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "git-relay"),
    sourceRoot = join(root, "source"),
    home = join(root, "home"),
    binA = join(root, "a"),
    binB = join(root, "b");
  for (const path of [workspace, sourceRoot, home, binA, binB]) await mkdir(path);
  await writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
  await cp(fileURLToPath(new URL("../../dist", import.meta.url)), join(sourceRoot, "dist"), { recursive: true });
  const waiting = join(root, "waiting"),
    ready = join(root, "ready"),
    called = join(root, "called");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const first = `#!/bin/sh\nif [ ! -e ${quote(called)} ]; then touch ${quote(called)}; echo '{"installed":[]}'; exit 0; fi\ntouch ${quote(waiting)}\nwhile [ ! -e ${quote(ready)} ]; do sleep 0.05; done\necho '{"installed":[{"name":"git-relay"}]}'\n`;
  for (const [bin, script] of [
    [binA, first],
    [binB, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.164.0'; else echo '{"installed":[]}'; fi\n`],
  ]) {
    await writeFile(join(bin, "codex"), script);
    await chmod(join(bin, "codex"), 0o755);
  }
  const options = (bin: string) => ({
    workspace,
    sourceRoot,
    env: { HOME: home, CODEX_HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root },
    clientVersion: "0.164.0",
  });
  return {
    root,
    workspace,
    sourceRoot,
    home,
    waiting,
    ready,
    a: options(binA),
    b: options(binB),
    state: join(workspace, "codex-hooks.json"),
    entry: join(await realpath(home), "hooks.json"),
  };
}

for (const transition of ["repeat", "upgrade", "reinstall"] as const)
  for (const failure of ["conflict", "abort"] as const) {
    test(
      `a later ${transition} survives an earlier Codex postcheck ${failure}`,
      { skip: process.platform === "win32", timeout: 20_000 },
      async (t) => {
        const f = await fixture(t),
          abort = new AbortController();
        const first = installCodex({ ...f.a, signal: abort.signal });
        void first.catch(() => {});
        // Ensure a failed setup cannot leave a held fake postcheck process.
        t.after(async () => {
          abort.abort();
          await writeFile(f.ready, "go").catch(() => {});
          await first.catch(() => {});
        });
        for (
          let i = 0;
          i < 400 &&
          !(await readFile(f.waiting).then(
            () => true,
            () => false,
          ));
          i++
        )
          await delay(20);
        assert.ok(
          await readFile(f.waiting).then(
            () => true,
            () => false,
          ),
          "first postcheck not reached",
        );
        const previous = JSON.parse(await readFile(f.state, "utf8"));
        if (transition === "reinstall") await uninstallCodex(f.b);
        if (transition === "upgrade") await writeFile(join(f.sourceRoot, "dist", "upgrade-marker"), "upgrade");
        await installCodex(f.b);
        const later = JSON.parse(await readFile(f.state, "utf8"));
        assert.notEqual(previous.generation, later.generation);
        if (transition === "repeat") assert.equal(previous.current, later.current);
        if (transition === "upgrade") assert.notEqual(previous.current, later.current);
        if (transition === "reinstall") assert.notEqual(previous.anchor, later.anchor);
        if (failure === "abort") abort.abort();
        else await writeFile(f.ready, "go");
        await assert.rejects(first, /newer installation preserved/);
        const result = JSON.parse(await readFile(f.state, "utf8"));
        assert.equal(result.generation, later.generation);
        assert.equal(result.removed, undefined);
        assert.ok(await readFile(f.entry));
      },
    );
  }

test(
  "CLI Codex uninstall honors cancellation while its installation lock is busy",
  { skip: process.platform === "win32", timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    await installCodex(f.b);
    const original = await readFile(f.entry, "utf8");
    const marker = join(f.root, "waiting-for-lock"),
      preload = join(f.root, "observe-lock.mjs");
    await writeFile(
      preload,
      `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.open;
fs.promises.open = async (...args) => { if (String(args[0]).endsWith('/codex-hooks.lock')) fs.writeFileSync(${JSON.stringify(marker)}, 'waiting'); return original(...args); };
syncBuiltinESMExports();`,
    );
    await withLock(join(f.workspace, "codex-hooks.lock"), async () => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          preload,
          "--experimental-strip-types",
          fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
          "uninstall",
          "--platform",
          "codex",
        ],
        {
          env: { ...f.b.env, XDG_DATA_HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config") },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.resume();
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", reject);
      });
      try {
        for (
          let i = 0;
          i < 300 &&
          !(await readFile(marker).then(
            () => true,
            () => false,
          ));
          i++
        ) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`CLI exited before waiting for the lock: ${stderr}`);
          await delay(10);
        }
        assert.ok(
          await readFile(marker).then(
            () => true,
            () => false,
          ),
          "CLI did not wait for the lock",
        );
        child.kill("SIGINT");
        assert.deepEqual(await exited, { code: 130, signal: null });
        assert.match(stderr, /operation may have completed/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    });
    assert.equal(await readFile(f.entry, "utf8"), original);
    assert.notEqual(JSON.parse(await readFile(f.state, "utf8")).removed, true);
  },
);

for (const point of ["preaborted", "lock-wait", "after-journal", "after-archive"] as const) {
  test(
    `Codex uninstall cancellation at ${point} preserves a recoverable state`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await fixture(t),
        abort = new AbortController();
      await installCodex(f.b);
      const original = await readFile(f.entry, "utf8");
      if (point === "preaborted") {
        abort.abort();
        await assert.rejects(uninstallCodex({ ...f.b, signal: abort.signal }), /abort/i);
      } else if (point === "lock-wait") {
        await withLock(join(f.workspace, "codex-hooks.lock"), async () => {
          const pending = uninstallCodex({ ...f.b, signal: abort.signal });
          await delay(10);
          abort.abort();
          await assert.rejects(pending, /abort/i);
        });
      } else {
        const rename = fs.promises.rename,
          renameSync = fs.renameSync;
        let triggered = false;
        fs.renameSync = function (source, target) {
          const hit =
            point === "after-journal" &&
            String(target) === f.state &&
            typeof JSON.parse(fs.readFileSync(source, "utf8")).removing === "string";
          renameSync(source, target);
          if (hit) {
            triggered = true;
            abort.abort();
          }
        };
        fs.promises.rename = async function (source, target) {
          const hit = point === "after-archive" && String(source) === f.entry;
          await rename.call(this, source, target);
          if (hit) {
            triggered = true;
            abort.abort();
          }
        };
        syncBuiltinESMExports();
        try {
          await assert.rejects(uninstallCodex({ ...f.b, signal: abort.signal }), /abort/i);
        } finally {
          fs.renameSync = renameSync;
          fs.promises.rename = rename;
          syncBuiltinESMExports();
        }
        assert.ok(triggered);
        const record = JSON.parse(await readFile(f.state, "utf8"));
        assert.ok(record.removing);
        assert.equal(record.removed, undefined);
        if (point === "after-journal") assert.equal(await readFile(f.entry, "utf8"), original);
        else assert.equal(await readFile(record.removing, "utf8"), original);
      }
      const archive = await uninstallCodex(f.b);
      assert.equal(await readFile(archive!, "utf8"), original);
      assert.equal(await uninstallCodex(f.b), archive);
      assert.equal(JSON.parse(await readFile(f.state, "utf8")).removed, true);
    },
  );
}

for (const mutation of ["missing-record", "recreated-entry"] as const) {
  test(
    `Codex postcheck preserves hooks after ${mutation}`,
    { skip: process.platform === "win32", timeout: 20_000 },
    async (t) => {
      const f = await fixture(t),
        abort = new AbortController();
      const first = installCodex({ ...f.a, signal: abort.signal });
      void first.catch(() => {});
      t.after(async () => {
        abort.abort();
        await writeFile(f.ready, "go").catch(() => {});
        await first.catch(() => {});
      });
      for (
        let i = 0;
        i < 400 &&
        !(await readFile(f.waiting).then(
          () => true,
          () => false,
        ));
        i++
      )
        await delay(20);
      assert.ok(
        await readFile(f.waiting).then(
          () => true,
          () => false,
        ),
        "first postcheck not reached",
      );
      const hooks = await readFile(f.entry, "utf8");
      if (mutation === "missing-record") await rm(f.state);
      else {
        await uninstallCodex(f.b);
        await writeFile(f.entry, hooks);
      }
      await writeFile(f.ready, "go");
      await assert.rejects(
        first,
        mutation === "missing-record" ? /record is missing; hooks preserved/ : /hooks were recreated; preserved/,
      );
      assert.equal(await readFile(f.entry, "utf8"), hooks);
    },
  );
}
