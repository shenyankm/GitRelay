import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sessionKey, validateSession, type Identity } from "./mailbox.ts";
import { checkStateDirectory, isId, readJson, stateDirectory, withLock, writeJson } from "./store.ts";
import { repository } from "./repository.ts";
import { watchRoot } from "./changes.ts";
import { GitPathOutputError } from "./git.ts";
import { preflightLeaveSession } from "./sessions.ts";

type ActivationOptions = Identity & {
  cwd: string;
  ref: string;
  signal?: AbortSignal;
  defaultEnabled?: boolean;
  onRoot?(root: string): void;
};
type Prepared = { token: string; repositoryId: string; subscriptionKey?: string };

/** Persist explicit choices; native adapters may participate by default. */
export async function sessionActivation(
  options: ActivationOptions,
  enabled?: boolean,
  checked?: Awaited<ReturnType<typeof preflightLeaveSession>>,
  operation?: {
    token: string;
    phase: "begin" | "prepare" | "failure";
    priorEnabled?: boolean;
    repositoryId?: string;
    subscriptionKey?: string;
    run?: () => Promise<void>;
  },
): Promise<boolean> {
  options.signal?.throwIfAborted();
  const optOut = enabled === false ? (checked ?? (await preflightLeaveSession(options))) : undefined;
  const directory = join(stateDirectory(), "activations");
  await checkStateDirectory(directory, true);
  const read = async (root: string) => {
    const key = sessionKey({ root }, options, options.ref);
    const path = join(directory, `${key}.json`);
    const current = (await readJson(path, true)) as
      { key?: unknown; enabled?: unknown; pending?: unknown; prepared?: unknown; committed?: unknown } | undefined;
    if (current !== undefined && (!current || current.key !== key || typeof current.enabled !== "boolean"))
      throw new Error(`Invalid GitRelay activation: ${path}; preserve it for inspection.`);
    if (
      (current?.pending !== undefined || current?.prepared !== undefined || current?.committed !== undefined) &&
      (!Array.isArray(current.pending) ||
        !current.pending.every((token) => typeof token === "string") ||
        (current.prepared !== undefined &&
          (!Array.isArray(current.prepared) ||
            !current.prepared.every(
              (item: Prepared) =>
                item &&
                typeof item.token === "string" &&
                (current.pending as string[]).includes(item.token) &&
                isId(item.repositoryId) &&
                (item.subscriptionKey === undefined || isId(item.subscriptionKey)),
            ))) ||
        typeof current.committed !== "boolean")
    )
      throw new Error(`Invalid GitRelay activation: ${path}; preserve it for inspection.`);
    return { key, path, current };
  };
  // The subscription's token is the commit point for an interrupted enable.
  const matchingRepository = async (root: string, current: Awaited<ReturnType<typeof read>>["current"]) => {
    const prepared = (current?.prepared as Prepared[] | undefined) ?? [];
    if (prepared.length) await checkStateDirectory(join(stateDirectory(), "repos"), true);
    for (const item of prepared) {
      const key = item.subscriptionKey ?? sessionKey({ root }, options, options.ref);
      const directory = join(stateDirectory(), "repos", item.repositoryId);
      await checkStateDirectory(directory, true);
      await checkStateDirectory(join(directory, "sessions"), true);
      const value = await readJson(join(directory, "sessions", `${key}.json`), true);
      if (value === undefined) continue;
      const session = validateSession(value, key);
      if (
        session.closedAt ||
        session.activationToken !== item.token ||
        session.adapter !== options.adapter ||
        session.session !== options.session ||
        session.instance !== options.instance ||
        session.ref !== options.ref
      )
        continue;
      return { repositoryId: item.repositoryId, subscriptionKey: key };
    }
  };
  const enabledAt = async (root: string, current: Awaited<ReturnType<typeof read>>["current"]) => {
    if (current?.enabled === true) return true;
    const matched = await matchingRepository(root, current);
    if (matched === undefined) return false;
    const repo = await repository(root, options.signal, false);
    return repo.id === matched.repositoryId && sessionKey(repo, options, options.ref) === matched.subscriptionKey;
  };
  let missing = false;
  const cwd = await realpath(resolve(options.cwd)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      missing = true;
      return resolve(options.cwd);
    }
    throw error;
  });
  const selected = process.env.GIT_WORK_TREE
    ? await realpath(resolve(cwd, process.env.GIT_WORK_TREE)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  const worktreeRoot = async () =>
    watchRoot(cwd, options.signal)
      .then(async (root) => {
        const canonical = await realpath(resolve(root));
        options.onRoot?.(canonical);
        return canonical;
      })
      .catch(async (error: Error & { cause?: { code?: number; signal?: NodeJS.Signals | null; killed?: boolean } }) => {
        options.signal?.throwIfAborted();
        // shortcut: Git exit 128 also covers damaged repositories; distinguish discovery failures when Git can do so reliably.
        if (
          !(error instanceof GitPathOutputError) &&
          error.cause?.code === 128 &&
          !error.cause.signal &&
          !error.cause.killed
        ) {
          if (selected && selected !== cwd && (await read(selected)).current?.enabled === true) throw error;
          let parent = dirname(cwd);
          while (parent !== cwd) {
            if ((await read(parent)).current?.enabled === true) throw error;
            const next = dirname(parent);
            if (next === parent) break;
            parent = next;
          }
          return cwd;
        }
        throw error;
      });
  if (enabled === undefined) {
    if (options.defaultEnabled) {
      for (let candidate = selected ?? cwd; ; candidate = dirname(candidate)) {
        const current = (await read(candidate)).current;
        if (current?.enabled === false && !(await matchingRepository(candidate, current))) return false;
        const marker = await lstat(join(candidate, ".git")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw error;
        });
        if (marker || dirname(candidate) === candidate) break;
      }
      const root = await worktreeRoot();
      const current = (await read(root)).current;
      return current === undefined || (await enabledAt(root, current));
    }
    if (process.env.GIT_WORK_TREE) {
      const selectedState = selected ? (await read(selected)).current : undefined;
      if (selected && (selectedState?.enabled === true || (await matchingRepository(selected, selectedState)))) {
        const root = await worktreeRoot();
        return root === selected && (await enabledAt(root, (await read(root)).current));
      }
      const cwdState = (await read(cwd)).current;
      if (!cwdState?.enabled && !(await matchingRepository(cwd, cwdState))) return false;
    }
    let candidate = cwd;
    while (true) {
      options.signal?.throwIfAborted();
      const candidateState = (await read(candidate)).current;
      if (candidateState?.enabled === true || (await matchingRepository(candidate, candidateState))) {
        const root = await worktreeRoot();
        const canonical = (await read(root)).current;
        return canonical !== undefined
          ? enabledAt(root, canonical)
          : candidate === cwd && candidateState?.enabled === true;
      }
      const marker = await lstat(join(candidate, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      });
      if (marker) return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
  let root: string;
  if (optOut?.root) root = await realpath(resolve(optOut.root));
  else if (optOut) {
    if (!missing) await worktreeRoot();
    const current = await preflightLeaveSession(options);
    if (current.root || current.repositoryId !== optOut.repositoryId)
      throw new Error("GitRelay target changed during opt-out; preserve state and retry.");
    root = cwd;
  } else root = await worktreeRoot();
  const { key, path } = await read(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkStateDirectory(directory);
  return withLock(
    `${path}.lock`,
    async () => {
      if (optOut?.root) {
        const current = await preflightLeaveSession(options);
        if (
          !current.root ||
          (await realpath(resolve(current.root))) !== root ||
          current.repositoryId !== optOut.repositoryId
        )
          throw new Error("GitRelay subscription changed during opt-out; preserve it and retry.");
      }
      const { current } = await read(root);
      const pending = (current?.pending as string[] | undefined) ?? [];
      const prepared = (current?.prepared as Prepared[] | undefined) ?? [];
      let committed =
        operation && pending.length
          ? current?.committed === true || (await enabledAt(root, current))
          : current?.enabled === true ||
            (current === undefined && operation?.phase === "begin" && operation.priorEnabled === true);
      let nextPending: string[] = [];
      let nextPrepared: Prepared[] = [];
      let nextEnabled = enabled;
      if (operation?.phase === "begin") {
        nextPending = [...pending, operation.token];
        nextPrepared = prepared;
        nextEnabled = committed;
      } else if (operation?.phase === "prepare") {
        if (!pending.includes(operation.token)) return false;
        if (!isId(operation.repositoryId)) throw new Error("Invalid activation repository ID.");
        if (operation.subscriptionKey !== undefined && !isId(operation.subscriptionKey))
          throw new Error("Invalid activation subscription key.");
        nextPending = pending;
        nextPrepared = [
          ...prepared,
          {
            token: operation.token,
            repositoryId: operation.repositoryId,
            ...(operation.subscriptionKey ? { subscriptionKey: operation.subscriptionKey } : {}),
          },
        ];
        nextEnabled = committed;
      } else if (operation) {
        if (!pending.includes(operation.token)) return current?.enabled === true;
        nextPending = pending.filter((token) => token !== operation.token);
        nextPrepared = prepared.filter((item) => item.token !== operation.token);
        nextEnabled = committed;
      } else if (current?.enabled === enabled && !pending.length) return enabled;
      await writeJson(
        path,
        {
          key,
          enabled: nextEnabled,
          ...(nextPending.length ? { pending: nextPending, prepared: nextPrepared, committed } : {}),
        },
        () => options.signal?.throwIfAborted(),
      );
      if (operation?.phase === "prepare" && operation.run) {
        try {
          await operation.run();
        } catch (error) {
          const remaining = nextPending.filter((token) => token !== operation.token);
          const ready = nextPrepared.filter((item) => item.token !== operation.token);
          await writeJson(path, {
            key,
            enabled: committed,
            ...(remaining.length ? { pending: remaining, prepared: ready, committed } : {}),
          });
          throw error;
        }
        await writeJson(path, { key, enabled: true });
      }
      return operation?.phase === "prepare" && operation.run ? true : nextEnabled;
    },
    { signal: options.signal, waitMs: 5000 },
  );
}
