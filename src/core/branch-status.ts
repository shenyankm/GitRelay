import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, gitRefLine, gitRefLines } from "./git.ts";
import { isCommit } from "./store.ts";

const exec = promisify(execFile);

export interface BranchStatusOptions {
  cwd: string;
  branch?: string;
  github?: boolean;
  repo?: string;
  signal?: AbortSignal;
}

async function gh(cwd: string, args: string[], signal?: AbortSignal, host?: string): Promise<unknown> {
  signal?.throwIfAborted();
  try {
    const { stdout } = await exec("gh", args, {
      cwd,
      signal,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", ...(host ? { GH_HOST: host } : {}) },
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as Error & { stderr?: string };
    throw new Error(`GitHub CLI: ${failure.stderr?.trim() || failure.message}`, { cause: error });
  }
}

export async function branchStatus(options: BranchStatusOptions) {
  const { cwd, signal } = options;
  const status = (
    await git(
      cwd,
      ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
      signal,
      "paths",
    )
  ).split("\0");
  const header = (name: string) => status.find((line) => line.startsWith(`# branch.${name} `))?.slice(name.length + 10);
  const head = header("oid");
  const current = header("head");
  let currentBranch = current ?? null;
  let nonBranchHead = false;
  if (current === "(detached)" || current === "(null)") {
    const symbolicHead = async () => {
      try {
        return gitRefLine(await git(cwd, ["symbolic-ref", "-q", "HEAD"], signal, "paths"));
      } catch (error) {
        signal?.throwIfAborted();
        const cause = (error as Error & { cause?: { code?: unknown; stderr?: Buffer | string } }).cause;
        if (cause?.code === 1 && !cause.stderr?.toString()) return null;
        throw error;
      }
    };
    const first = await symbolicHead();
    const check = (
      await git(
        cwd,
        ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
        signal,
        "paths",
      )
    ).split("\0");
    const second = await symbolicHead();
    const expected =
      first === null ? "(detached)" : first.startsWith("refs/heads/") ? first.slice("refs/heads/".length) : "(null)";
    if (
      first !== second ||
      current !== expected ||
      !check.includes(`# branch.head ${current}`) ||
      !check.includes(`# branch.oid ${head}`)
    ) {
      throw new Error("HEAD changed while reading worktree status; retry.");
    }
    nonBranchHead = first !== null && !first.startsWith("refs/heads/");
    currentBranch = first?.startsWith("refs/heads/") ? first.slice("refs/heads/".length) : null;
  }
  const worktree = {
    branch: currentBranch,
    commit: isCommit(head) ? head : null,
    dirty: status.some((line) => /^[12u?] /.test(line)),
  };
  const branch = options.branch ?? worktree.branch;
  if (!branch)
    throw new Error(
      `${nonBranchHead ? "HEAD does not point to a local branch" : "Detached HEAD"}: choose --branch NAME to monitor a local/GitHub branch.`,
    );
  const ref = `refs/heads/${branch}`;
  await git(cwd, ["check-ref-format", ref], signal);
  const rows = gitRefLines(
    await git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "--", ref], signal, "paths"),
  );
  const row = rows.map((line) => line.split("\0")).find(([name]) => name === ref);
  const commit = row?.[1] ?? null;
  const upstream = row?.[2] || null;
  let tracking: { ref: string; commit: string | null; ahead: number | null; behind: number | null } | null = null;
  if (upstream) {
    const upstreamRows = gitRefLines(
      await git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", "--", upstream], signal, "paths"),
    );
    const upstreamCommit =
      upstreamRows.map((line) => line.split("\0")).find(([name]) => name === upstream)?.[1] ?? null;
    tracking = { ref: upstream, commit: upstreamCommit, ahead: null, behind: null };
    if (upstreamCommit && commit) {
      const counts = (
        await git(cwd, ["rev-list", "--left-right", "--count", `${commit}...${upstreamCommit}`, "--"], signal)
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      tracking.ahead = counts[0];
      tracking.behind = counts[1];
    }
  }
  const local = { ref, commit, tracking };
  let github:
    | { repository: string; branch: string; commit: string | null; matchesLocal: boolean | null }
    | { error: string }
    | undefined;
  if (options.github) {
    try {
      if (
        options.repo &&
        !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?\/)?[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_.-]+$/.test(
          options.repo,
        )
      )
        throw new Error("--repo must be [HOST/]OWNER/REPO.");
      if (options.repo?.split("/").length === 3) {
        try {
          new URL(`https://${options.repo.split("/")[0]}`);
        } catch {
          throw new Error("--repo must be [HOST/]OWNER/REPO.");
        }
      }
      const repo = (await gh(
        cwd,
        ["repo", "view", ...(options.repo ? [options.repo] : []), "--json", "nameWithOwner,url"],
        signal,
      )) as { nameWithOwner?: unknown; url?: unknown };
      if (
        !repo ||
        typeof repo.nameWithOwner !== "string" ||
        !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo.nameWithOwner) ||
        typeof repo.url !== "string"
      )
        throw new Error("Invalid GitHub repository response.");
      const url = new URL(repo.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid GitHub repository URL.");
      const pages = await gh(
        cwd,
        [
          "api",
          ...(url.port ? [] : ["--hostname", url.hostname]),
          "--method",
          "GET",
          "--paginate",
          "--slurp",
          `repos/${repo.nameWithOwner}/git/matching-refs/heads/${encodeURIComponent(branch)}`,
        ],
        signal,
        url.port ? url.host : undefined,
      );
      if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("Invalid GitHub references response.");
      const refs = pages.flat();
      if (
        !refs.every(
          (item) => item && typeof item.ref === "string" && item.object?.type === "commit" && isCommit(item.object.sha),
        )
      )
        throw new Error("Invalid GitHub branch response.");
      // The API returns prefix matches; only an exact ref identifies this branch.
      const remoteCommit: string | null = refs.find((item) => item.ref === ref)?.object.sha ?? null;
      github = {
        repository: repo.url,
        branch,
        commit: remoteCommit,
        matchesLocal: commit && remoteCommit ? commit === remoteCommit : null,
      };
    } catch (error) {
      signal?.throwIfAborted();
      github = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { type: "worktree.branch-status", worktree, local, ...(github ? { github } : {}) };
}
