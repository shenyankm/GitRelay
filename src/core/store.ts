import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { git, gitPathLine } from "./git.ts";
import { watchRoot } from "./changes.ts";

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const stateDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export interface Repository {
  root: string;
  common: string;
  id: string;
  directory: string;
  identity: string;
  identitySource: "marker" | "external";
}

export function stateDirectory(): string {
  const override = process.env.WORKTREE_SYNC_STATE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("WORKTREE_SYNC_STATE_DIR must be an absolute path.");
    return override;
  }
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "worktree-agent-sync");
}

/** Check managed directory names without following a final symlink. */
export async function checkStateDirectory(path: string, optional = false): Promise<void> {
  const item = await lstat(path).catch((error) => {
    if (error.code === "ENOENT" && optional) return undefined;
    throw error;
  });
  if (item && !item.isDirectory())
    throw new Error(`Invalid GitRelay state directory: ${path}; preserve it for inspection.`);
}

/** The user-selected root and its ancestors may be symlinks; managed children may not. */
export async function checkManagedRoot(): Promise<void> {
  const root = stateDirectory();
  const results = await Promise.allSettled(
    ["repos", "identity-locks", "identity-choices", "identity-history", "identity-migration-claims"].map((name) =>
      checkStateDirectory(join(root, name), true),
    ),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

export async function checkRepositoryDirectories(directory: string, allowMissingTrash = false): Promise<void> {
  await checkStateDirectory(directory);
  const results = await Promise.allSettled(
    ["sessions", "events", "receipts", "refs", "trash"].map((name) =>
      checkStateDirectory(join(directory, name), allowMissingTrash && name === "trash"),
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

export async function repositoryIdentity(
  common: string,
  create: boolean,
): Promise<{ identity: string; identitySource: "marker" | "external" } | undefined> {
  const raw = process.env.WORKTREE_SYNC_REPOSITORY_IDS;
  if (raw) {
    let mapping: unknown;
    try {
      mapping = JSON.parse(raw);
    } catch {
      throw new Error(
        "WORKTREE_SYNC_REPOSITORY_IDS must be a JSON object mapping canonical Git common directories to 64-character IDs.",
      );
    }
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
      throw new Error("WORKTREE_SYNC_REPOSITORY_IDS must be a JSON object.");
    const value = (mapping as Record<string, unknown>)[common];
    if (value !== undefined) {
      if (!isId(value)) throw new Error(`Invalid external repository identity for ${common}.`);
      return { identity: value, identitySource: "external" };
    }
  }
  const marker = join(common, ".git-relay-id");
  async function readMarker(): Promise<string | undefined> {
    const info = await lstat(marker).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid GitRelay repository identity: ${marker}`);
    const file = await open(marker, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 65)
        throw new Error(`Invalid GitRelay repository identity: ${marker}`);
      const bytes = Buffer.alloc(66);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const text = bytes.subarray(0, bytesRead).toString("utf8");
      if (!/^[a-f0-9]{64}\n$/.test(text)) throw new Error(`Invalid GitRelay repository identity: ${marker}`);
      return text.slice(0, 64);
    } finally {
      await file.close();
    }
  }
  let identity = await readMarker();
  if (!identity && create) {
    const temporary = join(common, `.git-relay-id-${randomUUID()}.tmp`);
    let complete = false;
    try {
      await writeExclusiveTemporary(temporary, `${hash(randomUUID())}\n`);
      complete = true;
      try {
        await link(temporary, marker).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      } finally {
        await rm(temporary, { force: true });
      }
    } catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new Error(
          `Cannot create GitRelay identity in ${common}; configure WORKTREE_SYNC_REPOSITORY_IDS for this read-only repository.${complete ? "" : ` If present, the temporary path ${temporary} was preserved.`}`,
          { cause: error },
        );
      throw error;
    }
    identity = await readMarker();
    if (!identity) throw new Error(`GitRelay repository identity disappeared: ${marker}`);
  }
  return identity ? { identity, identitySource: "marker" } : undefined;
}

/** Identity initialization and legacy migration share this lock. */
export async function withRepositoryIdentity<T>(
  cwd: string,
  signal: AbortSignal | undefined,
  run: (repo: Repository) => Promise<T>,
  initialize = true,
): Promise<T> {
  await checkManagedRoot();
  const root = await watchRoot(cwd, signal);
  const common = await realpath(
    gitPathLine(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "paths")),
  );
  const locks = join(stateDirectory(), "identity-locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  return withLock(
    join(locks, `${hash(common)}.lock`),
    async () => {
      const identity = await repositoryIdentity(common, initialize);
      if (!identity)
        throw new Error(`GitRelay repository identity is missing in ${common}; restore it before retrying.`);
      const id = hash([common, identity.identity]);
      return run({ root, common, id, directory: join(stateDirectory(), "repos", id), ...identity });
    },
    { signal, waitMs: 5000 },
  );
}

export const repositoryMetadata = (repo: Repository) => ({
  id: repo.id,
  common: repo.common,
  identity: repo.identity,
  identitySource: repo.identitySource,
});

/** A claimed migration must finish before its destination can receive events. */
export async function assertMigrationReady(repo: Repository): Promise<void> {
  const claims = join(stateDirectory(), "identity-migration-claims"),
    source = hash(repo.common);
  const claim = (await readJson(join(claims, `${source}.json`))) as { common?: string; newId?: string } | undefined;
  if (claim === undefined) return;
  if (!claim || typeof claim !== "object" || Array.isArray(claim) || claim.common !== repo.common || !isId(claim.newId))
    throw new Error(`Invalid GitRelay migration claim: ${source}`);
  if (claim.newId !== repo.id) return;
  const published = (await readJson(join(claims, `${source}.publishing.json`))) as
    { common?: string; newId?: string } | undefined;
  const completed = (await readJson(join(claims, `${source}.completed.json`))) as
    { common?: string; newId?: string } | undefined;
  const provenance = (await readJson(join(repo.directory, "identity-migration.json"))) as
    { legacy?: string; id?: string } | undefined;
  if (
    published?.common !== repo.common ||
    published.newId !== repo.id ||
    completed?.common !== repo.common ||
    completed.newId !== repo.id ||
    provenance?.legacy !== source ||
    provenance.id !== repo.id
  )
    throw new Error(
      `GitRelay migration is incomplete for ${repo.common}; resume identity-migrate and preserve the prior state.`,
    );
}

/** Prior states are never silently associated with a replacement identity. */
export async function priorRepositories(repo: Repository): Promise<string[]> {
  const parent = join(stateDirectory(), "repos");
  const found: string[] = [];
  const history = join(stateDirectory(), "identity-history", hash(repo.common));
  await checkStateDirectory(history, true);
  const names = await readdir(history).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of new Set([hash(repo.common), ...names])) {
    if (!isId(name) || name === repo.id) continue;
    if (
      await lstat(join(parent, name)).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    )
      found.push(name);
  }
  return found;
}

export async function recordRepositoryIdentity(repo: Repository): Promise<void> {
  const history = join(stateDirectory(), "identity-history", hash(repo.common));
  await checkStateDirectory(history, true);
  await mkdir(history, { recursive: true, mode: 0o700 });
  await checkStateDirectory(history);
  const path = join(history, repo.id);
  try {
    await writeFile(path, repo.id, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Invalid GitRelay identity history: ${path}`);
  }
}

/** Move a verified empty incomplete initialization aside without deleting it. */
export async function recoverRepositoryInitialization(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ archived: string }> {
  await checkManagedRoot();
  const root = await watchRoot(cwd, signal);
  const common = await realpath(
    gitPathLine(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "paths")),
  );
  const identity = await repositoryIdentity(common, false);
  const directory = identity && join(stateDirectory(), "repos", hash([common, identity.identity]));
  const existing =
    directory &&
    (await lstat(directory).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }));
  if (!existing) throw new Error(`Nothing to recover for ${common}; restore its identity and state if needed.`);
  return withRepositoryIdentity(
    cwd,
    signal,
    async (repo) => {
      if (repo.directory !== directory)
        throw new Error(`GitRelay identity changed while preparing recovery: ${common}`);
      const info = await lstat(repo.directory).catch((error) => {
        if (error.code === "ENOENT") throw new Error(`Nothing to recover for ${repo.common}; state is missing.`);
        throw error;
      });
      if (!info.isDirectory()) throw new Error(`Invalid GitRelay state directory: ${repo.directory}`);
      const ready = (await readJson(join(repo.directory, "identity-ready.json"))) as { id?: string } | undefined;
      if (ready?.id === repo.id) throw new Error(`GitRelay state is already initialized: ${repo.directory}`);
      const owner = (await readJson(join(repo.directory, "identity-owner.json"))) as { id?: string } | undefined;
      const ownerInfo = await lstat(join(repo.directory, "identity-owner.json")).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const entries = await readdir(repo.directory);
      if (!ownerInfo || owner?.id !== repo.id || !ownerInfo.isFile() || ownerInfo.isSymbolicLink())
        throw new Error(
          `Cannot establish ownership of incomplete state: ${repo.directory}; inspect and preserve it manually.`,
        );
      const allowed = new Set(["identity-owner.json", "sessions", "events", "receipts", "refs", "trash"]);
      for (const name of entries) {
        if (
          /^identity-ready\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name)
        ) {
          if (!(await lstat(join(repo.directory, name))).isFile())
            throw new Error(`Incomplete state contains data: ${repo.directory}; inspect and preserve it manually.`);
          continue;
        }
        if (!allowed.has(name))
          throw new Error(`Incomplete state contains data: ${repo.directory}; inspect and preserve it manually.`);
        if (name === "identity-owner.json") continue;
        const path = join(repo.directory, name),
          item = await lstat(path);
        if (!item.isDirectory() || (await readdir(path)).length)
          throw new Error(`Incomplete state contains data: ${repo.directory}; inspect and preserve it manually.`);
      }
      const archive = join(stateDirectory(), "repos", `.git-relay-recovery-${randomUUID()}`);
      await mkdir(archive, { mode: 0o700 });
      const archived = join(archive, repo.id);
      await rename(repo.directory, archived);
      return { archived };
    },
    false,
  );
}

