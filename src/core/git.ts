import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitPathOutputError extends Error {}

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: string;
  prunable?: string;
}

// Mutators must settle their entire POSIX process group before a caller can release write guards.
async function gitProcessGroup(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (process.platform === "win32") throw new Error("Git process-group writes require POSIX.");
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[][] = [[], []],
      sizes = [0, 0];
    let failure: unknown;
    const stop = (error: unknown) => {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(
      () => stop(Object.assign(new Error("Git command timed out."), { code: "ETIMEDOUT", killed: true })),
      30_000,
    );
    const abort = () => stop(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, index] of [
      [child.stdout, 0],
      [child.stderr, 1],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        if (failure) return;
        sizes[index] += chunk.length;
        if (sizes[index] > 16 * 1024 * 1024) {
          stop(Object.assign(new Error("Git output exceeds 16 MiB."), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
          return;
        }
        chunks[index].push(chunk);
      });
      stream.on("error", stop);
    }
    child.on("error", stop);
    child.on("close", (code, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      const stdout = Buffer.concat(chunks[0]),
        stderr = Buffer.concat(chunks[1]);
      if (code !== 0)
        return reject(
          Object.assign(new Error(stderr.toString("utf8").trim() || `Git exited with ${code}.`), {
            code,
            signal: terminationSignal,
            stdout,
            stderr,
          }),
        );
      resolve(stdout);
    });
  });
}

export async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  paths?: "paths" | "worktree-records",
  options?: { env?: NodeJS.ProcessEnv; processGroup?: boolean },
): Promise<string> {
  signal?.throwIfAborted();
  try {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      ...options?.env,
    };
    const stdout = options?.processGroup
      ? await gitProcessGroup(cwd, args, env, signal)
      : (
          await exec("git", ["-C", cwd, ...args], {
            encoding: "buffer",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 30_000,
            signal,
            env,
          })
        ).stdout;
    if (!paths) return stdout.toString("utf8");
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      if (paths === "paths") return decoder.decode(stdout);
      for (let start = 0; start < stdout.length;) {
        const delimiter = stdout.indexOf(0, start),
          end = delimiter < 0 ? stdout.length : delimiter;
        const field = stdout.subarray(start, end);
        for (const prefix of [Buffer.from("worktree "), Buffer.from("branch ")]) {
          if (field.subarray(0, prefix.length).equals(prefix)) decoder.decode(field.subarray(prefix.length));
        }
        start = end + 1;
      }
      return stdout.toString("utf8");
    } catch (cause) {
      throw new GitPathOutputError("Git returned a path or ref that is not valid UTF-8; cannot safely continue.", {
        cause,
      });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GitPathOutputError) throw error;
    const failure = error as Error & { stderr?: string | Buffer };
    const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : failure.stderr;
    throw new Error(stderr?.trim() || failure.message, { cause: error });
  }
}

/** Remove only Git's line terminator, never a Unix path's trailing CR. */
export function gitPathLine(output: string): string {
  if (!output.endsWith("\n")) throw new GitPathOutputError("Git returned an unterminated path.");
  const path = output.slice(0, -1);
  return process.platform === "win32" && path.endsWith("\r") ? path.slice(0, -1) : path;
}

/** Parse Git ref lines without trimming valid Unicode ref characters. */
export function gitRefLines(output: string): string[] {
  if (output && !output.endsWith("\n")) throw new GitPathOutputError("Git returned unterminated ref data.");
  return output
    .split("\n")
    .map((line) => (process.platform === "win32" && line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Configuration and symbolic-ref require exactly one complete record. */
export function gitRefLine(output: string): string {
  const value = gitPathLine(output);
  if (/[\r\n]/.test(value)) throw new GitPathOutputError("Git returned multiple or invalid ref values.");
  return value;
}

export function parseWorktrees(output: string): Worktree[] {
  const trees: Worktree[] = [];
  let tree: Worktree | undefined;
  for (const field of output.split("\0")) {
    const space = field.indexOf(" ");
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      tree = { path: value };
      trees.push(tree);
    } else if (tree) {
      if (key === "HEAD") tree.head = value;
      if (key === "branch") tree.branch = value.replace(/^refs\/heads\//, "");
      if (key === "bare") tree.bare = true;
      if (key === "detached") tree.detached = true;
      if (key === "locked") tree.locked = value;
      if (key === "prunable") tree.prunable = value;
    }
  }
  return trees;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  return parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain", "-z"], undefined, "worktree-records"));
}

export async function addWorktree(
  cwd: string,
  path: string,
  branch: string,
  newBranch = false,
  startPoint = "HEAD",
): Promise<string> {
  if (!path || /^[\t\n\r ]*$/.test(path)) throw new Error("Worktree path must not be empty.");
  await git(cwd, ["check-ref-format", "--branch", branch]);
  // Do not let check-ref-format's @{-n} expansion change the requested branch.
  if (branch.startsWith("-") || branch.startsWith("@{")) throw new Error("Use an explicit branch name.");
  const target = resolve(cwd, path);
  if (newBranch) {
    const refs = gitRefLines(
      await git(
        cwd,
        ["for-each-ref", "--format=%(refname)", "--", `refs/heads/${startPoint}`, `refs/tags/${startPoint}`],
        undefined,
        "paths",
      ),
    );
    if (refs.includes(`refs/heads/${startPoint}`) && refs.includes(`refs/tags/${startPoint}`))
      throw new Error(
        "The starting point matches both a branch and a tag; use a full ref under refs/heads/ or refs/tags/.",
      );
    const selected =
      !startPoint.startsWith("refs/") && startPoint !== "HEAD" && refs.includes(`refs/heads/${startPoint}`)
        ? `refs/heads/${startPoint}`
        : startPoint;
    const commit = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${selected}^{commit}`])).trim();
    await git(cwd, ["worktree", "add", "-b", branch, "--", target, `${commit}^{commit}`]);
  } else {
    // A fully qualified ref prevents a tag or revision expression from becoming a detached checkout.
    await git(cwd, ["show-ref", "--verify", "--", `refs/heads/${branch}`]);
    await git(cwd, ["worktree", "add", "--", target, branch]);
  }
  return realpath(target);
}

export async function removeWorktree(cwd: string, path: string): Promise<void> {
  const trees = await listWorktrees(cwd);
  const target = await realpath(resolve(cwd, path)).catch((error) => {
    if (error.code === "ENOENT") return resolve(cwd, path); // Git can remove a prunable registration whose directory is gone.
    throw error;
  });
  const tree = trees.find((entry) => resolve(entry.path) === target);
  if (!tree) throw new Error("The selected path is not a worktree of the current repository.");
  if (tree === trees[0] || tree.bare) throw new Error("Cannot remove the main worktree or a bare repository.");
  if (tree.locked !== undefined) throw new Error("Cannot remove a locked worktree.");
  const current = await realpath(cwd);
  const inside = relative(target, current);
  if (!inside || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`))) {
    throw new Error("Cannot remove the current worktree. Run Git from another worktree first.");
  }
  // shortcut: Git has no identity-conditional removal; restore only with atomic target binding.
  throw new Error(
    "Automatic worktree removal is temporarily unavailable because Git cannot atomically verify the selected worktree. Stop other worktree operations, inspect the target and back up ignored files before using Git manually.",
  );
}
