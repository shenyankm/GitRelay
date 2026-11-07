import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitPathLine } from "./git.ts";
import { watchRoot } from "./changes.ts";
import {
  checkManagedRoot,
  checkStateDirectory,
  hash,
  isId,
  readJson,
  stateDirectory,
  withLock,
  writeExclusiveTemporary,
  writeJson,
} from "./store.ts";

export interface Repository {
  root: string;
  common: string;
  id: string;
  directory: string;
  identity: string;
  identitySource: "marker" | "external";
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

export async function repositoryIdentity(
  common: string,
  create: boolean,
): Promise<{ identity: string; identitySource: "marker" | "external" } | undefined> {
  const raw = process.env.GITBEACON_REPOSITORY_IDS;
  if (raw) {
    let mapping: unknown;
    try {
      mapping = JSON.parse(raw);
    } catch {
      throw new Error(
        "GITBEACON_REPOSITORY_IDS must be a JSON object mapping canonical Git common directories to 64-character IDs.",
      );
    }
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
      throw new Error("GITBEACON_REPOSITORY_IDS must be a JSON object.");
    const value = (mapping as Record<string, unknown>)[common];
    if (value !== undefined) {
      if (!isId(value)) throw new Error(`Invalid external repository identity for ${common}.`);
      return { identity: value, identitySource: "external" };
    }
  }
  const marker = join(common, ".gitbeacon-id");
  async function readMarker(): Promise<string | undefined> {
    const info = await lstat(marker).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid gitbeacon repository identity: ${marker}`);
    const file = await open(marker, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 65)
        throw new Error(`Invalid gitbeacon repository identity: ${marker}`);
      const bytes = Buffer.alloc(66);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const text = bytes.subarray(0, bytesRead).toString("utf8");
      if (!/^[a-f0-9]{64}\n$/.test(text)) throw new Error(`Invalid gitbeacon repository identity: ${marker}`);
      return text.slice(0, 64);
    } finally {
      await file.close();
    }
  }
  let identity = await readMarker();
  if (!identity && create) {
    const temporary = join(common, `.gitbeacon-id-${randomUUID()}.tmp`);
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
          `Cannot create gitbeacon identity in ${common}; configure GITBEACON_REPOSITORY_IDS for this read-only repository.${complete ? "" : ` If present, the temporary path ${temporary} was preserved.`}`,
          { cause: error },
        );
      throw error;
    }
    identity = await readMarker();
    if (!identity) throw new Error(`gitbeacon repository identity disappeared: ${marker}`);
  }
  return identity ? { identity, identitySource: "marker" } : undefined;
}

/** Inspect existing state without creating identities, directories, or locks. */
export async function inspectRepository(cwd: string, signal?: AbortSignal) {
  const root = await watchRoot(cwd, signal);
  const common = await realpath(
    gitPathLine(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "paths")),
  );
  await checkManagedRoot();
  const identity = await repositoryIdentity(common, false);
  const id = identity ? hash([common, identity.identity]) : null;
  const location = { root, common, id };
  if (!identity || id === null) return { ...location, repository: undefined };
  const directory = join(stateDirectory(), "repos", id);
  await checkStateDirectory(directory, true);
  const ready = (await readJson(join(directory, "identity-ready.json"), true)) as { id?: string } | undefined;
  if (!ready) return { ...location, repository: undefined };
  const owner = (await readJson(join(directory, "identity-owner.json"), true)) as { id?: string } | undefined;
  if (ready.id !== id || owner?.id !== id)
    throw new Error("Incomplete gitbeacon state initialization; inspect prior state.");
  await checkRepositoryDirectories(directory);
  const repository: Repository = { root, common, id, directory, ...identity };
  return { ...location, repository };
}

/** Serialize repository identity initialization and recovery. */
export async function withRepositoryIdentity<T>(
  cwd: string,
  signal: AbortSignal | undefined,
  run: (repo: Repository) => Promise<T>,
  initialize = true,
  discoveredRoot?: string,
): Promise<T> {
  await checkManagedRoot();
  const root = discoveredRoot ?? (await watchRoot(cwd, signal));
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
        throw new Error(`gitbeacon repository identity is missing in ${common}; restore it before retrying.`);
      const id = hash([common, identity.identity]);
      return run({ root, common, id, directory: join(stateDirectory(), "repos", id), ...identity });
    },
    { signal, waitMs: 5000, recoverDeadOwner: true },
  );
}

/** Caller holds publish.lock; failed comparisons retain the original atomic replacement behavior. */
export async function writeRepositoryMetadata(repo: Repository): Promise<void> {
  const path = join(repo.directory, "repo.json");
  const metadata = { id: repo.id, common: repo.common, identity: repo.identity, identitySource: repo.identitySource };
  const previous = await readJson(path, true).catch(() => undefined);
  if (JSON.stringify(previous) !== JSON.stringify(metadata)) await writeJson(path, metadata);
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
  const candidates = [...new Set(names)].filter((name) => isId(name) && name !== repo.id);
  for (let offset = 0; offset < candidates.length; offset += 32) {
    const reads = await Promise.allSettled(
      candidates.slice(offset, offset + 32).map(async (name) =>
        (await lstat(join(parent, name)).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }))
          ? name
          : undefined,
      ),
    );
    for (const result of reads) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) found.push(result.value);
    }
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
    if (!info.isFile()) throw new Error(`Invalid gitbeacon identity history: ${path}`);
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
        throw new Error(`gitbeacon identity changed while preparing recovery: ${common}`);
      const info = await lstat(repo.directory).catch((error) => {
        if (error.code === "ENOENT") throw new Error(`Nothing to recover for ${repo.common}; state is missing.`);
        throw error;
      });
      if (!info.isDirectory()) throw new Error(`Invalid gitbeacon state directory: ${repo.directory}`);
      const ready = (await readJson(join(repo.directory, "identity-ready.json"))) as { id?: string } | undefined;
      if (ready?.id === repo.id) throw new Error(`gitbeacon state is already initialized: ${repo.directory}`);
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
      const archive = join(stateDirectory(), "repos", `.gitbeacon-recovery-${randomUUID()}`);
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
    const existing = await lstat(repo.directory).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing)
      throw new Error(`gitbeacon state already exists: ${repo.directory}; inspect it before choosing fresh state.`);
    const prior = await priorRepositories(repo);
    const choices = join(stateDirectory(), "identity-choices"),
      path = join(choices, `${repo.id}.json`);
    await mkdir(choices, { recursive: true, mode: 0o700 });
    const previous = (await readJson(path)) as { id?: string } | undefined;
    if (previous !== undefined && previous.id !== repo.id)
      throw new Error(`Invalid gitbeacon identity choice: ${path}`);
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

export async function repository(
  cwd: string,
  signal?: AbortSignal,
  initialize = true,
  discoveredRoot?: string,
): Promise<Repository> {
  return withRepositoryIdentity(
    cwd,
    signal,
    async (repo) => {
      const existing = await lstat(repo.directory).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) {
        if (!existing.isDirectory()) throw new Error(`Invalid gitbeacon state directory: ${repo.directory}`);
        const ready = (await readJson(join(repo.directory, "identity-ready.json"))) as { id?: string } | undefined;
        const owner = (await readJson(join(repo.directory, "identity-owner.json"))) as { id?: string } | undefined;
        if (ready?.id !== repo.id || owner?.id !== repo.id)
          throw new Error(
            `Incomplete gitbeacon state initialization: ${repo.directory}; inspect and preserve it before recovery.`,
          );
        await checkRepositoryDirectories(repo.directory);
      } else {
        if (!initialize)
          throw new Error(`gitbeacon repository state is missing: ${repo.directory}; preserve it for inspection.`);
        const prior = await priorRepositories(repo);
        const choice = (await readJson(join(stateDirectory(), "identity-choices", `${repo.id}.json`))) as
          { id?: string } | undefined;
        if (prior.length && choice?.id !== repo.id)
          throw new Error(
            `Earlier gitbeacon state exists for ${repo.common}; call choose_fresh_repository after inspecting it. Prior state is preserved.`,
          );
        await recordRepositoryIdentity(repo);
        await mkdir(join(stateDirectory(), "repos"), { recursive: true, mode: 0o700 });
        const temporary = join(stateDirectory(), "repos", `.gitbeacon-owner-${randomUUID()}.tmp`);
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
                  `Cannot publish gitbeacon state ownership using a hard link; inspect and preserve the incomplete directory: ${repo.directory}`,
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
    discoveredRoot,
  );
}
