import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { branchStatus } from "./branch-status.ts";
import { git, gitPathLine, gitRefLine, gitRefLines } from "./git.ts";
import { isCommit, writeJson } from "./store.ts";

export interface SyncResult {
  state: "updated" | "up-to-date" | "ahead" | "blocked" | "error";
  remote?: string;
  reason?: string;
}

const operations = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "BISECT_START",
];

async function operationInProgress(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  for (let offset = 0; offset < operations.length; offset += 4) {
    const checks = await Promise.allSettled(
      operations.slice(offset, offset + 4).map(async (name) => {
        const path = gitPathLine(
          await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name], signal, "paths"),
        );
        const item = await lstat(path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        return item ? name : undefined;
      }),
    );
    for (const result of checks) if (result.status === "rejected") throw result.reason;
    for (const result of checks) if (result.status === "fulfilled" && result.value) return result.value;
  }
}

/** A prepared HEAD update locks both HEAD and its resolved branch in Git's files backend. */
async function withPreparedHead(
  cwd: string,
  args: string[],
  upstream: string,
  before: string,
  after: string,
  signal: AbortSignal | undefined,
  run: (healthy: () => void) => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const child = spawn("git", ["-C", cwd, ...args, "update-ref", "-m", "git-relay: fast-forward", "--stdin"], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
  });
  let stdout = "",
    stderr = "",
    failure: unknown,
    exited = false;
  const prepared = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: unknown) => {
    failure ??= error;
    if (exited || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    killTimer ??= setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 1000);
  };
  const timer = setTimeout(() => stop(new Error("Git reference transaction timed out.")), 30_000);
  const abort = () => stop(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdin.on("error", stop);
  child.stdout.on("error", stop);
  child.stderr.on("error", stop);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 1024) return stop(new Error("Invalid Git reference transaction output."));
    if (stdout.split("\n").includes("prepare: ok")) prepared.resolve();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(0, 4096);
  });
  child.on("error", stop);
  child.on("close", (code) => {
    exited = true;
    clearTimeout(killTimer);
    if (code !== 0) failure ??= new Error(stderr.trim() || `Git reference transaction exited with ${code}.`);
    prepared.reject(failure ?? new Error("Git reference transaction closed before prepare."));
    closed.resolve();
  });
  // Attach before writing so a failed prepare cannot become an unhandled rejection.
  void prepared.promise.catch(() => {});
  const healthy = () => {
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (exited) throw new Error("Git reference transaction ended before commit.");
  };
  try {
    child.stdin.write(
      `start\nupdate HEAD ${after} ${before}\noption no-deref\nverify ${JSON.stringify(upstream)} ${after}\nprepare\n`,
    );
    await prepared.promise;
    healthy();
    await run(healthy);
    healthy();
    child.stdin.end("commit\n");
    await closed.promise;
    if (failure) throw failure;
    if (!stdout.split("\n").includes("commit: ok")) throw new Error("Git reference commit was not confirmed.");
  } finally {
    if (!exited) child.stdin.end("abort\n");
    await closed.promise;
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", abort);
  }
}

async function removeOwnedLock(path: string, file: FileHandle): Promise<void> {
  const held = await file.stat();
  const current = await lstat(path);
  if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino)
    throw new Error(`Git sync lock changed; preserved: ${path}`);
  await rm(path);
}

