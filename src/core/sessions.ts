import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { readSession, registerSession, sessionKey, validateIdentity, type Identity, type Session } from "./mailbox.ts";
import { synchronizeRef } from "./publisher.ts";
import {
  assertMigrationReady,
  GC_LOCK_TOKEN,
  checkManagedRoot,
  checkRepositoryDirectories,
  checkStateDirectory,
  hash,
  isId,
  readJson,
  repository,
  repositoryMetadata,
  stateDirectory,
  withLock,
  writeJson,
  type Repository,
} from "./store.ts";

interface SessionOptions extends Identity {
  cwd: string;
  ref: string;
  signal?: AbortSignal;
}

interface LeaveOptions extends SessionOptions {
  repositoryId?: string;
}

async function unavailableWorktree(path: string): Promise<boolean> {
  const exists = await stat(path).catch((failure) => {
    if (failure.code === "ENOENT") return undefined;
    throw failure;
  });
  if (exists) return false;
  const entry = await lstat(path).catch((failure) => {
    if (failure.code === "ENOENT") return undefined;
    throw failure;
  });
  if (entry) throw new Error(`Worktree path exists but cannot be resolved; inspect it before leaving: ${path}`);
  // A dangling ancestor also makes stat and lstat of a missing child report ENOENT.
  for (let ancestor = dirname(path); ;) {
    const named = await lstat(ancestor).catch((failure) => {
      if (failure.code === "ENOENT") return undefined;
      throw failure;
    });
    if (named) {
      if (named.isSymbolicLink()) {
        const target = await stat(ancestor).catch((failure) => {
          if (failure.code === "ENOENT") return undefined;
          throw failure;
        });
        if (!target) throw new Error(`Worktree ancestor is a dangling link; inspect it before leaving: ${ancestor}`);
      }
      return true;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot inspect worktree path ancestry: ${ancestor}`);
    ancestor = parent;
  }
}

async function leavingRepository(options: LeaveOptions): Promise<Repository> {
  if (options.repositoryId !== undefined && !isId(options.repositoryId))
    throw new Error("Invalid repository state ID.");
  const root = resolve(options.cwd);
  const rootLength = parse(options.cwd).root.length;
  const raw =
    options.cwd.length > rootLength
      ? options.cwd.replace(process.platform === "win32" ? /[\\/]+$/ : /\/+$/, "")
      : options.cwd;
  let error: unknown = new Error("Worktree is unavailable.");
  if (options.repositoryId === undefined) {
    try {
      return await repository(options.cwd, options.signal);
    } catch (cause) {
      error = cause;
    }
  }
  options.signal?.throwIfAborted();
  // Only a missing worktree permits lookup by its persisted absolute root.
  if (!(await unavailableWorktree(raw)) || (raw !== root && !(await unavailableWorktree(root)))) {
    if (options.repositoryId !== undefined)
      throw new Error("--repository-id is only for a missing worktree; use the normal leave operation.");
    throw error;
  }
  await checkManagedRoot();
  const key = sessionKey({ root }, options, options.ref);
  const repos = join(stateDirectory(), "repos");
  const matches: Repository[] = [];
  for (const id of await readdir(repos).catch((failure) => {
    if (failure.code === "ENOENT") return [];
    throw failure;
  })) {
    options.signal?.throwIfAborted();
    if (!isId(id) || (options.repositoryId !== undefined && id !== options.repositoryId)) continue;
    const directory = join(repos, id);
    const sessions = await stat(join(directory, "sessions")).catch((failure) => {
      if (failure.code === "ENOENT" || failure.code === "ENOTDIR") return undefined;
      throw failure;
    });
    if (!sessions?.isDirectory()) continue;
    await checkStateDirectory(directory);
    await checkStateDirectory(join(directory, "sessions"));
    if ((await readJson(join(directory, "sessions", `${key}.json`))) === undefined) continue;
    await checkRepositoryDirectories(directory);
    const metadata = (await readJson(join(directory, "repo.json"))) as Partial<Repository> | undefined;
    if (
      !metadata ||
      metadata.id !== id ||
      typeof metadata.common !== "string" ||
      !isId(metadata.identity) ||
      !["marker", "external"].includes(metadata.identitySource ?? "") ||
      hash([metadata.common, metadata.identity]) !== id
    )
      throw new Error(`Invalid repository metadata: ${directory}`);
    const repo: Repository = {
      root,
      id,
      directory,
      common: metadata.common,
      identity: metadata.identity,
      identitySource: metadata.identitySource!,
    };
    const session = await readSession(repo, key);
    if (
      session &&
      (session.root !== root ||
        session.ref !== options.ref ||
        session.adapter !== options.adapter ||
        session.session !== options.session)
    )
      throw new Error(`Invalid session: ${key}`);
    if (session) {
      const ready = (await readJson(join(directory, "identity-ready.json"))) as { id?: string } | undefined;
      const owner = (await readJson(join(directory, "identity-owner.json"))) as { id?: string } | undefined;
      if (ready?.id !== id || owner?.id !== id)
        throw new Error(`Incomplete GitRelay state initialization: ${directory}; prior state was preserved.`);
      await assertMigrationReady(repo);
      matches.push(repo);
    }
  }
  if (matches.length !== 1)
    throw new Error("Cannot uniquely locate the removed worktree subscription; use its original absolute --cwd path.", {
      cause: error,
    });
  return matches[0];
}

function snapshotIdentity(options: Identity): Identity {
  const adapter = options.adapter;
  validateIdentity({ adapter, session: "snapshot" });
  const identity = { adapter, session: options.session, instance: options.instance };
  validateIdentity(identity);
  return identity;
}

/** Explicit opt-out; do not acknowledge or delete unread messages. */
export async function leaveSession(options: LeaveOptions): Promise<Session | undefined> {
  const identity = snapshotIdentity(options);
  const repositoryId = options.repositoryId;
  if (repositoryId !== undefined && !isId(repositoryId)) throw new Error("Invalid repository state ID.");
  const cwd = options.cwd;
  resolve(cwd); // Keep path validation ahead of later option getters.
  const signal = options.signal;
  const ref = options.ref;
  options = { ...identity, repositoryId, cwd, signal, ref };
  const repo = await leavingRepository(options);
  const key = sessionKey(repo, options, options.ref);
  return withLock(
    join(repo.directory, "sessions", `${key}.lock`),
    () =>
      withLock(
        join(repo.directory, "publish.lock"),
        async () => {
          const session = await readSession(repo, key);
          if (!session || session.closedAt) return session;
          const now = new Date().toISOString();
          const closed = { ...session, closedAt: now, lastSeen: now };
          await writeJson(join(repo.directory, "sessions", `${key}.json`), closed);
          return closed;
        },
        { signal: options.signal, waitMs: 5000, busyToken: GC_LOCK_TOKEN },
      ),
    { signal: options.signal },
  );
}

/** Explicit rejoin keeps old inbox/receipts, but does not replay publications while closed. */
export async function joinSession(options: SessionOptions): Promise<Session> {
  const identity = snapshotIdentity(options);
  const cwd = options.cwd;
  const signal = options.signal;
  const ref = options.ref;
  options = { ...identity, cwd, signal, ref };
  const repo = await repository(options.cwd, options.signal);
  const key = sessionKey(repo, options, options.ref);
  return withLock(
    join(repo.directory, "sessions", `${key}.lock`),
    () =>
      withLock(
        join(repo.directory, "publish.lock"),
        async () => {
          const current = await synchronizeRef(repo, options.ref, options, options.signal);
          await writeJson(join(repo.directory, "repo.json"), repositoryMetadata(repo));
          const registered = await registerSession(
            repo,
            options,
            options.ref,
            current,
            process.platform === "win32" ? false : undefined,
          );
          const open = { ...registered, closedAt: undefined };
          await writeJson(join(repo.directory, "sessions", `${key}.json`), open);
          return open;
        },
        { signal: options.signal, waitMs: 5000, busyToken: GC_LOCK_TOKEN },
      ),
    { signal: options.signal },
  );
}
