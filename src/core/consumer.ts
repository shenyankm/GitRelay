import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  HistoryUnavailableError,
  inspectChange,
  pathMatcher,
  readCursor,
  resolveMain,
  worktreeFiles,
  type Change,
  type Cursor,
} from "./changes.ts";
import {
  eventsIn,
  publishUpstream,
  readSession,
  registerSession,
  sessionKey,
  validateIdentity,
  type Identity,
  type Notification,
  type SharedEvent,
} from "./mailbox.ts";
import {
  BusyError,
  GC_LOCK_TOKEN,
  checkStateDirectory,
  isId,
  readJson,
  repository,
  repositoryMetadata,
  withLock,
  writeJson,
  type Repository,
} from "./store.ts";
import { synchronizeRef } from "./publisher.ts";

export interface DeliveryLocation {
  repository: Repository;
  sessionKey: string;
}

export interface MailboxOptions extends Identity {
  cwd: string;
  ref: string;
  signal?: AbortSignal;
  initialCursor?: Cursor;
  isDelivered?(eventId: string, event?: SharedEvent, location?: DeliveryLocation): boolean | Promise<boolean>;
  /** Synchronously revalidate the host immediately before publishing a confirmed receipt. */
  beforeReceipt?(eventId: string, event?: SharedEvent, location?: DeliveryLocation): void;
  /** Skip a host-owned but not yet durable event without acknowledging it. */
  isPending?(eventId: string, event?: SharedEvent, location?: DeliveryLocation): boolean | Promise<boolean>;
  /** false means queued but not durably accepted: retry without writing a receipt. */
  deliver(notifications: Notification[], location?: DeliveryLocation): Promise<void | boolean>;
  /** Deliver and acknowledge one notification at a time. */
  deliverIndividually?: boolean;
  upstreamOnly?: boolean;
  /** Explicitly accept a notification that history could not be compared, rather than a diff. */
  acknowledgeUnavailableHistory?: boolean;
}

/** Register, publish shared ref updates, then consume this session's independent inbox. */
export async function consumeMailbox(options: MailboxOptions): Promise<Notification[]> {
  return consumeMailboxInternal(options, options.deliverIndividually === true);
}

