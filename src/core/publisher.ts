import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { resolveMain } from "./changes.ts";
import {
  eventsIn,
  parseEventFilename,
  publishUpstream,
  registerSession,
  sessionsIn,
  validateEvent,
  type Identity,
  type UpstreamEvent,
} from "./mailbox.ts";
import { hash, isCommit, isId, readJson, writeJson, type Repository } from "./store.ts";

export async function readRef(
  repo: Repository,
  ref: string,
): Promise<{ ref: string; commit: string; eventId?: string; checkedAt?: string; daemonToken?: unknown } | undefined> {
  const path = join(repo.directory, "refs", `${hash(ref)}.json`);
  const cursor = (await readJson(path)) as
    { ref: string; commit: string; eventId?: string; checkedAt?: string; daemonToken?: unknown } | undefined;
  if (cursor === undefined) return;
  if (
    !cursor ||
    cursor.ref !== ref ||
    !isCommit(cursor.commit) ||
    (cursor.eventId !== undefined && !isId(cursor.eventId)) ||
    (cursor.checkedAt !== undefined &&
      (typeof cursor.checkedAt !== "string" || !Number.isFinite(Date.parse(cursor.checkedAt))))
  )
    throw new Error(`Invalid ref cursor: ${path}`);
  return cursor;
}

/** Caller owns publish.lock; monitoring uses the common directory, not a possibly removed worktree. */
export async function synchronizeRef(
  repo: Repository,
  ref: string,
  identity: Identity,
  signal?: AbortSignal,
  daemonToken?: string,
): Promise<string> {
  signal?.throwIfAborted();
  if (daemonToken !== undefined && !isId(daemonToken)) throw new Error("Invalid daemon token.");
  const checkedAt = new Date().toISOString();
  // Settle all independent reads before releasing the publication lock on error.
  const reads = await Promise.allSettled([
    resolveMain(repo.common, ref, signal),
    readRef(repo, ref),
    eventsIn(repo, undefined, signal),
  ] as const);
  for (const result of reads) if (result.status === "rejected") throw result.reason;
  const current = (reads[0] as PromiseFulfilledResult<string>).value;
  let cursor = (reads[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof readRef>>>).value;
  // A previous publisher may have stopped after writing the event but before
  // advancing the cursor. Complete that transaction before observing a newer
  // head, otherwise the old commits appear in two distinct notifications.
  const candidates: UpstreamEvent[] = [];
  const events = (reads[2] as PromiseFulfilledResult<Awaited<ReturnType<typeof eventsIn>>>).value;
  const trashNames = await readdir(join(repo.directory, "trash"));
  for (let offset = 0; offset < trashNames.length; offset += 4) {
    signal?.throwIfAborted();
    const batch = await Promise.allSettled(
      trashNames.slice(offset, offset + 4).map(async (name) => {
        const parsed = parseEventFilename(name);
        if (!parsed) return;
        const value = await readJson(join(repo.directory, "trash", name));
        return value === undefined ? undefined : validateEvent(value, parsed.id, parsed.posixPaths);
      }),
    );
    for (const [index, result] of batch.entries()) {
      if (index) signal?.throwIfAborted();
      if (result.status === "rejected") throw result.reason;
      if (result.value) events.push(result.value);
    }
    signal?.throwIfAborted();
  }
  for (const event of events) {
    if (event.kind !== "upstream" || event.ref !== ref) continue;
    if (!cursor) throw new Error(`Missing ref cursor with existing upstream events: ${ref}`);
    if (
      cursor.commit === event.previous &&
      event.id === hash(["upstream", ref, event.previous, event.commit, cursor.eventId ?? ""])
    )
      candidates.push(event);
  }
  if (candidates.length > 1) throw new Error(`Ambiguous pending upstream publications: ${ref}`);
  if (cursor && candidates.length === 1) {
    const pending = candidates[0];
    const sessions = (await sessionsIn(repo)).filter((session) => !session.closedAt && session.ref === ref);
    for (const session of sessions)
      if (!session.baseline) await registerSession({ ...repo, root: session.root }, session, ref, cursor.commit);
    const restored = await publishUpstream(
      repo,
      identity,
      ref,
      cursor.commit,
      pending.commit,
      sessions.map((session) => session.key),
      cursor.eventId,
    );
    signal?.throwIfAborted();
    cursor = { ref, commit: pending.commit, eventId: restored.id };
    await writeJson(
      join(repo.directory, "refs", `${hash(ref)}.json`),
      cursor,
      signal ? () => signal.throwIfAborted() : undefined,
    );
  }
  let eventId = cursor?.eventId;
  if (cursor && cursor.commit !== current) {
    const sessions = (await sessionsIn(repo)).filter((session) => !session.closedAt && session.ref === ref);
    // Legacy send-first sessions migrate only history preceding their ordinary upstream subscription.
    for (const session of sessions) {
      if (!session.baseline) await registerSession({ ...repo, root: session.root }, session, ref, cursor.commit);
    }
    const event = await publishUpstream(
      repo,
      identity,
      ref,
      cursor.commit,
      current,
      sessions.map((session) => session.key),
      eventId,
    );
    eventId = event.id;
  }
  signal?.throwIfAborted();
  // Keep the chain head even after GC removes its event; it is an ID, not a file dependency.
  await writeJson(
    join(repo.directory, "refs", `${hash(ref)}.json`),
    { ref, commit: current, eventId, checkedAt, daemonToken },
    signal ? () => signal.throwIfAborted() : undefined,
  );
  return current;
}
