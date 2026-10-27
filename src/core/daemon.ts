import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectRepository, retentionDays } from "./cleanup.ts";
import { sessionsIn } from "./mailbox.ts";
import { synchronizeRef } from "./publisher.ts";
import {
  assertMigrationReady,
  BusyError,
  checkManagedRoot,
  checkRepositoryDirectories,
  checkStateDirectory,
  hash,
  isId,
  readJson,
  repositoryIdentity,
  stateDirectory,
  withLock,
  writeJson,
  type Repository,
} from "./store.ts";

export interface DaemonOptions {
  signal: AbortSignal;
  intervalMs?: number;
  retentionDays?: number;
  onEvent?(event: object): void | Promise<void>;
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 5000;
  if (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000)
    throw new Error("interval-ms must be an integer between 50 and 60000.");
  const days = retentionDays(options.retentionDays);
  options.signal.throwIfAborted();
  const root = stateDirectory();
  await checkManagedRoot();
  await mkdir(join(root, "repos"), { recursive: true, mode: 0o700 });
  const token = hash(randomUUID());
  async function emit(event: object) {
    const stopped = Promise.withResolvers<void>();
    const stop = () => stopped.resolve();
    options.signal.addEventListener("abort", stop, { once: true });
    try {
      if (!options.signal.aborted) await Promise.race([options.onEvent?.(event), stopped.promise]);
    } finally {
      options.signal.removeEventListener("abort", stop);
    }
  }
  await withLock(
    join(root, "daemon.lock"),
    async () => {
      let pendingHeartbeat: Promise<void> | undefined;
      let heartbeatFailed = false;
      let heartbeatError: unknown;
      const heartbeat = async () => {
        if (heartbeatFailed) throw heartbeatError;
        pendingHeartbeat ??= writeJson(join(root, "daemon.json"), {
          pid: process.pid,
          token,
          intervalMs,
          heartbeatAt: new Date().toISOString(),
        })
          .catch((error) => {
            heartbeatFailed = true;
            heartbeatError = error;
            throw error;
          })
          .finally(() => {
            pendingHeartbeat = undefined;
          });
        await pendingHeartbeat;
      };
      let heartbeatTimer: NodeJS.Timeout | undefined;
      const cleanup = new Map<string, { completed: number; nextAttempt: number }>();
      const missing = new Set<string>();
      try {
        await heartbeat();
        heartbeatTimer = setInterval(() => void heartbeat().catch(() => {}), Math.min(intervalMs, 5000));
        heartbeatTimer.unref();
        await emit({ type: "daemon.ready", pid: process.pid, stateDirectory: root, intervalMs, retentionDays: days });
        while (!options.signal.aborted) {
          await heartbeat();
          const ids = await readdir(join(root, "repos"));
          const present = new Set(ids);
          for (const id of cleanup.keys()) if (!present.has(id)) cleanup.delete(id);
          for (const id of missing) if (!present.has(id)) missing.delete(id);
          for (const id of ids) {
            if (!isId(id) || options.signal.aborted) continue;
            const progress = cleanup.get(id) ?? { completed: -Infinity, nextAttempt: -Infinity };
            cleanup.set(id, progress);
            const now = performance.now();
            const retryDelay = Math.max(intervalMs, 5000);
            const clean = now - progress.completed >= 60 * 60 * 1000 && now >= progress.nextAttempt;
            const finishCleanup = (busy: boolean, started: number) => {
              const finished = performance.now();
              if (busy) progress.nextAttempt = finished + Math.max(retryDelay, finished - started);
              else progress.completed = finished;
            };
            try {
              const directory = join(root, "repos", id);
              await checkStateDirectory(directory);
              const metadata = (await readJson(join(directory, "repo.json"))) as Partial<Repository> | undefined;
              if (!metadata) continue; // A newly created store may not yet be registered.
              if (metadata.id !== id || typeof metadata.common !== "string")
                throw new Error(`Invalid repository metadata: ${id}`);
              if (
                !isId(metadata.identity) ||
                !["marker", "external"].includes(metadata.identitySource ?? "") ||
                hash([metadata.common, metadata.identity]) !== id
              )
                continue; // Legacy state remains untouched until explicitly migrated.
              const ready = (await readJson(join(directory, "identity-ready.json"))) as { id?: string } | undefined;
              const owner = (await readJson(join(directory, "identity-owner.json"))) as { id?: string } | undefined;
              if (ready?.id !== id || owner?.id !== id)
                throw new Error(`Incomplete GitRelay state initialization: ${directory}`);
              const identitySource = metadata.identitySource as "marker" | "external";
              await assertMigrationReady({
                id,
                common: metadata.common,
                root: metadata.common,
                directory,
                identity: metadata.identity,
                identitySource,
              });
              await checkRepositoryDirectories(directory, true);
              let common: string;
              try {
                common = await realpath(metadata.common);
                missing.delete(id);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                if (!missing.has(id)) {
                  missing.add(id);
                  await emit({
                    type: "daemon.repository-missing",
                    repo: id,
                    message: "Repository unavailable; retaining unread state. Monitoring resumes if it returns.",
                  });
                }
                if (clean && !options.signal.aborted) {
                  progress.nextAttempt = now + retryDelay;
                  const started = performance.now();
                  const report = await collectRepository(
                    {
                      id,
                      common: metadata.common,
                      root: metadata.common,
                      directory,
                      identity: metadata.identity,
                      identitySource,
                    },
                    { apply: true, retentionDays: days, signal: options.signal },
                  );
                  finishCleanup(
                    report.kept.some((event) => event.reason === "busy"),
                    started,
                  );
                  await emit({
                    type: "daemon.cleanup",
                    repo: id,
                    removed: report.removed.length,
                    kept: report.kept.length,
                  });
                }
                continue;
              }
              const current = await repositoryIdentity(common, false);
              if (hash([common, metadata.identity]) !== id || current?.identity !== metadata.identity)
                throw new Error(`Repository identity mismatch: ${id}; previous state was preserved.`);
              const repo: Repository = {
                id,
                common,
                root: common,
                directory,
                identity: metadata.identity,
                identitySource,
              };
              if (clean) progress.nextAttempt = now + retryDelay;
              await mkdir(join(directory, "trash"), { recursive: true, mode: 0o700 });
              const errors: object[] = [];
              await withLock(join(directory, "publish.lock"), async () => {
                const refs = [
                  ...new Set(
                    (await sessionsIn(repo)).filter((session) => !session.closedAt).map((session) => session.ref),
                  ),
                ];
                for (const ref of refs) {
                  options.signal.throwIfAborted();
                  try {
                    await synchronizeRef(
                      repo,
                      ref,
                      { adapter: "daemon", session: String(process.pid) },
                      options.signal,
                      token,
                    );
                  } catch (error) {
                    if (!options.signal.aborted)
                      errors.push({
                        type: "daemon.error",
                        repo: id,
                        ref,
                        message: error instanceof Error ? error.message : String(error),
                      });
                  }
                  await heartbeat();
                }
              });
              for (const error of errors) await emit(error);
              if (clean && !options.signal.aborted) {
                const started = performance.now();
                const report = await collectRepository(repo, {
                  apply: true,
                  retentionDays: days,
                  signal: options.signal,
                });
                finishCleanup(
                  report.kept.some((event) => event.reason === "busy"),
                  started,
                );
                await emit({
                  type: "daemon.cleanup",
                  repo: id,
                  removed: report.removed.length,
                  kept: report.kept.length,
                });
              }
            } catch (error) {
              if (!(error instanceof BusyError) && !options.signal.aborted)
                await emit({
                  type: "daemon.error",
                  repo: id,
                  message: error instanceof Error ? error.message : String(error),
                });
            }
          }
          if (!options.signal.aborted) await delay(intervalMs, undefined, { signal: options.signal }).catch(() => {});
        }
      } finally {
        clearInterval(heartbeatTimer);
        await pendingHeartbeat?.catch(() => {});
        const state = (await readJson(join(root, "daemon.json"))) as { token?: string } | undefined;
        if (state?.token === token) await rm(join(root, "daemon.json"), { force: true });
        if (heartbeatFailed) throw heartbeatError;
      }
    },
    { token, signal: options.signal },
  );
}
