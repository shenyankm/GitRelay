import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const stateDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export function stateDirectory(): string {
  const override = process.env.GITBEACON_STATE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("GITBEACON_STATE_DIR must be an absolute path.");
    return override;
  }
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "gitbeacon");
}

/** Check managed directory names without following a final symlink. */
export async function checkStateDirectory(path: string, optional = false): Promise<void> {
  const item = await lstat(path).catch((error) => {
    if (error.code === "ENOENT" && optional) return undefined;
    throw error;
  });
  if (item && !item.isDirectory())
    throw new Error(`Invalid gitbeacon state directory: ${path}; preserve it for inspection.`);
}

/** The user-selected root and its ancestors may be symlinks; managed children may not. */
export async function checkManagedRoot(): Promise<void> {
  const root = stateDirectory();
  const results = await Promise.allSettled(
    ["repos", "identity-locks", "identity-choices", "identity-history"].map((name) =>
      checkStateDirectory(join(root, name), true),
    ),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

/** A failed exclusive write may have left bytes behind; never delete them blindly. */
export async function writeExclusiveTemporary(path: string, data: string | Buffer): Promise<void> {
  try {
    await writeFile(path, data, { mode: 0o600, flag: "wx" });
  } catch (cause) {
    throw Object.assign(
      new Error(`Temporary file creation failed; any file at this path was preserved: ${path}`, { cause }),
      { code: (cause as NodeJS.ErrnoException | undefined)?.code },
    );
  }
}

export async function readJson(path: string, noFollow = false): Promise<unknown | undefined> {
  const noFollowFlag = noFollow ? (constants.O_NOFOLLOW ?? 0) : 0;
  const named =
    noFollow && !noFollowFlag
      ? await lstat(path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      : undefined;
  if (noFollow && !noFollowFlag && !named) return undefined;
  if (named && !named.isFile()) throw new Error(`State path is not a regular file: ${path}`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag);
      break;
    } catch (error) {
      if (noFollow && (error as NodeJS.ErrnoException).code === "ELOOP")
        throw new Error(`State path is not a regular file: ${path}`, { cause: error });
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await lstat(path);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw failure;
      }
      if (attempt === 1) throw new Error(`State path exists but cannot be read: ${path}`, { cause: error });
    }
  }
  if (!file) throw new Error(`State path exists but cannot be read: ${path}`);
  try {
    const info = await file.stat();
    if (!info.isFile() || (named && (named.dev !== info.dev || named.ino !== info.ino)))
      throw new Error(`State path is not a regular file or changed during inspection: ${path}`);
    if (info.size > MAX_STATE_BYTES) throw new Error(`State file exceeds 2 MiB: ${path}`);
    // Leave room to probe EOF in the same buffer; grow only if the file changes.
    let buffer = Buffer.allocUnsafe(Math.max(256, info.size + 1));
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_STATE_BYTES) throw new Error(`State file exceeds 2 MiB: ${path}`);
      if (size === buffer.length) {
        const next = Buffer.allocUnsafe(Math.min(MAX_STATE_BYTES + 1, buffer.length * 2));
        buffer.copy(next);
        buffer = next;
      }
    }
    let text: string;
    try {
      text = stateDecoder.decode(buffer.subarray(0, size));
    } catch (error) {
      throw new Error(`Invalid UTF-8 in state file: ${path}`, { cause: error });
    }
    return JSON.parse(text);
  } finally {
    await file.close();
  }
}

