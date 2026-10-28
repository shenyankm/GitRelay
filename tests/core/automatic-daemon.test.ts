import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ensureAutomaticDaemon, runAutomaticDaemon } from "../../src/core/automatic-daemon.ts";
import { daemonStatus } from "../../src/core/daemon-state.ts";
import { hash, stateDirectory, withLock, writeJson } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

async function waitFor(check: () => Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, "automatic daemon timed out");
    await delay(20);
  }
}

async function processTable(t: TestContext) {
  const f = await fixture(t);
  const bin = join(f.root, "bin"),
    table = join(f.root, "processes");
  await mkdir(bin);
  await writeFile(table, "");
  await writeFile(join(bin, "ps"), `#!/bin/sh\n/bin/cat '${table}'\n`, { mode: 0o755 });
  await symlink(process.execPath, join(bin, "node"));
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  return { ...f, table, bin };
}

test(
  "a healthy daemon avoids process-table scans while retaining startup serialization",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await processTable(t);
    await mkdir(stateDirectory(), { recursive: true });
    const token = hash("healthy-daemon");
    await writeJson(join(stateDirectory(), "daemon.lock"), { pid: process.pid, token });
    await writeJson(join(stateDirectory(), "daemon.json"), {
      pid: process.pid,
      token,
      intervalMs: 5000,
      heartbeatAt: new Date().toISOString(),
    });
    await writeFile(join(f.bin, "ps"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await ensureAutomaticDaemon("codex");
    assert.equal((await daemonStatus()).state?.token, token);
    await assert.rejects(readFile(join(stateDirectory(), "daemon-start.lock")), { code: "ENOENT" });
  },
);

test(
  "a healthy-daemon fast path retries native startup if shutdown wins the lock",
  { skip: process.platform === "win32", timeout: 20_000 },
  async (t) => {
    let f: Awaited<ReturnType<typeof processTable>>;
    const release = Promise.withResolvers<void>();
    let shutdown: Promise<void> | undefined;
    t.after(async () => {
      release.resolve();
      await shutdown;
      if (f) {
        await writeFile(f.table, "");
        await waitFor(async () => !(await daemonStatus()).running);
      }
    });
    f = await processTable(t);
    await mkdir(stateDirectory(), { recursive: true });
    await writeFile(f.table, `${process.pid} 1 /app/codex\n`);
    const token = hash("exiting-daemon");
    await writeJson(join(stateDirectory(), "daemon.lock"), { pid: process.pid, token });
    await writeJson(join(stateDirectory(), "daemon.json"), {
      pid: process.pid,
      token,
      intervalMs: 5000,
      heartbeatAt: new Date().toISOString(),
    });
    const acquired = Promise.withResolvers<void>();
    shutdown = withLock(join(stateDirectory(), "daemon-start.lock"), async () => {
      acquired.resolve();
      await release.promise;
      await rm(join(stateDirectory(), "daemon.json"));
      await rm(join(stateDirectory(), "daemon.lock"));
    });
    await acquired.promise;
    const starting = ensureAutomaticDaemon("codex");
    await delay(50);
    release.resolve();
    await Promise.all([shutdown, starting]);
    assert.equal((await daemonStatus()).running, true);
    assert.notEqual((await daemonStatus()).state?.token, token);
  },
);

test(
  "automatic daemon stays for either client and stops after the last exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const abort = new AbortController();
    let running: Promise<void> | undefined;
    t.after(async () => {
      abort.abort();
      await running;
    });
    const f = await processTable(t);
    await writeFile(f.table, "101 1 /app/codex\n102 1 /app/opencode\n");
    running = runAutomaticDaemon({ signal: abort.signal, intervalMs: 50 });
    await waitFor(async () => (await daemonStatus()).running);
    const token = (await daemonStatus()).state!.token;
    await writeFile(f.table, "102 1 /app/opencode\n");
    await delay(180);
    assert.equal((await daemonStatus()).state?.token, token);
    await writeFile(f.table, "");
    await running;
    assert.equal((await daemonStatus()).running, false);
    await assert.rejects(readFile(join(stateDirectory(), "daemon.lock")), { code: "ENOENT" });
    await assert.rejects(readFile(join(stateDirectory(), "daemon-start.lock")), { code: "ENOENT" });
  },
);

test(
  "failed client discovery does not claim that all clients exited",
  { skip: process.platform === "win32" },
  async (t) => {
    const abort = new AbortController(),
      errors: object[] = [];
    let running: Promise<void> | undefined;
    t.after(async () => {
      abort.abort();
      await running;
    });
    const f = await processTable(t);
    await writeFile(f.table, "101 1 /app/codex\n");
    running = runAutomaticDaemon({
      signal: abort.signal,
      intervalMs: 50,
      onEvent: (event) => {
        errors.push(event);
      },
    });
    await waitFor(async () => (await daemonStatus()).running);
    await writeFile(join(f.bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await waitFor(async () => errors.some((event: any) => event.type === "daemon.error"));
    assert.equal((await daemonStatus()).running, true);
    abort.abort();
    await running;
  },
);

test(
  "simultaneous native launches share one daemon and a later launch restarts it",
  { skip: process.platform === "win32", timeout: 30_000 },
  async (t) => {
    let f: Awaited<ReturnType<typeof processTable>>;
    const hosts: ReturnType<typeof spawn>[] = [];
    t.after(async () => {
      for (const host of hosts) if (host.exitCode === null) host.kill("SIGTERM");
      await writeFile(f.table, "");
      await waitFor(async () => !(await daemonStatus()).running);
    });
    f = await processTable(t);
    const module = new URL("../../src/core/automatic-daemon.ts", import.meta.url).href;
    const host = () => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `
      import { ensureAutomaticDaemon } from ${JSON.stringify(module)};
      process.on('message', async () => {
        try { await ensureAutomaticDaemon('codex'); process.send('ready'); }
        catch (error) { process.send(String(error)); process.exitCode = 1; process.disconnect(); }
      });
    `,
        ],
        { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      hosts.push(child);
      return child;
    };
    const start = async (children: ReturnType<typeof host>[]) => {
      await writeFile(f.table, children.map((c) => `${c.pid} 1 /app/codex\n`).join(""));
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once("message", (message) =>
                message === "ready" ? resolve() : reject(new Error(String(message))),
              );
              child.once("error", reject);
              child.send("start");
            }),
        ),
      );
    };
    const first = host(),
      second = host();
    await start([first, second]);
    const token = (await daemonStatus()).state!.token;
    first.kill("SIGTERM");
    await writeFile(f.table, `${second.pid} 1 /app/opencode\n`);
    await delay(5200);
    assert.equal((await daemonStatus()).state?.token, token);
    second.kill("SIGTERM");
    await writeFile(f.table, "");
    await waitFor(async () => !(await daemonStatus()).running);
    const third = host();
    await start([third]);
    assert.notEqual((await daemonStatus()).state!.token, token);
  },
);
