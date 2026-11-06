import { z } from "zod";
import { gh } from "./branch-status.ts";
import { gitRefLines } from "./git.ts";
import { hash } from "./store.ts";
import { importRefs, observationGit, type Revision } from "./conflicts.ts";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const name = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const repoSchema = z.object({
  full_name: name,
  fork: z.boolean(),
  parent: z.object({ full_name: name }).optional(),
  source: z.object({ full_name: name }).optional(),
});
const prSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  head: z.object({ ref: z.string(), sha, repo: z.object({ full_name: name }).nullable() }),
  base: z.object({ ref: z.string(), sha, repo: z.object({ full_name: name }) }),
});

export function githubSource(source: string): { host: string; repository: string } | undefined {
  if (!source.startsWith("https://")) return;
  const url = new URL(source);
  const repository = url.pathname.slice(1);
  if (url.username || url.password || url.search || url.hash || !name.safeParse(repository).success) return;
  return { host: url.host, repository };
}

async function api(host: string, endpoint: string, paged: boolean, signal?: AbortSignal) {
  return gh(
    process.cwd(),
    ["api", "--hostname", host, "--method", "GET", ...(paged ? ["--paginate", "--slurp"] : []), endpoint],
    signal,
    host,
  );
}

export async function resolveGitHubSource(source: string, signal?: AbortSignal): Promise<string> {
  const parsed = githubSource(source);
  if (!parsed) throw new Error("GitHub observation needs an HTTPS HOST/OWNER/REPO source.");
  const repo = repoSchema.parse(await api(parsed.host, `repos/${parsed.repository}`, false, signal));
  return `https://${parsed.host}/${(repo.source?.full_name ?? repo.parent?.full_name ?? repo.full_name).toLowerCase()}`;
}

export async function observeRemotes(
  observer: string,
  remotes: { url: string; source: string }[],
  signal?: AbortSignal,
): Promise<CloudSnapshot> {
  const revisions: Revision[] = [];
  const errors: string[] = [];
  for (const remote of remotes) {
    try {
      const prefix = hash(remote.source);
      await importRefs(observer, remote.url, prefix, signal);
      const start = `refs/relay/${prefix}/heads/`;
      const rows = gitRefLines(
        await observationGit(observer, ["for-each-ref", "--format=%(refname)%00%(objectname)", start], signal, "paths"),
      ).filter(Boolean);
      for (const row of rows) {
        const [name, commit] = row.split("\0");
        sha.parse(commit);
        const ref = `refs/heads/${name.slice(start.length)}`;
        revisions.push({ id: `${remote.source}:${ref}`, kind: "remote", repository: remote.source, ref, commit });
      }
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(`${remote.source}: ${(error as Error).message}`);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    repositories: remotes.map((remote) => remote.source),
    revisions,
    errors,
  };
}

export const cloudSnapshotSchema = z.object({
  checkedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  repositories: z.array(z.string().min(1)),
  revisions: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["branch", "remote", "worktree", "index", "pr"]),
      repository: z.string().min(1),
      ref: z.string().min(1),
      commit: sha,
      root: z.string().optional(),
      base: sha.optional(),
      url: z.string().url().optional(),
    }),
  ),
  errors: z.array(z.string()),
});
export type CloudSnapshot = z.infer<typeof cloudSnapshotSchema>;

/** API metadata and fetched objects are pinned separately; a mismatch is an error, never a clean result. */
export async function observeGitHub(observer: string, source: string, signal?: AbortSignal): Promise<CloudSnapshot> {
  const parsed = githubSource(source);
  if (!parsed) throw new Error("Invalid GitHub source.");
  const repositories = new Set([parsed.repository]);
  const revisions: Revision[] = [];
  const errors: string[] = [];
  try {
    const pages = z
      .array(z.array(z.object({ full_name: name })))
      .parse(await api(parsed.host, `repos/${parsed.repository}/forks?per_page=100`, true, signal));
    for (const fork of pages.flat()) repositories.add(fork.full_name);
  } catch (error) {
    signal?.throwIfAborted();
    errors.push(`Fork discovery: ${(error as Error).message}`);
  }
  for (const repository of repositories) {
    const url = `https://${parsed.host}/${repository}`;
    try {
      if (repository !== parsed.repository) {
        const pages = z
          .array(z.array(z.object({ full_name: name })))
          .parse(await api(parsed.host, `repos/${repository}/forks?per_page=100`, true, signal));
        for (const fork of pages.flat()) repositories.add(fork.full_name);
      }
      const branches = z
        .array(z.array(z.object({ name: z.string().min(1), commit: z.object({ sha }) })))
        .parse(await api(parsed.host, `repos/${repository}/branches?per_page=100`, true, signal))
        .flat();
      const pulls = z
        .array(z.array(prSchema))
        .parse(await api(parsed.host, `repos/${repository}/pulls?state=open&per_page=100`, true, signal))
        .flat();
      const prefix = hash(url);
      await observationGit(
        observer,
        [
          "-c",
          "credential.helper=!gh auth git-credential",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--",
          `${url}.git`,
          `+refs/heads/*:refs/relay/cloud/${prefix}/heads/*`,
          ...pulls.map((pull) => `+refs/pull/${pull.number}/head:refs/relay/cloud/${prefix}/pull/${pull.number}`),
        ],
        signal,
        undefined,
        { GIT_ALLOW_PROTOCOL: "https" },
      );
      for (const branch of branches) {
        await observationGit(observer, ["cat-file", "-e", `${branch.commit.sha}^{commit}`], signal);
        revisions.push({
          id: `${url}:refs/heads/${branch.name}`,
          repository: url.toLowerCase(),
          kind: "remote",
          ref: `refs/heads/${branch.name}`,
          commit: branch.commit.sha,
        });
      }
      for (const pull of pulls) {
        const expectedUrl = `${url}/pull/${pull.number}`;
        if (pull.html_url.toLowerCase() !== expectedUrl.toLowerCase()) throw new Error("Unexpected PR URL.");
        await observationGit(observer, ["cat-file", "-e", `${pull.head.sha}^{commit}`], signal);
        await observationGit(observer, ["cat-file", "-e", `${pull.base.sha}^{commit}`], signal);
        revisions.push({
          id: expectedUrl,
          repository: `https://${parsed.host}/${pull.head.repo?.full_name ?? repository}`.toLowerCase(),
          kind: "pr",
          ref: `refs/heads/${pull.head.ref}`,
          commit: pull.head.sha,
          base: pull.base.sha,
          url: expectedUrl,
        });
      }
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(`${url}: ${(error as Error).message}`);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    repositories: [...repositories].map((repository) => `https://${parsed.host}/${repository}`),
    revisions,
    errors,
  };
}
