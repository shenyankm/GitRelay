import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { consumeMailbox } from "./consumer.ts";
import { eventsIn, readReceipt, readSession, sessionKey, type Identity, type Notification } from "./mailbox.ts";
import { inspectRepository, repository, type Repository } from "./repository.ts";
import { checkStateDirectory, GC_LOCK_TOKEN, hash, isId, readJson, withLock, writeJson } from "./store.ts";

export const MCP_INLINE_BYTES = 8192;
const DETAIL_CHUNK_BYTES = 2048;

export const newSessionToken = () => randomBytes(32).toString("hex");

/** Public session records contain only this digest, never the resumable handle. */
export function mcpIdentity(sessionToken: string): Identity {
  if (!isId(sessionToken))
    throw new TypeError("sessionToken must be the 64-character handle returned by join_session.");
  return { adapter: "mcp", session: hash(sessionToken) };
}

export interface McpMailboxOptions {
  cwd: string;
  ref: string;
  sessionToken: string;
  signal?: AbortSignal;
}

interface Delivery {
  version: 1;
  key: string;
  id: string;
  eventIds: string[];
  phase: "pending" | "accepting" | "acknowledged";
  details?: { text: string; readOffset: number };
}

function batchId(repo: Repository, key: string, eventIds: string[], text?: string) {
  return hash(text === undefined ? [repo.id, key, eventIds] : [repo.id, key, eventIds, text]);
}

async function readDelivery(repo: Repository, key: string): Promise<Delivery | undefined> {
  const path = join(repo.directory, "receipts", key, "mcp-delivery.json");
  const value = (await readJson(path, true)) as Delivery | undefined;
  if (value === undefined) return;
  const details = value?.details;
  const invalidDetails =
    details !== undefined &&
    (!details ||
      typeof details.text !== "string" ||
      !Number.isSafeInteger(details.readOffset) ||
      details.readOffset < 0 ||
      details.readOffset > Buffer.byteLength(details.text) ||
      (value?.phase !== "pending" && details.readOffset !== Buffer.byteLength(details.text)));
  if (
    !value ||
    invalidDetails ||
    value.version !== 1 ||
    value.key !== key ||
    !isId(value.id) ||
    !Array.isArray(value.eventIds) ||
    value.eventIds.length === 0 ||
    value.eventIds.length > 8 ||
    !value.eventIds.every(isId) ||
    new Set(value.eventIds).size !== value.eventIds.length ||
    !["pending", "accepting", "acknowledged"].includes(value.phase) ||
    value.id !== batchId(repo, key, value.eventIds, details?.text)
  )
    throw new Error("Invalid MCP delivery; unread events were preserved.");
  return value;
}

export async function receiveMessages(options: McpMailboxOptions & { acceptUnavailableHistory?: boolean }) {
  options = { ...options };
  const identity = mcpIdentity(options.sessionToken);
  const { repository: repo } = await inspectRepository(options.cwd, options.signal);
  if (!repo) throw new Error("Join this worktree with join_session before receiving messages.");
  const key = sessionKey(repo, identity, options.ref);
  const session = await readSession(repo, key);
  if (!session || session.closedAt)
    throw new Error("This subscription is closed or missing; use join_session to resume it.");
  let deliveryId: string | null = null;
  const notifications: Notification[] = [];
  let details: { totalBytes: number; notificationCount: number } | undefined;
  await consumeMailbox({
    ...identity,
    cwd: options.cwd,
    ref: options.ref,
    signal: options.signal,
    acknowledgeUnavailableHistory: options.acceptUnavailableHistory,
    maxBatchBytes: MCP_INLINE_BYTES - 128,
    async deliver(batch, location) {
      if (!location) throw new Error("Delivery location is unavailable.");
      const eventIds = batch.map((item) => item.event.id);
      const text = JSON.stringify(batch);
      const paged = Buffer.byteLength(text) > MCP_INLINE_BYTES - 128;
      const id = batchId(location.repository, location.sessionKey, eventIds, paged ? text : undefined);
      const previous = await readDelivery(location.repository, location.sessionKey);
      const record: Delivery = { version: 1, key: location.sessionKey, id, eventIds, phase: "pending" };
      if (paged) record.details = { text, readOffset: previous?.id === id ? (previous.details?.readOffset ?? 0) : 0 };
      await writeJson(
        join(location.repository.directory, "receipts", location.sessionKey, "mcp-delivery.json"),
        record,
        () => options.signal?.throwIfAborted(),
      );
      deliveryId = id;
      if (paged) details = { totalBytes: Buffer.byteLength(text), notificationCount: batch.length };
      else notifications.push(...batch);
      return false;
    },
  });
  return details ? { notifications, deliveryId, detailsRequired: true, details } : { notifications, deliveryId };
}

