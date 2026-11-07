import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  HistoryUnavailableError,
  inspectChange,
  pathMatcher,
  resolveMain,
  worktreeFiles,
  type Change,
} from "./changes.ts";
import {
  eventsIn,
  readSession,
  registerSession,
  sessionKey,
  validateIdentity,
  type Identity,
  type Notification,
  type SharedEvent,
} from "./mailbox.ts";
import { BusyError, GC_LOCK_TOKEN, checkStateDirectory, isId, readJson, withLock, writeJson } from "./store.ts";
import { repository, writeRepositoryMetadata, type Repository } from "./repository.ts";
import { synchronizeRef } from "./publisher.ts";

export interface DeliveryLocation {
  repository: Repository;
  sessionKey: string;
}

export interface MailboxOptions extends Identity {
  cwd: string;
  ref: string;
  signal?: AbortSignal;
  /** false means queued but not durably accepted: retry without writing a receipt. */
  deliver(notifications: Notification[], location?: DeliveryLocation): Promise<void | boolean>;
  /** Explicitly accept a notification that history could not be compared, rather than a diff. */
  acknowledgeUnavailableHistory?: boolean;
  maxBatchBytes?: number;
}

/** Register, publish shared ref updates, then consume this session's independent inbox. */
export async function consumeMailbox(options: MailboxOptions): Promise<Notification[]> {
  if (
    options.maxBatchBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBatchBytes) || options.maxBatchBytes <= 0)
  )
    throw new TypeError("maxBatchBytes must be a positive integer.");
  const adapter = options.adapter;
  validateIdentity({ adapter, session: "snapshot" });
  const session = options.session;
  validateIdentity({ adapter, session });
  const identity = { adapter, session };
  validateIdentity(identity);
  const signal = options.signal;
  signal?.throwIfAborted();
  const cwd = options.cwd;
  const ref = options.ref;
  const repo = await repository(cwd, signal);
  const key = sessionKey(repo, identity, ref);
  const receipts = join(repo.directory, "receipts", key);
  await checkStateDirectory(receipts, true);
  let sessionAcquired = false;
  try {
    return await withLock(
      join(repo.directory, "sessions", `${key}.lock`),
      async () => {
        let current = "";
        let publishAcquired = false;
        let subscribed: boolean;
        try {
          subscribed = await withLock(
            join(repo.directory, "publish.lock"),
            async () => {
              signal?.throwIfAborted();
              const existing = await readSession(repo, key);
              if (existing?.closedAt) return false;
              // A daemon hint cannot rule out a later interrupted publication.
              current = await synchronizeRef(repo, ref, identity, signal);
              await writeRepositoryMetadata(repo);
              await registerSession(repo, identity, ref, current, true);
              return true;
            },
            {
              signal,
              waitMs: 5000,
              busyToken: GC_LOCK_TOKEN,
              recoverDeadOwner: adapter === "mcp",
              onAcquired: () => {
                publishAcquired = true;
              },
            },
          );
        } catch (error) {
          if (error instanceof BusyError && !publishAcquired) {
            signal?.throwIfAborted();
            return [];
          }
          throw error;
        }
        if (!subscribed) return [];
        await checkStateDirectory(receipts, true);
        await mkdir(receipts, { recursive: true, mode: 0o700 });
        await checkStateDirectory(receipts);
        const writeReceipt = (
          path: string,
          eventId: string,
          status: "delivered" | "irrelevant",
          validate?: () => void,
        ) =>
          writeJson(
            path,
            { eventId, status, at: new Date().toISOString() },
            signal || validate
              ? () => {
                  signal?.throwIfAborted();
                  validate?.();
                  signal?.throwIfAborted();
                }
              : undefined,
          );
        const notifications: Notification[] = [];
        let overlaps: ((file: string) => boolean) | undefined;
        let size = 0;
        const events = await eventsIn(repo, key, signal);
        const cursorPath = join(receipts, "delivery-cursor.json");
        const cursor = (await readJson(cursorPath)) as { after?: string; messagesFirst?: boolean } | undefined;
        if (
          cursor !== undefined &&
          (!cursor ||
            !isId(cursor.after) ||
            (cursor.messagesFirst !== undefined && typeof cursor.messagesFirst !== "boolean"))
        )
          throw new Error(`Invalid delivery cursor: ${cursorPath}`);
        const messages = events.filter((event) => event.kind === "message");
        const start = cursor ? messages.findIndex((event) => event.id === cursor.after) + 1 : 0;
        const rotated = [...messages.slice(start), ...messages.slice(0, start)];
        const upstream = events.filter((event) => event.kind === "upstream");
        const ordered: SharedEvent[] = [];
        for (let i = 0; i < Math.max(rotated.length, upstream.length); i++) {
          const pair = cursor?.messagesFirst ? [rotated[i], upstream[i]] : [upstream[i], rotated[i]];
          for (const event of pair) if (event) ordered.push(event);
        }
        let historyFailure: HistoryUnavailableError | undefined;
        let upstreamPending = false;
        for (const event of ordered) {
          signal?.throwIfAborted();
          if (!event.recipients.includes(key)) continue;
          if (event.kind === "message" && event.pathFormat === "posix-v1" && process.platform === "win32")
            throw new Error(`POSIX filename event ${event.id} requires a POSIX receiver; event preserved.`);
          if (event.kind === "upstream" && event.ref !== ref)
            throw new Error(
              `Upstream event ${event.id} targets a session subscribed to another ref; preserve state for inspection.`,
            );
          if (event.kind === "upstream" && upstreamPending) continue;
          const receipt = join(receipts, `${event.id}.json`);
          let notification: Notification | undefined;
          if (event.kind === "upstream" && event.ref === ref) {
            let change: Change | undefined;
            try {
              change = await inspectChange(
                { root: repo.root, ref: event.ref, commit: event.previous },
                event.commit,
                signal,
              );
            } catch (error) {
              if (!(error instanceof HistoryUnavailableError)) throw error;
              if (!options.acknowledgeUnavailableHistory) {
                historyFailure ??= error;
                upstreamPending = true;
                continue;
              }
              change = {
                root: repo.root,
                ref: event.ref,
                commit: event.commit,
                previous: event.previous,
                eventId: event.id,
                rewritten: false,
                unavailable: true,
                files: [],
                commits: [],
                patch: "",
              };
            }
            if (change) notification = { kind: "upstream", event, change: { ...change, eventId: event.id } };
          } else if (event.kind === "message") {
            if (event.files.length && !overlaps) {
              // File relevance uses the live worktree ref, not a prior publication cursor.
              const latest = await resolveMain(repo.root, ref, signal);
              overlaps = await pathMatcher(repo.root, await worktreeFiles(repo.root, latest, signal), signal);
            }
            if (!event.files.length || event.files.some(overlaps!)) notification = { kind: "message", event };
          }
          if (!notification) {
            await writeReceipt(receipt, event.id, "irrelevant");
            continue;
          }
          const length = Buffer.byteLength(JSON.stringify(notification));
          if (
            notifications.length &&
            (notifications.length >= 8 || size + length > (options.maxBatchBytes ?? 64 * 1024))
          )
            break;
          notifications.push(notification);
          size += length;
        }
        if (!notifications.length) {
          if (historyFailure) throw historyFailure;
          return [];
        }
        signal?.throwIfAborted();
        // Rotation never acknowledges an event; a crash only changes the next retry's starting point.
        await writeJson(
          cursorPath,
          {
            after:
              notifications.findLast((item) => item.kind === "message")?.event.id ??
              cursor?.after ??
              notifications.at(-1)!.event.id,
            messagesFirst: !cursor?.messagesFirst,
          },
          signal ? () => signal.throwIfAborted() : undefined,
        );
        const accepted = await options.deliver(notifications, { repository: repo, sessionKey: key });
        signal?.throwIfAborted();
        if (accepted !== false) {
          for (const notification of notifications)
            await writeReceipt(join(receipts, `${notification.event.id}.json`), notification.event.id, "delivered");
        }
        if (historyFailure) throw historyFailure;
        return notifications;
      },
      {
        signal,
        recoverDeadOwner: adapter === "mcp",
        onAcquired: () => {
          sessionAcquired = true;
        },
      },
    );
  } catch (error) {
    if (error instanceof BusyError && !sessionAcquired) {
      signal?.throwIfAborted();
      return [];
    }
    throw error;
  }
}
