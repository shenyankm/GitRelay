import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { consumeMailbox } from "./consumer.ts";
import { eventsIn, readReceipt, readSession, sessionKey, type Identity, type Notification } from "./mailbox.ts";
import { inspectRepository, repository, type Repository } from "./repository.ts";
import { checkStateDirectory, GC_LOCK_TOKEN, hash, isId, readJson, withLock, writeJson } from "./store.ts";

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
}

async function readDelivery(repo: Repository, key: string): Promise<Delivery | undefined> {
  const path = join(repo.directory, "receipts", key, "mcp-delivery.json");
  const value = (await readJson(path, true)) as Delivery | undefined;
  if (value === undefined) return;
  if (
    !value ||
    value.version !== 1 ||
    value.key !== key ||
    !isId(value.id) ||
    !Array.isArray(value.eventIds) ||
    value.eventIds.length === 0 ||
    value.eventIds.length > 8 ||
    !value.eventIds.every(isId) ||
    new Set(value.eventIds).size !== value.eventIds.length ||
    !["pending", "accepting", "acknowledged"].includes(value.phase) ||
    value.id !== hash([repo.id, key, value.eventIds])
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
  await consumeMailbox({
    ...identity,
    cwd: options.cwd,
    ref: options.ref,
    signal: options.signal,
    acknowledgeUnavailableHistory: options.acceptUnavailableHistory,
    async deliver(batch, location) {
      if (!location) throw new Error("Delivery location is unavailable.");
      const eventIds = batch.map((item) => item.event.id);
      const id = hash([location.repository.id, location.sessionKey, eventIds]);
      await readDelivery(location.repository, location.sessionKey);
      await writeJson(
        join(location.repository.directory, "receipts", location.sessionKey, "mcp-delivery.json"),
        { version: 1, key: location.sessionKey, id, eventIds, phase: "pending" } satisfies Delivery,
        () => options.signal?.throwIfAborted(),
      );
      deliveryId = id;
      notifications.push(...batch);
      return false;
    },
  });
  return { notifications, deliveryId };
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
