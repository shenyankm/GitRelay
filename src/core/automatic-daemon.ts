import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { daemonStatus } from "./daemon-state.ts";
import { runDaemon, type DaemonOptions } from "./daemon.ts";
import { checkManagedRoot, stateDirectory, withLock } from "./store.ts";

const exec = promisify(execFile);
const startupLock = () => join(stateDirectory(), "daemon-start.lock");

async function clientProcesses(signal?: AbortSignal) {
  if (process.platform === "win32") throw new Error("Automatic daemon lifecycle requires macOS or Linux.");
  const { stdout } = await exec("ps", ["-u", String(process.getuid!()), "-o", "pid=", "-o", "ppid=", "-o", "comm="], {
    signal,
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), name: basename(match[3]) }] : [];
  });
}

/** Hooks can pass through a shell; do not mistake test runners or tool subprocesses for native hosts. */
export async function ensureAutomaticDaemon(adapter: "codex" | "opencode", signal?: AbortSignal): Promise<void> {
  if (adapter === "opencode" && !process.versions.bun && basename(process.execPath) !== "opencode") return;
  const processes = await clientProcesses(signal);
  let current = processes.find((item) => item.pid === process.pid);
  if (current?.name !== adapter) current = processes.find((item) => item.pid === process.ppid);
  const visited = new Set<number>();
  while (current && !visited.has(current.pid) && /^(?:sh|bash|zsh|dash|fish|env)$/.test(current.name)) {
    visited.add(current.pid);
    current = processes.find((item) => item.pid === current!.parent);
  }
  if (current?.name !== adapter) return;
  await checkManagedRoot();
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  await withLock(
    startupLock(),
    async () => {
      if ((await daemonStatus()).running) return;
      const source = import.meta.url.endsWith(".ts");
      const cli = fileURLToPath(new URL(`../cli/main.${source ? "ts" : "js"}`, import.meta.url));
      const child = spawn(
        process.versions.bun ? "node" : process.execPath,
        [...(source ? ["--experimental-strip-types"] : []), cli, "daemon", "--automatic"],
        { cwd: stateDirectory(), detached: true, stdio: "ignore", env: process.env },
      );
      let failure: Error | undefined;
      child.on("error", (error) => {
        failure = error;
      });
      child.unref();
      const deadline = performance.now() + 5000;
      while (!(await daemonStatus()).running) {
        signal?.throwIfAborted();
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null || performance.now() >= deadline)
          throw new Error("GitRelay automatic daemon did not become ready; inspect daemon locks and retry.");
        await delay(25, undefined, { signal });
      }
    },
    { signal, waitMs: 10_000 },
  );
}

/** The startup lock serializes a last-client exit with a new client's startup. */
export async function runAutomaticDaemon(options: DaemonOptions): Promise<void> {
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const running = runDaemon({ ...options, signal }).catch((error) => {
    if (!signal.aborted) throw error;
  });
  const watching = (async () => {
    while (!signal.aborted) {
      await delay(options.intervalMs ?? 5000, undefined, { signal }).catch(() => {});
      if (signal.aborted) return;
      try {
        await withLock(
          startupLock(),
          async () => {
            const processes = await clientProcesses(signal);
            if (processes.some((item) => /^(?:codex|opencode)$/.test(item.name))) return;
            stop.abort();
            await running;
          },
          { signal, waitMs: 10_000 },
        );
      } catch (error) {
        if (!signal.aborted)
          await options.onEvent?.({ type: "daemon.error", message: `Client liveness check failed: ${String(error)}` });
      }
    }
  })();
  try {
    await Promise.race([running, watching]);
  } finally {
    stop.abort();
    await Promise.allSettled([running, watching]);
  }
}
