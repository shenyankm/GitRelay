import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { git, gitPathLine } from "./git.ts";
import { checkStateDirectory, isCommit } from "./store.ts";

export interface Revision {
  id: string;
  kind: "branch" | "remote" | "worktree" | "index" | "pr";
  repository: string;
  ref: string;
  commit: string;
  root?: string;
  caseInsensitive?: boolean;
  base?: string;
  url?: string;
}

export interface Conflict {
  level: "conflict" | "overlap" | "unknown";
  target: Revision;
  incoming: Revision;
  files: string[];
  reason: string;
}

const names = (value: string) => value.split("\0").filter(Boolean);
const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
const observerEnvironment = {
  GIT_CONFIG_GLOBAL: nullDevice,
  GIT_CONFIG_SYSTEM: nullDevice,
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

export function observationGit(
  observer: string,
  args: string[],
  signal?: AbortSignal,
  paths?: "paths",
  env?: NodeJS.ProcessEnv,
) {
  return git(observer, ["-c", `core.hooksPath=${nullDevice}`, "-c", "core.fsmonitor=false", ...args], signal, paths, {
    env: { ...observerEnvironment, ...env },
    processGroup: args.includes("fetch") && process.platform !== "win32",
  });
}

/** The observer owns every object, ref and temporary index written by analysis. */
export async function openObserver(
  directory: string,
  signal?: AbortSignal,
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<string> {
  const path = join(directory, objectFormat === "sha1" ? "observer.git" : "observer-sha256.git");
  await checkStateDirectory(path, true);
  await mkdir(path, { recursive: true, mode: 0o700 });
  for (const child of ["objects", "objects/info", "refs", "refs/relay"])
    await checkStateDirectory(join(path, child), true);
  for (const name of ["config", "HEAD"]) {
    const info = await lstat(join(path, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && !info.isFile()) throw new Error(`Invalid observer file: ${name}; preserve state for inspection.`);
  }
  await observationGit(path, ["init", "--bare", `--object-format=${objectFormat}`, "--template=", "-q"], signal);
  return path;
}

export async function importRefs(observer: string, source: string, prefix: string, signal?: AbortSignal) {
  await observationGit(
    observer,
    [
      "-c",
      "credential.helper=!gh auth git-credential",
      "fetch",
      "--quiet",
      "--prune",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--",
      source,
      `+refs/heads/*:refs/relay/${prefix}/heads/*`,
      `+refs/remotes/*:refs/relay/${prefix}/remotes/*`,
    ],
    signal,
    undefined,
    { GIT_ALLOW_PROTOCOL: "file:https:ssh" },
  );
}

export async function compareRevisions(
  observer: string,
  target: Revision,
  incoming: Revision,
  signal?: AbortSignal,
): Promise<Conflict | undefined> {
  if (!isCommit(target.commit) || !isCommit(incoming.commit)) throw new Error("Invalid revision object ID.");
  const collision = async (revision: string): Promise<Conflict | undefined> => {
    if (!target.caseInsensitive) return;
    const paths = names(
      await observationGit(observer, ["ls-tree", "-r", "--name-only", "-z", revision], signal, "paths"),
    );
    const prefixes = new Map<string, { prefix: string; file: string }>();
    const files = new Set<string>();
    for (const file of paths) {
      let prefix = "";
      for (const part of file.split("/")) {
        prefix = prefix ? `${prefix}/${part}` : part;
        const key = prefix.toLowerCase();
        const prior = prefixes.get(key);
        if (prior && prior.prefix !== prefix) {
          files.add(prior.file);
          files.add(file);
        } else if (!prior) prefixes.set(key, { prefix, file });
      }
    }
    if (files.size)
      return {
        level: "conflict",
        target,
        incoming,
        files: [...files].sort(),
        reason:
          "The receiver's case-insensitive filesystem cannot represent these merged paths distinctly, even if Git's abstract tree merges cleanly.",
      };
  };
  try {
    if (target.commit === incoming.commit) return await collision(target.commit);
    const base = (await observationGit(observer, ["merge-base", target.commit, incoming.commit], signal)).trim();
    if (!isCommit(base)) throw new Error("No readable common ancestor.");
    if (base === target.commit || base === incoming.commit)
      return await collision(base === target.commit ? incoming.commit : target.commit);
    const own = names(
      await observationGit(
        observer,
        ["diff", "--name-only", "--no-renames", "-z", base, target.commit, "--"],
        signal,
        "paths",
      ),
    );
    const other = names(
      await observationGit(
        observer,
        ["diff", "--name-only", "--no-renames", "-z", base, incoming.commit, "--"],
        signal,
        "paths",
      ),
    );
    const overlap = other.filter((file) =>
      own.some((path) => path === file || path.startsWith(`${file}/`) || file.startsWith(`${path}/`)),
    );
    try {
      const merged = await observationGit(
        observer,
        [
          "-c",
          "merge.renormalize=false",
          "merge-tree",
          "--write-tree",
          "--name-only",
          "-z",
          target.commit,
          incoming.commit,
        ],
        signal,
        "paths",
      );
      const tree = merged.split("\0")[0];
      if (!isCommit(tree)) throw new Error("Invalid merge-tree output.");
      const issue = await collision(tree);
      if (issue) return issue;
    } catch (error) {
      signal?.throwIfAborted();
      const cause = (error as Error & { cause?: { code?: unknown; stdout?: Buffer } }).cause;
      if (cause?.code !== 1 || !cause.stdout) throw error;
      const output = new TextDecoder("utf-8", { fatal: true }).decode(cause.stdout);
      const [tree, ...records] = output.split("\0");
      if (!isCommit(tree)) throw new Error("Invalid merge-tree conflict output.");
      const end = records.indexOf("");
      if (end < 0) throw new Error("Incomplete merge-tree conflict output.");
      return {
        level: "conflict",
        target,
        incoming,
        files: records.slice(0, end),
        reason: "Git's three-way merge reports content or structural conflicts; no worktree was changed.",
      };
    }
    if (overlap.length)
      return {
        level: "overlap",
        target,
        incoming,
        files: overlap,
        reason: "Paths overlap, but Git can merge these snapshots cleanly. Semantic compatibility is not established.",
      };
  } catch (error) {
    signal?.throwIfAborted();
    return { level: "unknown", target, incoming, files: [], reason: (error as Error).message };
  }
}

export async function worktreeRevisions(
  observer: string,
  root: string,
  repository: string,
  signal?: AbortSignal,
): Promise<Revision[]> {
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
  const branch = await git(root, ["symbolic-ref", "-q", "HEAD"], signal, "paths")
    .then(gitPathLine)
    .catch((error) => {
      signal?.throwIfAborted();
      if (error.cause?.code === 1) return "HEAD";
      throw error;
    });
  // Only non-executable normalization settings cross into the private observer.
  const settings = await git(
    root,
    [
      "config",
      "--null",
      "--get-regexp",
      "^core\\.(autocrlf|eol|safecrlf|filemode|ignorecase|symlinks|attributesfile|precomposeunicode)$",
    ],
    signal,
    "paths",
  ).catch((error) => {
    signal?.throwIfAborted();
    if (error.cause?.code === 1) return "";
    throw error;
  });
  const config: string[] = [];
  let caseInsensitive = false;
  for (const setting of names(settings)) {
    const newline = setting.indexOf("\n");
    if (newline < 0) throw new Error("Invalid Git snapshot settings.");
    const key = setting.slice(0, newline),
      value = setting.slice(newline + 1);
    config.push("-c", `${key}=${value}`);
    if (key === "core.ignorecase") caseInsensitive = ["true", "yes", "on", "1", ""].includes(value.toLowerCase());
  }
  const revisions: Revision[] = [{ id: `${root}:HEAD`, kind: "worktree", repository, root, ref: branch, commit: head }];
  const index = join(observer, `index-${randomUUID()}`);
  const env = {
    ...observerEnvironment,
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: join(observer, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  };
  const run = (args: string[]) =>
    git(
      root,
      [
        `--git-dir=${observer}`,
        `--work-tree=${root}`,
        ...config,
        "-c",
        `core.hooksPath=${nullDevice}`,
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      signal,
      undefined,
      { env },
    );
  try {
    const status = await git(
      root,
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
      signal,
      "paths",
    );
    if (status.split("\0").some((record) => /^[12u] \S+ S.(?:M.|.U) /.test(record)))
      throw new Error(
        "Uncommitted submodule contents cannot be snapshotted in the parent tree; track the submodule repository separately.",
      );
    const flags = await git(root, ["ls-files", "-v", "-z"], signal, "paths");
    if (flags.split("\0").some((record) => /^[a-zS] /.test(record)))
      throw new Error(
        "Sparse/skip-worktree/assume-unchanged indexes cannot be observed safely; conflict status is unknown.",
      );
    if (!caseInsensitive)
      for (const record of names(flags)) {
        const file = record.slice(2);
        const variant = file.replace(/[a-zA-Z](?=[^/]*$)/, (letter) =>
          letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
        );
        if (variant === file) continue;
        const original = await lstat(join(root, file)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return;
          throw error;
        });
        if (!original) continue;
        const folded = await lstat(join(root, variant)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return;
          throw error;
        });
        caseInsensitive = !!folded && original.dev === folded.dev && original.ino === folded.ino;
        break;
      }
    revisions[0].caseInsensitive = caseInsensitive;
    if (!status) return revisions;
    const attributes = gitPathLine(
      await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"], signal, "paths"),
    );
    const privateAttributes = await readFile(attributes).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      throw error;
    });
    if (privateAttributes?.length)
      throw new Error(
        "Private Git info/attributes cannot be safely reproduced in a shared observer; snapshot status is unknown.",
      );
    const filters = await git(root, ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"], signal).catch(
      (error) => {
        signal?.throwIfAborted();
        if (error.cause?.code === 1) return "";
        throw error;
      },
    );
    if (filters) {
      const files = [
        ...new Set([
          ...names(flags).map((record) => record.slice(2)),
          ...names(status)
            .filter((record) => record.startsWith("? "))
            .map((record) => record.slice(2)),
        ]),
      ];
      for (let offset = 0; offset < files.length; offset += 32) {
        const attributes = names(
          await git(root, ["check-attr", "--all", "-z", "--", ...files.slice(offset, offset + 32)], signal, "paths"),
        );
        if (attributes.length % 3) throw new Error("Invalid Git filter attributes; snapshot status is unknown.");
        if (attributes.some((value, index) => index % 3 === 1 && value === "filter"))
          throw new Error(
            "External Git filters cannot be executed in the observer; filtered dirty snapshots are unknown.",
          );
      }
    }
    const sparse = await git(root, ["config", "--bool", "--get", "core.sparseCheckout"], signal).catch((error) => {
      signal?.throwIfAborted();
      if (error.cause?.code === 1) return "false";
      throw error;
    });
    if (sparse.trim() === "true")
      throw new Error("Dirty sparse worktrees cannot be snapshotted safely; conflict status is unknown.");
    const sourceIndex = gitPathLine(
      await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], signal, "paths"),
    );
    await copyFile(sourceIndex, index);
    const staged = (await run(["write-tree"])).trim();
    const commit = async (tree: string) => {
      if (!isCommit(tree)) throw new Error("Invalid snapshot tree.");
      return (
        await observationGit(
          observer,
          [
            "-c",
            "user.name=gitbeacon",
            "-c",
            "user.email=gitbeacon@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            tree,
            "-p",
            head,
            "-m",
            "gitbeacon observation snapshot",
          ],
          signal,
          undefined,
          { GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
        )
      ).trim();
    };
    const headTree = (await observationGit(observer, ["rev-parse", `${head}^{tree}`], signal)).trim();
    if (staged !== headTree)
      revisions.push({ ...revisions[0], id: `${root}:index`, kind: "index", commit: await commit(staged) });
    await run(["read-tree", head]);
    await run(["add", "--all", "--", "."]);
    const tree = (await run(["write-tree"])).trim();
    if (tree !== headTree) revisions[0] = { ...revisions[0], commit: await commit(tree) };
    await run(["diff-files", "--quiet", "--"]);
    const after = await git(
      root,
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
      signal,
      "paths",
    );
    if (after !== status || (await git(root, ["rev-parse", "HEAD"], signal)).trim() !== head)
      throw new Error("Worktree changed during observation; retry at the next checkpoint.");
    return revisions;
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}