export async function syncBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<SyncResult> {
  signal?.throwIfAborted();
  let indexLock: FileHandle | undefined, worktreeLock: FileHandle | undefined;
  let indexLockPath = "",
    worktreeLockPath = "",
    staging: string | undefined;
  let applying = false,
    committed = false,
    phase = "preflight";
  let remote: string | undefined;
  try {
    // shortcut: require POSIX process groups and files refs; other platforms/backends need equivalent lock and teardown guarantees.
    if (process.platform === "win32")
      return { state: "blocked", reason: "Automatic synchronization requires POSIX Git process and file locks." };
    for (const name of [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_NAMESPACE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ])
      if (process.env[name])
        return {
          state: "blocked",
          reason: `Unset ${name} before automatic synchronization; only the selected worktree may be updated.`,
        };
    const root = await realpath(gitPathLine(await git(cwd, ["rev-parse", "--show-toplevel"], signal, "paths")));
    const gitDir = await realpath(gitPathLine(await git(root, ["rev-parse", "--absolute-git-dir"], signal, "paths")));
    const common = await realpath(
      gitPathLine(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "paths")),
    );
    const config = async (key: string, boolean = false): Promise<string | undefined> => {
      try {
        return gitRefLine(
          await git(root, ["config", ...(boolean ? ["--bool"] : []), "--get-all", key], signal, "paths"),
        );
      } catch (error) {
        signal?.throwIfAborted();
        const cause = (error as Error & { cause?: { code?: unknown; stderr?: Buffer | string } }).cause;
        if (cause?.code === 1 && !cause.stderr?.toString()) return undefined;
        throw error;
      }
    };
    const storage = await config("extensions.refStorage");
    if (storage && storage !== "files")
      return { state: "blocked", reason: "Automatic synchronization currently requires Git's files ref backend." };
    const conditionalConfig = await git(
      root,
      ["config", "--name-only", "--get-regexp", "^includeif\\."],
      signal,
      "paths",
    ).catch((error) => {
      signal?.throwIfAborted();
      if (error?.cause?.code === 1 && !error.cause.stderr?.toString()) return "";
      throw error;
    });
    const policies = await Promise.allSettled(
      ["extensions.worktreeConfig", "core.sparseCheckout", "core.splitIndex"].map((key) => config(key, true)),
    );
    signal?.throwIfAborted();
    const policy = policies.find((result) => result.status === "rejected" || result.value === "true");
    if (policy?.status === "rejected") throw policy.reason;
    if (policy || conditionalConfig)
      return {
        state: "blocked",
        reason:
          "Automatic synchronization does not support per-worktree config, conditional config, sparse checkout or split indexes; synchronize manually.",
      };
    const index = join(gitDir, "index");
    if (!(await lstat(index)).isFile()) throw new Error("Automatic synchronization requires a regular Git index.");
    if (gitDir !== common) {
      worktreeLockPath = join(gitDir, "locked");
      worktreeLock = await open(worktreeLockPath, "wx", 0o600);
      await worktreeLock.writeFile("git-relay: synchronization in progress\n");
    }
    indexLockPath = `${index}.lock`;
    indexLock = await open(indexLockPath, "wx", 0o600);
    const initial = await branchStatus({ cwd: root, branch, signal });
    if (initial.worktree.branch !== branch || !initial.local.commit)
      return { state: "blocked", reason: "Auto-sync only updates an existing branch checked out in --cwd." };
    const ref = initial.local.ref,
      before = initial.local.commit,
      upstream = initial.local.tracking?.ref;
    if (!upstream?.startsWith("refs/remotes/"))
      return { state: "blocked", reason: "Configure a remote upstream for this branch before enabling auto-sync." };
    remote = await config(`branch.${branch}.remote`);
    const source = await config(`branch.${branch}.merge`);
    const remotes = gitRefLines(await git(root, ["remote"], signal, "paths"));
    if (!remote || !remotes.includes(remote) || !source?.startsWith("refs/heads/"))
      return { state: "blocked", reason: "Auto-sync requires one configured remote branch upstream." };
    await git(root, ["check-ref-format", source], signal);
    await git(root, ["check-ref-format", upstream], signal);
    if ((await config(`branch.${branch}.mergeOptions`)) !== undefined)
      return {
        state: "blocked",
        remote,
        reason: "Automatic synchronization does not support branch-specific merge options; synchronize manually.",
      };
    for (const name of ["post-merge", "post-index-change"]) {
      const path = gitPathLine(
        await git(root, ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`], signal, "paths"),
      );
      const executable = await access(path, constants.X_OK).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") return false;
          throw error;
        },
      );
      if (executable)
        return {
          state: "blocked",
          remote,
          reason: `Automatic synchronization does not support a ${name} hook; synchronize manually so its policy is preserved.`,
        };
    }
    const oldOperation = await operationInProgress(root, signal);
    if (oldOperation)
      return {
        state: "blocked",
        remote,
        reason: `Git operation in progress (${oldOperation}); finish it before syncing.`,
      };
    const flags = (await git(root, ["ls-files", "-v", "-z"], signal, "paths")).split("\0");
    if (flags.some((row) => /^[a-zS] /.test(row)))
      return {
        state: "blocked",
        remote,
        reason: "Index has assume-unchanged or skip-worktree entries; preserve local work and synchronize manually.",
      };
    const sharedIndex = await git(root, ["rev-parse", "--shared-index-path"], signal, "paths");
    if (sharedIndex)
      return {
        state: "blocked",
        remote,
        reason: "Automatic synchronization does not support split indexes; synchronize manually.",
      };
    const oldUpstream = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", upstream], signal)
      .then((value) => value.trim())
      .catch((error) => {
        signal?.throwIfAborted();
        if (error?.cause?.code === 1 && !error.cause.stderr?.toString()) return "0".repeat(before.length);
        throw error;
      });
    if (!isCommit(oldUpstream)) throw new Error("Invalid upstream object ID.");
    const shadow = await mkdtemp(join(gitDir, "git-relay-sync-"));
    staging = shadow;
    const privateIndex = join(shadow, "index"),
      journal = join(shadow, "recovery.json");
    const args = [`--git-dir=${gitDir}`, `--work-tree=${root}`];
    const privateArgs = [`--git-dir=${shadow}`, `--work-tree=${root}`, "-c", `core.hooksPath=${shadow}`];
    await writeFile(join(shadow, "HEAD"), `${before}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(shadow, "commondir"), `${relative(shadow, common)}\n`, { flag: "wx", mode: 0o600 });
    phase = "fetch";
    await writeJson(journal, { root, gitDir, ref, remote, source, upstream, oldUpstream, before, phase });
    await indexLock.writeFile(JSON.stringify({ pid: process.pid, recovery: journal }));
    // Fetch only objects and a private FETCH_HEAD: a concurrent upstream symref must never redirect a fetch into a local branch.
    await git(
      root,
      [
        ...privateArgs,
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--refmap=",
        "--",
        remote,
        source,
      ],
      signal,
      undefined,
      { env: { GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh" }, processGroup: true },
    );
    const fetched = (
      await git(
        root,
        [...privateArgs, "rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"],
        signal,
        undefined,
        { env: { GIT_NO_REPLACE_OBJECTS: "1" } },
      )
    ).trim();
    if (!isCommit(fetched)) throw new Error("Invalid fetched commit.");
    await git(
      root,
      [
        ...args,
        "update-ref",
        "--no-deref",
        "-m",
        "git-relay: fetch configured upstream",
        upstream,
        fetched,
        oldUpstream,
      ],
      signal,
      undefined,
      { processGroup: true },
    );
    const fresh = await branchStatus({ cwd: root, branch, signal });
    if (
      fresh.worktree.branch !== branch ||
      fresh.local.commit !== before ||
      fresh.local.tracking?.ref !== upstream ||
      (await config(`branch.${branch}.remote`)) !== remote ||
      (await config(`branch.${branch}.merge`)) !== source
    )
      return {
        state: "blocked",
        remote,
        reason: "Branch or upstream changed during fetch; retry after other Git operations finish.",
      };
    const newOperation = await operationInProgress(root, signal);
    if (newOperation)
      return {
        state: "blocked",
        remote,
        reason: `Git operation in progress (${newOperation}); finish it before syncing.`,
      };
    if (fresh.worktree.dirty)
      return {
        state: "blocked",
        remote,
        reason: "Worktree has staged, unstaged or untracked changes; preserved without stashing.",
      };
    const tracking = fresh.local.tracking;
    if (!tracking?.commit || tracking.ahead === null || tracking.behind === null)
      return { state: "blocked", remote, reason: "Upstream commit is unavailable." };
    if (tracking.ahead && tracking.behind)
      return {
        state: "blocked",
        remote,
        reason: "Branches have diverged; auto-sync never rebases or resets local commits.",
      };
    if (!tracking.behind) return { state: tracking.ahead ? "ahead" : "up-to-date", remote };
    const after = tracking.commit;
    if (!isCommit(before) || !isCommit(after)) throw new Error("Invalid synchronization commit.");
    // Validate the full symbolic reference, including UTF-8, before preparing any update.
    if (gitRefLine(await git(root, ["symbolic-ref", "HEAD"], signal, "paths")) !== ref)
      return {
        state: "blocked",
        remote,
        reason: "HEAD changed before fast-forward; retry after other Git operations finish.",
      };
    const context = { root, gitDir, ref, remote, source, upstream, oldUpstream, before, after };
    await copyFile(index, privateIndex);
    await copyFile(index, join(shadow, "original-index"));
    phase = "preparing-ref";
    await writeJson(journal, { ...context, phase });
    await withPreparedHead(root, args, upstream, before, after, signal, async (healthy) => {
      if (gitRefLine(await git(root, [...args, "symbolic-ref", "HEAD"], signal, "paths")) !== ref)
        throw new Error("HEAD changed before the Git reference locks were acquired; nothing was applied.");
      const operation = await operationInProgress(root, signal);
      if (operation) throw new Error(`Git operation in progress (${operation}); nothing was applied.`);
      healthy();
      // A private detached HEAD lets Git retain its dirty/ignored-file checks without touching the locked real HEAD.
      phase = "applying";
      await writeJson(journal, { ...context, phase });
      healthy();
      applying = true;
      await git(
        root,
        [
          ...privateArgs,
          "-c",
          "submodule.recurse=false",
          "-c",
          "core.fsmonitor=false",
          "merge",
          "--ff-only",
          "--no-autostash",
          "--no-overwrite-ignore",
          "--",
          after,
        ],
        signal,
        undefined,
        { env: { GIT_NO_REPLACE_OBJECTS: "1" }, processGroup: true },
      );
      healthy();
      phase = "publishing-index";
      await writeJson(journal, { ...context, phase });
      healthy();
      await rename(privateIndex, index);
      phase = "committing-ref";
      await writeJson(journal, { ...context, phase });
    });
    committed = true;
    return { state: "updated", remote };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const recovery =
      applying && !committed
        ? ` Synchronization may be partial (${phase}); Git index/worktree locks and recovery data were retained at ${staging}. Inspect HEAD, both indexes and working files; do not delete locks or retry blindly.`
        : "";
    if (signal?.aborted) {
      if (recovery)
        throw Object.assign(new Error(`${detail}${recovery}`, { cause: signal.reason }), { name: "AbortError" });
      signal.throwIfAborted();
    }
    if (!applying && (error as NodeJS.ErrnoException).code === "EEXIST")
      return {
        state: "blocked",
        remote,
        reason: `Git index or worktree is locked; preserve the existing lock and inspect its owner. ${detail}`,
      };
    return { state: "error", remote, reason: detail + recovery };
  } finally {
    try {
      if (!applying || committed) {
        if (indexLock) await removeOwnedLock(indexLockPath, indexLock);
        if (worktreeLock) await removeOwnedLock(worktreeLockPath, worktreeLock);
        if (staging) await rm(staging, { recursive: true });
      }
    } finally {
      await indexLock?.close();
      await worktreeLock?.close();
    }
  }
}