export async function writeJson(path: string, value: unknown, beforeCommit?: () => void): Promise<void> {
  const contents = JSON.stringify(value);
  if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new Error(`State file exceeds 2 MiB: ${path}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let witness: Stats | undefined;
  let created = false,
    complete = false,
    closed = false;
  try {
    file = await open(temporary, "wx", 0o600);
    created = true;
    witness = await file.stat();
    await file.writeFile(contents);
    complete = true;
    await file.close();
    closed = true;
    file = undefined;
    const current = await lstat(temporary);
    if (!current.isFile() || current.dev !== witness.dev || current.ino !== witness.ino)
      throw new Error(`Temporary state file changed; preserved: ${temporary}`);
    if (beforeCommit) {
      beforeCommit();
      renameSync(temporary, path);
    } else await rename(temporary, path);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    if (created && !witness)
      throw new Error(`Temporary state file identity could not be verified; preserved: ${temporary}`, { cause: error });
    if (witness && !complete)
      throw new Error(`Temporary state file may be incomplete; preserved: ${temporary}`, { cause: error });
    if (complete && closed && witness) {
      try {
        const current = await lstat(temporary).catch((failure) => {
          if (failure.code === "ENOENT") return undefined;
          throw failure;
        });
        if (current) {
          if (
            !current.isFile() ||
            current.dev !== witness.dev ||
            current.ino !== witness.ino ||
            (await readFile(temporary, "utf8")) !== contents
          )
            throw new Error("Temporary file identity or contents changed");
          const latest = await lstat(temporary);
          if (
            latest.dev !== current.dev ||
            latest.ino !== current.ino ||
            latest.size !== current.size ||
            latest.mtimeMs !== current.mtimeMs ||
            latest.ctimeMs !== current.ctimeMs
          )
            throw new Error("Temporary file changed during inspection");
          await rm(temporary);
        }
      } catch (failure) {
        throw new Error(`Temporary state file could not be safely removed; preserved: ${temporary}`, {
          cause: failure,
        });
      }
    }
    if (complete && !closed)
      throw new Error(`Temporary state file could not be closed; preserved: ${temporary}`, { cause: error });
    throw error;
  }
}

export class BusyError extends Error {}
export const GC_LOCK_TOKEN = "gitbeacon-gc-v1";

async function openOwnedLock(path: string, token?: string) {
  const temporary = `${path}.${randomUUID()}.owner`;
  await writeExclusiveTemporary(temporary, JSON.stringify({ pid: process.pid, token }));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    handle = await open(temporary, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    await link(temporary, path);
    published = true;
    return handle;
  } catch (error) {
    await handle?.close();
    throw error;
  } finally {
    try {
      await rm(temporary);
    } catch (error) {
      if (published && handle) {
        try {
          const held = await handle.stat();
          const current = await lstat(path).catch(() => undefined);
          if (current?.dev === held.dev && current.ino === held.ino) await rm(path);
        } finally {
          await handle.close();
        }
      }
      throw error;
    }
  }
}

// Unique bakery tickets serialize recovery without an unrecoverable second lock or compare/unlink race.
async function recoverDeadLock(path: string, signal?: AbortSignal, waitMs = 1000): Promise<void> {
  const directory = `${path}.recovery`;
  await checkStateDirectory(directory, true);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = hash(randomUUID());
  const own = join(directory, `${id}.json`);
  const deadline = performance.now() + Math.max(1000, waitMs);
  const tickets = async () => {
    const entries = [];
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const location = join(directory, name);
      const entry = (await readJson(location, true)) as { pid?: number; ticket?: number | null } | undefined;
      if (!entry) continue;
      if (
        !Number.isInteger(entry.pid) ||
        entry.pid! <= 0 ||
        (entry.ticket !== null && (!Number.isSafeInteger(entry.ticket) || entry.ticket! < 1))
      )
        throw new Error(`Invalid lock recovery ticket: ${location}; preserve state.`);
      try {
        process.kill(entry.pid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await rm(location, { force: true });
          continue;
        }
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      entries.push({ id: name.slice(0, -5), ticket: entry.ticket });
    }
    return entries;
  };
  try {
    await writeJson(own, { pid: process.pid, ticket: null }, () => signal?.throwIfAborted());
    const ticket = 1 + Math.max(0, ...(await tickets()).map((entry) => entry.ticket ?? 0));
    if (!Number.isSafeInteger(ticket)) throw new Error("Lock recovery ticket overflow; preserve state.");
    await writeJson(own, { pid: process.pid, ticket }, () => signal?.throwIfAborted());
    for (;;) {
      signal?.throwIfAborted();
      const waiting = (await tickets()).some(
        (entry) =>
          entry.id !== id &&
          (entry.ticket === null || entry.ticket! < ticket || (entry.ticket === ticket && entry.id < id)),
      );
      if (!waiting) break;
      if (performance.now() >= deadline) throw new BusyError(`gitbeacon lock recovery is busy: ${path}`);
      await delay(10, undefined, { signal });
    }
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      throw error;
    });
    if (!info) return;
    if (!info.isFile()) throw new Error(`Invalid gitbeacon lock (not a regular file): ${path}`);
    const owner = (await readJson(path, true)) as { pid?: number } | undefined;
    if (!Number.isInteger(owner?.pid) || owner!.pid! <= 0)
      throw new Error(`Cannot verify lock owner: ${path}; preserve state.`);
    try {
      process.kill(owner!.pid!, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      const latest = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === "ENOENT") return;
        throw failure;
      });
      signal?.throwIfAborted();
      if (
        latest &&
        latest.dev === info.dev &&
        latest.ino === info.ino &&
        latest.size === info.size &&
        latest.mtimeMs === info.mtimeMs &&
        latest.ctimeMs === info.ctimeMs
      )
        await rm(path);
    }
  } finally {
    await rm(own, { force: true });
  }
}

export async function withLock<T>(
  path: string,
  run: () => Promise<T>,
  options: {
    token?: string;
    busyToken?: string;
    signal?: AbortSignal;
    waitMs?: number;
    onAcquired?: () => void;
    recoverDeadOwner?: boolean;
  } = {},
): Promise<T> {
  const deadline = performance.now() + (options.waitMs ?? 0);
  let lock;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      lock = options.recoverDeadOwner ? await openOwnedLock(path, options.token) : await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path).catch((failure) => {
        if (failure.code === "ENOENT") return undefined;
        throw failure;
      });
      if (info && !info.isFile()) throw new Error(`Invalid gitbeacon lock (not a regular file): ${path}`);
      const owner = info
        ? ((await readJson(path).catch(() => undefined)) as { pid?: number; token?: string } | undefined)
        : undefined;
      options.signal?.throwIfAborted();
      if (!info) continue;
      if (!options.waitMs && (!owner || !Number.isInteger(owner.pid) || owner.pid! <= 0)) {
        await delay(50, undefined, { signal: options.signal });
        const latest = await lstat(path).catch((failure) => {
          if (failure.code === "ENOENT") return undefined;
          throw failure;
        });
        options.signal?.throwIfAborted();
        if (
          latest &&
          latest.dev === info.dev &&
          latest.ino === info.ino &&
          latest.size === info.size &&
          latest.mtimeMs === info.mtimeMs &&
          latest.ctimeMs === info.ctimeMs
        )
          throw new Error(`Cannot read gitbeacon lock owner: ${path}. Retry later; do not remove a live lock.`);
        continue;
      }
      if (owner && Number.isInteger(owner.pid) && owner.pid! > 0) {
        let alive = false;
        try {
          process.kill(owner.pid!, 0);
          alive = true;
        } catch (failure) {
          const latest = await lstat(path).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          options.signal?.throwIfAborted();
          if (
            (failure as NodeJS.ErrnoException).code === "ESRCH" &&
            latest &&
            info &&
            latest.dev === info.dev &&
            latest.ino === info.ino &&
            latest.mtimeMs === info.mtimeMs
          ) {
            if (options.recoverDeadOwner) {
              await recoverDeadLock(path, options.signal, options.waitMs);
              continue;
            }
            throw new Error(
              `Stale gitbeacon lock: ${path}. Recheck the current owner before manual recovery; never remove a live lock.`,
            );
          }
        }
        // Age only limits silent GC skips; it never authorizes lock removal.
        const age = info ? Date.now() - info.mtimeMs : Infinity;
        if (alive && options.busyToken && owner.token === options.busyToken && age >= 0 && age < 60_000) {
          const latest = await lstat(path).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          options.signal?.throwIfAborted();
          if (latest && info && latest.dev === info.dev && latest.ino === info.ino && latest.mtimeMs === info.mtimeMs) {
            throw new BusyError(`gitbeacon is busy: ${path}`);
          }
        }
      }
      options.signal?.throwIfAborted();
      // Age alone says nothing about a long-running daemon's health.
      if (options.waitMs && performance.now() >= deadline) {
        throw new Error(
          `gitbeacon lock remains busy: ${path} (PID ${owner?.pid ?? "unknown"}). Retry later; do not remove a live lock.`,
        );
      }
      if (!options.waitMs) throw new BusyError(`gitbeacon is busy: ${path}`);
      await delay(Math.min(10 + Math.random() * 30, Math.max(1, deadline - performance.now())), undefined, {
        signal: options.signal,
      });
    }
  }
  try {
    options.onAcquired?.();
    options.signal?.throwIfAborted();
    if (!options.recoverDeadOwner) await lock.writeFile(JSON.stringify({ pid: process.pid, token: options.token }));
    options.signal?.throwIfAborted();
    return await run();
  } finally {
    try {
      const held = await lock.stat();
      const current = await lstat(path).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (current?.dev === held.dev && current.ino === held.ino) await rm(path, { force: true });
    } finally {
      await lock.close();
    }
  }
}
