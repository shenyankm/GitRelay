import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  eventFilename,
  eventsIn,
  parseEventFilename,
  readReceipt,
  readSession,
  validateEvent,
  type SharedEvent,
} from "./mailbox.ts";
import { readRef } from "./publisher.ts";
import {
  BusyError,
  GC_LOCK_TOKEN,
  checkRepositoryDirectories,
  checkStateDirectory,
  hash,
  readJson,
  repository,
  withLock,
  type Repository,
} from "./store.ts";

export interface CleanupOptions {
  apply?: boolean;
  retentionDays?: number;
  signal?: AbortSignal;
}
export interface CleanupReport {
  dryRun: boolean;
  retentionDays: number;
  eligible: string[];
  removed: string[];
  kept: { id: string; reason: "unconfirmed" | "retention" | "busy" | "migration" | "publication" }[];
}

export function retentionDays(value = 7): number {
  if (!Number.isFinite(value) || value < 0 || value * 86_400_000 > Number.MAX_SAFE_INTEGER)
    throw new Error("retention-days must be a finite, non-negative number of days.");
  return value;
}

/** Only events fully confirmed by all original recipients can enter the deletion journal. */
export async function collectRepository(repo: Repository, options: CleanupOptions = {}): Promise<CleanupReport> {
  const days = retentionDays(options.retentionDays);
  await checkRepositoryDirectories(repo.directory);
  const report: CleanupReport = { dryRun: !options.apply, retentionDays: days, eligible: [], removed: [], kept: [] };
  return withLock(
    join(repo.directory, "publish.lock"),
    async () => {
      // Session metadata cannot change through the relay while this publication lock is held.
      const migrated = new Set<string>();
      const proofFiles = new Map<string, Map<string, string[]>>();
      const approved: SharedEvent[] = [];
      for (const name of await readdir(join(repo.directory, "trash"))) {
        options.signal?.throwIfAborted();
        const parsed = parseEventFilename(name);
        if (!parsed) continue;
        const value = await readJson(join(repo.directory, "trash", name));
        if (value !== undefined) approved.push(validateEvent(value, parsed.id, parsed.posixPaths));
      }
      const events = await eventsIn(repo, undefined, options.signal); // Validate before making any deletion.
      const trashIds = new Set(approved.map(({ id }) => id));
      if (trashIds.size !== approved.length)
        throw new Error("Duplicate event formats in trash; preserve state for inspection.");
      const duplicate = events.find(({ id }) => trashIds.has(id));
      if (duplicate) throw new Error(`Event exists in both events and trash: ${duplicate.id}`);
      // A published event can be consumed before its ref cursor is committed. Keep
      // its receipts until recovery has committed the cursor, including old trash.
      // Read every cursor before deleting anything so a damaged one fails closed.
      const cursors = new Map<string, Awaited<ReturnType<typeof readRef>>>();
      for (const event of [...approved, ...events]) {
        if (event.kind === "upstream" && !cursors.has(event.ref))
          cursors.set(event.ref, await readRef(repo, event.ref));
      }
      const recipientSet = new Set<string>();
      for (const event of [...approved, ...events]) for (const key of event.recipients) recipientSet.add(key);
      const recipients = [...recipientSet];
      for (let offset = 0; offset < recipients.length; offset += 32) {
        options.signal?.throwIfAborted();
        const checks = await Promise.allSettled(
          recipients
            .slice(offset, offset + 32)
            .map((key) => checkStateDirectory(join(repo.directory, "receipts", key), true)),
        );
        for (const check of checks) if (check.status === "rejected") throw check.reason;
      }
      const cutoff = Date.now() - days * 86_400_000;
      eventLoop: for (const event of [...approved, ...events]) {
        options.signal?.throwIfAborted();
        const committed = trashIds.has(event.id);
        if (event.kind === "upstream") {
          const cursor = cursors.get(event.ref);
          if (
            !cursor ||
            (cursor.commit === event.previous &&
              event.id === hash(["upstream", event.ref, event.previous, event.commit, cursor.eventId ?? ""]))
          ) {
            report.kept.push({ id: event.id, reason: "publication" });
            continue;
          }
        }
        try {
          // Existing consumers hold session locks; new consumers cannot pass the publication lock held by GC.
          const keys = [...new Set(event.recipients)].sort();
          for (let offset = 0; offset < keys.length; offset += 32) {
            options.signal?.throwIfAborted();
            // Drain every lock operation before proceeding or releasing publish.lock on failure.
            const checks = await Promise.allSettled(
              keys.slice(offset, offset + 32).map((key) =>
                withLock(join(repo.directory, "sessions", `${key}.lock`), async () => {}, {
                  signal: options.signal,
                }),
              ),
            );
            const failures = checks.filter((check) => check.status === "rejected");
            const failure = failures.find(({ reason }) => !(reason instanceof BusyError)) ?? failures[0];
            if (failure) throw failure.reason;
          }
          if (!committed) {
            let latest = Date.parse(event.createdAt);
            for (const key of event.recipients) {
              const receipt = await readReceipt(repo, key, event.id);
              if (!receipt) {
                report.kept.push({ id: event.id, reason: "unconfirmed" });
                continue eventLoop;
              }
              if (!migrated.has(key)) {
                const session = await readSession(repo, key);
                if (!session?.migrated) {
                  report.kept.push({ id: event.id, reason: "migration" });
                  continue eventLoop;
                }
                migrated.add(key);
              }
              latest = Math.max(latest, Date.parse(receipt.at));
            }
            if (latest > cutoff) {
              report.kept.push({ id: event.id, reason: "retention" });
              continue;
            }
          }
          report.eligible.push(event.id);
          if (!options.apply) continue;
          options.signal?.throwIfAborted();
          const trash = join(repo.directory, "trash", eventFilename(event));
          // The rename commits deletion. A crash can only leave confirmed events in trash.
          if (!committed) await rename(join(repo.directory, "events", eventFilename(event)), trash);
          for (const key of event.recipients) {
            const directory = join(repo.directory, "receipts", key);
            let byEvent = proofFiles.get(key);
            if (!byEvent) {
              byEvent = new Map();
              for (const name of await readdir(directory).catch((error) => {
                if (error.code === "ENOENT") return [];
                throw error;
              })) {
                const match = /^([a-f0-9]{64})\.[a-f0-9]{64}\.pi-proof$/.exec(name);
                if (match) byEvent.set(match[1], [...(byEvent.get(match[1]) ?? []), name]);
              }
              proofFiles.set(key, byEvent);
            }
            await rm(join(directory, `${event.id}.json`), { force: true });
            for (const proof of byEvent.get(event.id) ?? []) await rm(join(directory, proof), { force: true });
          }
          await rm(trash, { force: true });
          report.removed.push(event.id);
        } catch (error) {
          if (error instanceof BusyError) report.kept.push({ id: event.id, reason: "busy" });
          else throw error;
        }
      }
      return report;
    },
    { signal: options.signal, waitMs: 5000, token: GC_LOCK_TOKEN },
  );
}

export async function collectGarbage(cwd: string, options: CleanupOptions = {}): Promise<CleanupReport> {
  retentionDays(options.retentionDays);
  return collectRepository(await repository(cwd, options.signal), options);
}