/** Explicitly start a separate inbox while retaining every prior state directory. */
export async function chooseFreshRepository(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ id: string; prior: string[] }> {
  return withRepositoryIdentity(cwd, signal, async (repo) => {
    await assertMigrationReady(repo);
    const existing = await lstat(repo.directory).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing)
      throw new Error(`GitRelay state already exists: ${repo.directory}; inspect it before choosing fresh state.`);
    const prior = await priorRepositories(repo);
    const choices = join(stateDirectory(), "identity-choices"),
      path = join(choices, `${repo.id}.json`);
    await mkdir(choices, { recursive: true, mode: 0o700 });
    const previous = (await readJson(path)) as { id?: string } | undefined;
    if (previous !== undefined && previous.id !== repo.id) throw new Error(`Invalid GitRelay identity choice: ${path}`);
    if (!previous) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeExclusiveTemporary(temporary, JSON.stringify({ id: repo.id }));
      try {
        await link(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { id: repo.id, prior };
  });
}

export async function repository(cwd: string, signal?: AbortSignal, initialize = true): Promise<Repository> {
  return withRepositoryIdentity(
    cwd,
    signal,
    async (repo) => {
      await assertMigrationReady(repo);
      const existing = await lstat(repo.directory).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) {
        if (!existing.isDirectory()) throw new Error(`Invalid GitRelay state directory: ${repo.directory}`);
        const ready = (await readJson(join(repo.directory, "identity-ready.json"))) as { id?: string } | undefined;
        const owner = (await readJson(join(repo.directory, "identity-owner.json"))) as { id?: string } | undefined;
        if (ready?.id !== repo.id || owner?.id !== repo.id)
          throw new Error(
            `Incomplete GitRelay state initialization: ${repo.directory}; inspect and preserve it before recovery.`,
          );
        await checkRepositoryDirectories(repo.directory);
      } else {
        if (!initialize)
          throw new Error(`GitRelay repository state is missing: ${repo.directory}; preserve it for inspection.`);
        const prior = await priorRepositories(repo);
        const choice = (await readJson(join(stateDirectory(), "identity-choices", `${repo.id}.json`))) as
          { id?: string } | undefined;
        if (prior.length && choice?.id !== repo.id)
          throw new Error(
            `Earlier GitRelay state exists for ${repo.common}; run git-relay identity-fresh --apply${prior.includes(hash(repo.common)) ? " or identity-migrate --apply" : ""} after inspecting it. Prior state is preserved.`,
          );
        await recordRepositoryIdentity(repo);
        await mkdir(join(stateDirectory(), "repos"), { recursive: true, mode: 0o700 });
        const temporary = join(stateDirectory(), "repos", `.git-relay-owner-${randomUUID()}.tmp`);
        await writeExclusiveTemporary(temporary, JSON.stringify({ id: repo.id }));
        try {
          await mkdir(repo.directory, { mode: 0o700 });
          try {
            await link(temporary, join(repo.directory, "identity-owner.json"));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (
              code === "EPERM" ||
              code === "EACCES" ||
              code === "EOPNOTSUPP" ||
              code === "ENOTSUP" ||
              code === "EXDEV"
            ) {
              throw Object.assign(
                new Error(
                  `Cannot publish GitRelay state ownership using a hard link; inspect and preserve the incomplete directory: ${repo.directory}`,
                  { cause: error },
                ),
                { code },
              );
            }
            throw error;
          }
        } finally {
          await rm(temporary, { force: true });
        }
        for (const name of ["sessions", "events", "receipts", "refs", "trash"])
          await mkdir(join(repo.directory, name), { mode: 0o700 });
        await writeJson(join(repo.directory, "identity-ready.json"), { id: repo.id });
      }
      return repo;
    },
    initialize,
  );
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
export const GC_LOCK_TOKEN = "git-relay-gc-v1";

export async function withLock<T>(
  path: string,
  run: () => Promise<T>,
  options: { token?: string; busyToken?: string; signal?: AbortSignal; waitMs?: number; onAcquired?: () => void } = {},
): Promise<T> {
  const deadline = performance.now() + (options.waitMs ?? 0);
  let lock;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      lock = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path).catch((failure) => {
        if (failure.code === "ENOENT") return undefined;
        throw failure;
      });
      if (info && !info.isFile()) throw new Error(`Invalid git-relay lock (not a regular file): ${path}`);
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
          throw new Error(`Cannot read git-relay lock owner: ${path}. Retry later; do not remove a live lock.`);
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
            throw new Error(
              `Stale git-relay lock: ${path}. Recheck the current owner before manual recovery; never remove a live lock.`,
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
            throw new BusyError(`Worktree-sync is busy: ${path}`);
          }
        }
      }
      options.signal?.throwIfAborted();
      // Age alone says nothing about a long-running daemon's health.
      if (options.waitMs && performance.now() >= deadline) {
        throw new Error(
          `Worktree-sync lock remains busy: ${path} (PID ${owner?.pid ?? "unknown"}). Retry later; do not remove a live lock.`,
        );
      }
      if (!options.waitMs) throw new BusyError(`Worktree-sync is busy: ${path}`);
      await delay(Math.min(10 + Math.random() * 30, Math.max(1, deadline - performance.now())), undefined, {
        signal: options.signal,
      });
    }
  }
  try {
    options.onAcquired?.();
    options.signal?.throwIfAborted();
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: options.token }));
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
