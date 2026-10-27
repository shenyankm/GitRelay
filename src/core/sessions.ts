import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { watchRoot } from "./changes.ts";
import {
  readSession,
  registerSession,
  sessionKey,
  validateIdentity,
  validateSession,
  type Identity,
  type Session,
} from "./mailbox.ts";
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
  withRepositoryIdentity,
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

async function leavingRepository(options: LeaveOptions, protectPrior = false): Promise<Repository> {
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
      if (protectPrior && (await hasPriorSubscription(options, await watchRoot(options.cwd, options.signal))))
        throw new Error(
          "Another GitRelay subscription exists at this worktree path; restore its repository and retry.",
        );
      return await repository(options.cwd, options.signal, !protectPrior);
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
export async function leaveSession(
  options: LeaveOptions,
  protectPrior = false,
  expectedRepositoryId?: string,
  expectedRoot?: string,
): Promise<Session | undefined> {
  const identity = snapshotIdentity(options);
  const repositoryId = options.repositoryId;
  if (repositoryId !== undefined && !isId(repositoryId)) throw new Error("Invalid repository state ID.");
  const cwd = options.cwd;
  resolve(cwd); // Keep path validation ahead of later option getters.
  const signal = options.signal;
  const ref = options.ref;
  options = { ...identity, repositoryId, cwd, signal, ref };
  const repo = await leavingRepository(options, protectPrior);
  if (expectedRepositoryId && repo.id !== expectedRepositoryId)
    throw new Error("GitRelay repository identity changed during opt-out; preserve the subscription and retry.");
  if (expectedRoot && relative(expectedRoot, repo.root) !== "")
    throw new Error("Git worktree root changed during opt-out; preserve the subscription and retry.");
  if (protectPrior && (await hasPriorSubscription(options, repo.root)))
    throw new Error("Another GitRelay subscription exists at this worktree path; restore its repository and retry.");
  let key = sessionKey(repo, options, options.ref);
  if (protectPrior) {
    const physical = await realpath(repo.root).catch((error) => {
      if (error.code === "ENOENT") return resolve(repo.root);
      throw error;
    });
    const roots = new Set([repo.root, resolve(repo.root), physical]);
    if (process.platform === "win32") for (const root of [...roots]) roots.add(root.replace(/\\/g, "/"));
    const matches: string[] = [];
    for (const root of roots) {
      const candidate = sessionKey({ root }, options, options.ref);
      const session = await readSession(repo, candidate);
      if (session && !session.closedAt) matches.push(candidate);
    }
    if (matches.length > 1)
      throw new Error("Multiple GitRelay subscriptions match this worktree; preserve them for inspection.");
    if (matches.length === 1) key = matches[0];
  }
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
          await writeJson(
            join(repo.directory, "sessions", `${key}.json`),
            closed,
            options.signal ? () => options.signal?.throwIfAborted() : undefined,
          );
          return closed;
        },
        { signal: options.signal, waitMs: 5000, busyToken: GC_LOCK_TOKEN },
      ),
    { signal: options.signal },
  );
}

async function hasPriorSubscription(
  options: LeaveOptions,
  currentRoot?: string,
  onlyRoot = false,
  repositoryId?: string,
): Promise<boolean> {
  await checkManagedRoot();
  const keys = new Map<string, string>();
  const physical = await realpath(options.cwd).catch((error) => {
    if (error.code === "ENOENT") return resolve(options.cwd);
    throw error;
  });
  for (const start of [resolve(options.cwd), physical, ...(currentRoot ? [currentRoot] : [])]) {
    for (let root = start; ; root = dirname(root)) {
      const child = currentRoot ? relative(currentRoot, root) : "";
      if (!currentRoot || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)))
        keys.set(sessionKey({ root }, options, options.ref), root);
      if (dirname(root) === root) break;
    }
  }
  const repos = join(stateDirectory(), "repos");
  for (const id of await readdir(repos).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    options.signal?.throwIfAborted();
    if (!isId(id) || (repositoryId && id !== repositoryId)) continue;
    const directory = join(repos, id),
      sessions = join(directory, "sessions");
    await checkStateDirectory(directory);
    await checkStateDirectory(sessions, true);
    for (const [key, root] of keys) {
      const sameRoot = currentRoot !== undefined && relative(currentRoot, root) === "";
      if (currentRoot && (onlyRoot ? !sameRoot : sameRoot)) continue;
      const value = await readJson(join(sessions, `${key}.json`), true);
      options.signal?.throwIfAborted();
      if (value !== undefined && !validateSession(value, key).closedAt) return true;
    }
  }
  options.signal?.throwIfAborted();
  return false;
}

