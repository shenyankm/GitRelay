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
import { BusyError, GC_LOCK_TOKEN, checkStateDirectory, hash, readJson, withLock } from "./store.ts";
import { checkRepositoryDirectories, repository, type Repository } from "./repository.ts";

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
  kept: { id: string; reason: "unconfirmed" | "retention" | "busy" | "subscription" | "publication" }[];
}

export function retentionDays(value = 7): number {
  if (!Number.isFinite(value) || value < 0 || value * 86_400_000 > Number.MAX_SAFE_INTEGER)
    throw new Error("retentionDays must be a finite, non-negative number of days.");
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
      const registered = new Map<string, boolean>();
      const approved: SharedEvent[] = [];
      const trashNames = await readdir(join(repo.directory, "trash"));
      for (let offset = 0; offset < trashNames.length; offset += 4) {
        options.signal?.throwIfAborted();
        const reads = await Promise.allSettled(
          trashNames.slice(offset, offset + 4).map(async (name) => {
            const parsed = parseEventFilename(name);
            if (!parsed) return;
            const value = await readJson(join(repo.directory, "trash", name));
            return value === undefined ? undefined : validateEvent(value, parsed.id, parsed.posixPaths);
          }),
        );
        for (const result of reads) {
          if (result.status === "rejected") throw result.reason;
          if (result.value) approved.push(result.value);
        }
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
      const refs = [
        ...new Set([...approved, ...events].flatMap((event) => (event.kind === "upstream" ? [event.ref] : []))),
      ];
      for (let offset = 0; offset < refs.length; offset += 32) {
        options.signal?.throwIfAborted();
        const batch = refs.slice(offset, offset + 32);
        const reads = await Promise.allSettled(batch.map((ref) => readRef(repo, ref)));
        for (const [index, result] of reads.entries()) {
          if (result.status === "rejected") throw result.reason;
          cursors.set(batch[index], result.value);
        }
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
                  recoverDeadOwner: true,
                }),
              ),
            );
            const failures = checks.filter((check) => check.status === "rejected");
            const failure = failures.find(({ reason }) => !(reason instanceof BusyError)) ?? failures[0];
            if (failure) throw failure.reason;
          }
          if (!committed) {
            let latest = Date.parse(event.createdAt);
            for (let offset = 0; offset < event.recipients.length;) {
              // Preserve the cheap first-recipient stop before starting a batch.
              const batch = event.recipients.slice(offset, offset + (offset === 0 ? 1 : 32));
              const checks = await Promise.allSettled(
                batch.map(async (key) => {
                  const receipt = await readReceipt(repo, key, event.id);
                  const session = receipt && !registered.has(key) ? await readSession(repo, key) : undefined;
                  return { key, receipt, session };
                }),
              );
              for (const check of checks) {
                if (check.status === "rejected") throw check.reason;
                const { key, receipt, session } = check.value;
                if (!receipt) {
                  report.kept.push({ id: event.id, reason: "unconfirmed" });
                  continue eventLoop;
                }
                if (!registered.has(key)) registered.set(key, session !== undefined);
                if (!registered.get(key)) {
                  report.kept.push({ id: event.id, reason: "subscription" });
                  continue eventLoop;
                }
                latest = Math.max(latest, Date.parse(receipt.at));
              }
              offset += batch.length;
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
          for (let offset = 0; offset < event.recipients.length; offset += 32) {
            const deletions = await Promise.allSettled(
              event.recipients.slice(offset, offset + 32).map(async (key) => {
                const directory = join(repo.directory, "receipts", key);
                await rm(join(directory, `${event.id}.json`), { force: true });
              }),
            );
            for (const deletion of deletions) if (deletion.status === "rejected") throw deletion.reason;
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
    { signal: options.signal, waitMs: 5000, token: GC_LOCK_TOKEN, recoverDeadOwner: true },
  );
}

export async function collectGarbage(cwd: string, options: CleanupOptions = {}): Promise<CleanupReport> {
  retentionDays(options.retentionDays);
  return collectRepository(await repository(cwd, options.signal), options);
}