async function consumeMailboxInternal(options: MailboxOptions, individually: boolean): Promise<Notification[]> {
  const adapter = options.adapter;
  validateIdentity({ adapter, session: "snapshot" });
  const session = options.session;
  validateIdentity({ adapter, session });
  const identity = { adapter, session, instance: options.instance };
  validateIdentity(identity);
  const signal = options.signal;
  const upstreamOnly = !!options.upstreamOnly;
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
              await writeJson(join(repo.directory, "repo.json"), repositoryMetadata(repo));
              const registered = await registerSession(repo, identity, ref, current, !upstreamOnly);
              if (!registered.migrated) {
                const legacyPath = join(repo.common, "worktree-agent-sync", `${key}.json`);
                const legacy = options.initialCursor ?? (await readJson(legacyPath));
                const previous = legacy === undefined ? undefined : readCursor(legacy, repo.root, ref);
                if (legacy !== undefined && !previous) throw new Error(`Invalid legacy cursor: ${legacyPath}`);
                const baseline = registered.baseline!;
                if (previous && previous.commit !== baseline)
                  await publishUpstream(repo, identity, ref, previous.commit, baseline, [key], `migration:${key}`);
                await writeJson(join(repo.directory, "sessions", `${key}.json`), { ...registered, migrated: true });
              }
              return true;
            },
            {
              signal,
              waitMs: 5000,
              busyToken: GC_LOCK_TOKEN,
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
        let piProofs: Set<string> | undefined;
        // Retain the legacy proof guard so removing an adapter cannot acknowledge an unknown delivery.
        const hasPiProof = async (id: string): Promise<boolean> => {
          if (adapter !== "pi") return false;
          if (!piProofs) {
            const names = await readdir(receipts);
            signal?.throwIfAborted();
            piProofs = new Set(
              names.flatMap((name) => {
                const match = /^([a-f0-9]{64})\.[a-f0-9]{64}\.pi-proof$/.exec(name);
                return match ? [match[1]] : [];
              }),
            );
          }
          return piProofs.has(id);
        };
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
          if (!event.recipients.includes(key) || (upstreamOnly && event.kind !== "upstream")) continue;
          if (event.kind === "message" && event.pathFormat === "posix-v1" && process.platform === "win32")
            throw new Error(`POSIX filename event ${event.id} requires a POSIX receiver; event preserved.`);
          if (event.kind === "upstream" && event.ref !== ref)
            throw new Error(
              `Upstream event ${event.id} targets a session subscribed to another ref; preserve state for inspection.`,
            );
          if (event.kind === "upstream" && upstreamPending) continue;
          const receipt = join(receipts, `${event.id}.json`);
          const delivered = await options.isDelivered?.(event.id, event, { repository: repo, sessionKey: key });
          signal?.throwIfAborted();
          const hasProof = await hasPiProof(event.id);
          signal?.throwIfAborted();
          const unknownProof = () =>
            new Error(
              `Pi delivery outcome is unknown for event ${event.id}; preserve the event and proofs in ${receipts} for native verification or manual recovery.`,
            );
          if (delivered) {
            if (hasProof && !options.beforeReceipt) throw unknownProof();
            await writeReceipt(
              receipt,
              event.id,
              "delivered",
              options.beforeReceipt
                ? () => {
                    const result: unknown = options.beforeReceipt!(event.id, event, {
                      repository: repo,
                      sessionKey: key,
                    });
                    if (
                      result &&
                      (typeof result === "object" || typeof result === "function") &&
                      typeof (result as { then?: unknown }).then === "function"
                    ) {
                      void Promise.resolve(result).catch(() => {});
                      throw new Error("beforeReceipt must be synchronous; the event was not acknowledged.");
                    }
                  }
                : undefined,
            );
            continue;
          }
          const pending = await options.isPending?.(event.id, event, { repository: repo, sessionKey: key });
          signal?.throwIfAborted();
          if (pending) {
            if (event.kind === "upstream") upstreamPending = true;
            continue;
          }
          if (hasProof) throw unknownProof();
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
          const length = JSON.stringify(notification).length;
          if (notifications.length && (notifications.length >= 8 || size + length > 64 * 1024)) break;
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
        const attempted: Notification[] = [];
        let blockedUpstream = false;
        for (const batch of individually ? notifications.map((notification) => [notification]) : [notifications]) {
          if (individually && blockedUpstream && batch[0].kind === "upstream") continue;
          attempted.push(...batch);
          const accepted = await options.deliver(batch, { repository: repo, sessionKey: key });
          signal?.throwIfAborted();
          if (accepted !== false) {
            for (const notification of batch)
              await writeReceipt(join(receipts, `${notification.event.id}.json`), notification.event.id, "delivered");
          } else if (batch.some((item) => item.kind === "upstream")) blockedUpstream = true;
        }
        if (historyFailure) throw historyFailure;
        return attempted;
      },
      {
        signal,
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

export interface ConsumerOptions extends Identity {
  cwd: string;
  ref: string;
  signal?: AbortSignal;
  deliver(change: Change): Promise<void>;
}

/** Compatibility API for hosts that only consume upstream changes, not agent messages. */
export async function consumeChanges(options: ConsumerOptions): Promise<Change | undefined> {
  const notifications = await consumeMailboxInternal(
    {
      ...options,
      upstreamOnly: true,
      async deliver(batch) {
        for (const notification of batch)
          if (notification.kind === "upstream") await options.deliver(notification.change);
      },
    },
    true,
  );
  return notifications.find((notification) => notification.kind === "upstream")?.change;
}