/** Inspect existing subscriptions before changing activation or repository state. */
export async function preflightLeaveSession(options: LeaveOptions): Promise<{ root?: string; repositoryId?: string }> {
  if (options.repositoryId !== undefined) {
    const repo = await leavingRepository(options);
    return { repositoryId: repo.id };
  }
  let root: string;
  try {
    root = await watchRoot(options.cwd, options.signal);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(await unavailableWorktree(options.cwd)) && (await hasPriorSubscription(options))) throw error;
    return {};
  }
  if (await hasPriorSubscription(options, root))
    throw new Error("Another GitRelay subscription exists at this worktree path; restore its repository and retry.");
  if (!(await hasPriorSubscription(options, root, true))) return { root };
  const repo = await withRepositoryIdentity(options.cwd, options.signal, async (value) => value, false);
  if (!(await hasPriorSubscription(options, root, true, repo.id)))
    throw new Error(
      "A GitRelay subscription exists under a different repository identity; preserve it for inspection.",
    );
  return { root, repositoryId: repo.id };
}

/** Native opt-out remains a no-op outside a repository without prior state. */
export async function leaveSessionIfRepository(
  options: LeaveOptions,
  preflight?: { root?: string; repositoryId?: string },
): Promise<Session | undefined> {
  try {
    const checked = preflight ?? (await preflightLeaveSession(options));
    if (checked.root && !checked.repositoryId) {
      if (preflight) {
        const current = await preflightLeaveSession(options);
        if (!current.root || relative(checked.root, current.root) !== "" || current.repositoryId)
          throw new Error("GitRelay subscription changed during opt-out; preserve it and retry.");
      }
      return;
    }
    if (preflight && !checked.root) {
      const current = await watchRoot(options.cwd, options.signal).catch(() => undefined);
      options.signal?.throwIfAborted();
      if (current) throw new Error("Git worktree root changed during opt-out; preserve the subscription and retry.");
    }
    return await leaveSession(options, true, checked.repositoryId, checked.root);
  } catch (error) {
    options.signal?.throwIfAborted();
    const failure = (error as Error)?.cause as
      { code?: unknown; signal?: NodeJS.Signals | null; killed?: boolean } | undefined;
    if (failure?.code !== 128 || failure.signal || failure.killed) throw error;
    try {
      await promisify(execFile)("git", ["-C", options.cwd, "rev-parse", "--show-toplevel"], {
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
        signal: options.signal,
        timeout: 30_000,
      });
    } catch (probe) {
      options.signal?.throwIfAborted();
      const result = probe as Error & {
        code?: unknown;
        signal?: NodeJS.Signals | null;
        killed?: boolean;
        stderr?: string;
      };
      if (
        result.code === 128 &&
        !result.signal &&
        !result.killed &&
        /^(?:fatal: not a git repository \(or any of the parent directories\): \.git|fatal: not a git repository \(or any parent up to mount point [^\r\n]*\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.)\r?\n?$/.test(
          result.stderr ?? "",
        ) &&
        !(await hasPriorSubscription(options))
      )
        return;
    }
    throw error;
  }
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