/** Read the exact pending batch sequentially; reads never acknowledge it. */
export async function readMessageDetails(options: McpMailboxOptions & { deliveryId: string; offset: number }) {
  if (!isId(options.deliveryId) || !Number.isSafeInteger(options.offset) || options.offset < 0)
    throw new TypeError("A valid deliveryId and nonnegative integer byte offset are required.");
  const repo = await repository(options.cwd, options.signal, false);
  const key = sessionKey(repo, mcpIdentity(options.sessionToken), options.ref);
  return withLock(
    join(repo.directory, "sessions", `${key}.lock`),
    async () => {
      const session = await readSession(repo, key);
      if (!session || session.closedAt) throw new Error("Resume this subscription before reading details.");
      const delivery = await readDelivery(repo, key);
      if (!delivery || delivery.id !== options.deliveryId)
        throw new Error("Delivery superseded or missing; receive_messages again.");
      if (!delivery.details) throw new Error("This batch is inline; no details are required.");
      const bytes = Buffer.from(delivery.details.text);
      const offset = options.offset;
      if (offset > delivery.details.readOffset || (bytes[offset] & 0xc0) === 0x80)
        throw new Error("Read details sequentially using nextOffset; unread bytes cannot be skipped.");
      let nextOffset = Math.min(offset + DETAIL_CHUNK_BYTES, bytes.length);
      while (nextOffset < bytes.length && (bytes[nextOffset] & 0xc0) === 0x80) nextOffset--;
      const text = bytes.subarray(offset, nextOffset).toString("utf8");
      if (nextOffset > delivery.details.readOffset) {
        delivery.details.readOffset = nextOffset;
        await writeJson(join(repo.directory, "receipts", key, "mcp-delivery.json"), delivery, () =>
          options.signal?.throwIfAborted(),
        );
      }
      return {
        deliveryId: delivery.id,
        offset,
        nextOffset,
        totalBytes: bytes.length,
        text,
        complete: nextOffset === bytes.length,
      };
    },
    { signal: options.signal, waitMs: 5000, recoverDeadOwner: true },
  );
}

/** Explicit client acceptance is separate from constructing or writing an MCP response. */
export async function acknowledgeMessages(options: McpMailboxOptions & { deliveryId: string }) {
  options = { ...options };
  const identity = mcpIdentity(options.sessionToken);
  if (!isId(options.deliveryId)) throw new TypeError("Invalid deliveryId.");
  const repo = await repository(options.cwd, options.signal, false);
  const key = sessionKey(repo, identity, options.ref);
  return withLock(
    join(repo.directory, "sessions", `${key}.lock`),
    () =>
      withLock(
        join(repo.directory, "publish.lock"),
        async () => {
          const directory = join(repo.directory, "receipts", key);
          await checkStateDirectory(directory);
          const path = join(directory, "mcp-delivery.json");
          const delivery = await readDelivery(repo, key);
          if (!delivery) throw new Error("Missing MCP delivery; call receive_messages before acknowledging.");
          if (delivery.id !== options.deliveryId)
            throw new Error(
              "This delivery was superseded by a later receive_messages call; acknowledge the latest batch.",
            );
          if (delivery.details && delivery.details.readOffset < Buffer.byteLength(delivery.details.text))
            throw new Error("Read all message details before acknowledging this batch.");
          if (delivery.phase === "acknowledged") return { acknowledged: delivery.eventIds, alreadyAcknowledged: true };
          const session = await readSession(repo, key);
          if (!session) throw new Error("The delivery subscription is missing; preserve its state for inspection.");
          const events = new Map((await eventsIn(repo, key, options.signal)).map((event) => [event.id, event]));
          for (const id of delivery.eventIds) {
            const event = events.get(id);
            if (await readReceipt(repo, key, id)) continue;
            // A committed acceptance may already have produced a receipt that GC collected before retry.
            if (!event && delivery.phase === "accepting") continue;
            if (!event || !event.recipients.includes(key) || (event.kind === "upstream" && event.ref !== options.ref))
              throw new Error(
                `Delivery event ${id} is missing or does not belong to this subscription; preserve state.`,
              );
          }
          if (delivery.phase === "pending")
            await writeJson(path, { ...delivery, phase: "accepting" }, () => options.signal?.throwIfAborted());
          for (const id of delivery.eventIds) {
            options.signal?.throwIfAborted();
            const receipt = await readReceipt(repo, key, id);
            if (receipt) continue;
            const event = events.get(id);
            if (!event) continue;
            await writeJson(
              join(directory, `${id}.json`),
              { eventId: id, status: "delivered", at: new Date().toISOString() },
              () => options.signal?.throwIfAborted(),
            );
          }
          await writeJson(path, { ...delivery, phase: "acknowledged" }, () => options.signal?.throwIfAborted());
          return { acknowledged: delivery.eventIds, alreadyAcknowledged: false };
        },
        { signal: options.signal, waitMs: 5000, busyToken: GC_LOCK_TOKEN, recoverDeadOwner: true },
      ),
    { signal: options.signal, waitMs: 5000, recoverDeadOwner: true },
  );
}
