import { readdir, realpath, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { git, gitPathLine, gitRefLines, listWorktrees } from "./git.ts";
import { inspectRepository, repository, writeRepositoryMetadata, type Repository } from "./repository.ts";
import { sessionsIn, publishCoordination, type Session } from "./mailbox.ts";
import {
  BusyError,
  checkStateDirectory,
  hash,
  isCommit,
  isId,
  readJson,
  stateDirectory,
  withLock,
  writeExclusiveTemporary,
  writeJson,
} from "./store.ts";
import {
  compareRevisions,
  importRefs,
  openObserver,
  worktreeRevisions,
  type Conflict,
  type Revision,
} from "./conflicts.ts";
import {
  cloudSnapshotSchema,
  observeGitHub,
  observeRemotes,
  resolveGitHubSource,
  type CloudSnapshot,
} from "./cloud.ts";
import { diagnosticMessage } from "./diagnostics.ts";

const trackingSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  source: z.string().min(1),
  repository: z.string().min(1),
  root: z.string().min(1),
  github: z.boolean(),
});
export type Tracking = z.infer<typeof trackingSchema>;
interface Member {
  repo: Repository;
  tracking: Tracking;
  error?: string;
}

export async function normalizeSource(
  input: string,
  cwd: string,
  signal?: AbortSignal,
  seen = new Set<string>(),
): Promise<string> {
  let value = input;
  if (/^[^/@:]+@[^/:]+:/.test(value)) value = `ssh://${value.replace(":", "/")}`;
  if (/^(?:https?|ssh|git):\/\//.test(value)) {
    const url = new URL(value);
    if (url.password || (url.protocol !== "ssh:" && url.username) || url.search || url.hash)
      throw new Error("Source URLs must not contain credentials, query strings or fragments.");
    const path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    if (!path || path === "/" || path.includes("..") || /[\u0000-\u0020\u007f]/.test(value))
      throw new Error("Invalid source repository URL.");
    return `https://${url.host.toLowerCase()}${url.hostname === "github.com" ? path.toLowerCase() : path}`;
  }
  if (value.startsWith("file://")) value = fileURLToPath(value);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !isAbsolute(value)) throw new Error("Unsupported source URL scheme.");
  const path = await realpath(resolve(cwd, value));
  const common = gitPathLine(
    await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "paths"),
  );
  const canonical = await realpath(common);
  if (seen.has(canonical)) {
    const chain = [...seen];
    return pathToFileURL(chain.slice(chain.indexOf(canonical)).sort()[0]).href;
  }
  seen.add(canonical);
  const remotes = gitRefLines(await git(canonical, ["remote"], signal, "paths"));
  const parent = ["upstream", "origin"].find((name) => remotes.includes(name));
  if (parent) {
    const url = gitPathLine(await git(canonical, ["remote", "get-url", "--", parent], signal, "paths"));
    const parentRoot = (await listWorktrees(canonical))[0]?.path ?? canonical;
    return normalizeSource(url, parentRoot, signal, seen);
  }
  return pathToFileURL(canonical).href;
}

async function remoteSources(root: string, signal?: AbortSignal) {
  const sources: { name: string; url: string; source: string; local: boolean }[] = [];
  const remotes = gitRefLines(await git(root, ["remote"], signal, "paths")).filter(Boolean);
  const rank = (remote: string) => (remote === "upstream" ? 0 : remote === "origin" ? 1 : 2);
  remotes.sort((a, b) => rank(a) - rank(b));
  for (const remote of remotes) {
    const value = gitPathLine(await git(root, ["remote", "get-url", "--", remote], signal, "paths"));
    const source = await normalizeSource(value, root, signal);
    const local =
      value.startsWith("file://") || (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/@:]+@[^/:]+:/.test(value));
    const url = local
      ? await realpath(resolve(root, value.startsWith("file://") ? fileURLToPath(value) : value))
      : value;
    sources.push({ name: remote, url, source, local });
  }
  return sources;
}

export async function trackRepository(
  cwd: string,
  options: { source?: string; github?: boolean; enabled?: boolean } = {},
  signal?: AbortSignal,
  visited = new Set<string>(),
): Promise<Tracking> {
  const repo = await repository(cwd, signal);
  const existing = await trackingIn(repo);
  if (options.enabled === false) {
    if (!existing) throw new Error("Repository is not tracked.");
    const value = { ...existing, enabled: false };
    await withLock(
      join(repo.directory, "publish.lock"),
      () => writeJson(join(repo.directory, "tracking.json"), value),
      { signal, waitMs: 5000, recoverDeadOwner: true },
    );
    return value;
  }
  const remotes = await remoteSources(repo.root, signal);
  const local = [];
  for (const remote of remotes) {
    if (!remote.local) continue;
    const common = await realpath(
      gitPathLine(await git(remote.url, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal, "paths")),
    );
    const tree = (await listWorktrees(common)).find((tree) => !tree.prunable);
    if (!tree) throw new Error(`Local remote has no accessible repository: ${common}`);
    const found = await inspectRepository(tree.path, signal);
    local.push({
      remote,
      common,
      root: tree.path,
      tracking: found.repository ? await trackingIn(found.repository) : undefined,
    });
  }
  const inherited = local.find((entry) => entry.remote === remotes[0])?.tracking;
  const inheritedOrigin = local.find((entry) => entry.remote.name === "origin")?.tracking;
  let source = options.source
    ? await normalizeSource(options.source, repo.root, signal)
    : (existing?.source ?? inherited?.source ?? remotes[0]?.source ?? pathToFileURL(repo.common).href);
  const github = options.github ?? existing?.github ?? false;
  if (github) source = await resolveGitHubSource(source, signal);
  const tracking: Tracking = {
    version: 1,
    enabled: true,
    source,
    repository:
      inheritedOrigin?.repository ??
      remotes.find((remote) => remote.name === "origin")?.source ??
      remotes[0]?.source ??
      pathToFileURL(repo.common).href,
    root: (await listWorktrees(repo.common))[0]?.path ?? repo.root,
    github,
  };
  await withLock(
    join(repo.directory, "publish.lock"),
    async () => {
      await writeRepositoryMetadata(repo);
      await writeJson(join(repo.directory, "tracking.json"), tracking, () => signal?.throwIfAborted());
    },
    { signal, waitMs: 5000, recoverDeadOwner: true },
  );
  visited.add(repo.common);
  for (const entry of local) {
    if (visited.has(entry.common)) continue;
    if (entry.tracking) {
      visited.add(entry.common);
      continue;
    }
    await trackRepository(entry.root, { source, github: false }, signal, visited);
  }
  return tracking;
}

export async function trackingIn(repo: Repository): Promise<Tracking | undefined> {
  const value = await readJson(join(repo.directory, "tracking.json"), true);
  return value === undefined ? undefined : trackingSchema.parse(value);
}

async function trackedRepositories(signal?: AbortSignal) {
  const directory = join(stateDirectory(), "repos");
  await checkStateDirectory(directory, true);
  const ids = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const members: Member[] = [];
  const errors: { source?: string; message: string }[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    if (!isId(id)) continue;
    const path = join(directory, id);
    let checked = false;
    try {
      await checkStateDirectory(path);
      checked = true;
      const value = await readJson(join(path, "tracking.json"), true);
      if (value === undefined) continue;
      const tracking = trackingSchema.parse(value);
      if (!tracking.enabled) continue;
      try {
        const found = await inspectRepository(tracking.root, signal);
        if (!found.repository || found.id !== id)
          throw new Error(`Tracked repository identity changed: ${tracking.root}`);
        members.push({ repo: found.repository, tracking });
      } catch (error) {
        signal?.throwIfAborted();
        const metadata = z
          .object({
            id: z.literal(id),
            common: z.string().min(1),
            identity: z.string().regex(/^[a-f0-9]{64}$/),
            identitySource: z.enum(["marker", "external"]),
          })
          .parse(await readJson(join(path, "repo.json"), true));
        if (hash([metadata.common, metadata.identity]) !== id) throw new Error("Invalid tracked repository metadata.");
        members.push({
          repo: { ...metadata, root: tracking.root, directory: path },
          tracking,
          error: diagnosticMessage(error),
        });
      }
    } catch (error) {
      signal?.throwIfAborted();
      const message = `Registration ${id}: ${diagnosticMessage(error)}`;
      let source: string | undefined;
      if (checked) {
        try {
          const prior = (await readJson(join(path, "coordination-report.json"), true)) as
            { source?: unknown } | undefined;
          if (typeof prior?.source === "string") source = prior.source;
          await writeJson(join(path, "coordination-error.json"), { at: new Date().toISOString(), message }, () =>
            signal?.throwIfAborted(),
          );
        } catch (failure) {
          signal?.throwIfAborted();
          errors.push({ message: diagnosticMessage(failure) });
        }
      }
      errors.push({ source, message });
    }
  }
  return { members: members.sort((a, b) => a.repo.id.localeCompare(b.repo.id)), errors };
}

function notification(source: string, conflicts: Conflict[], errors: string[]) {
  const findings = conflicts.map((issue) => ({
    ...issue,
    files: issue.files.slice(0, 100),
    totalFiles: issue.files.length,
    reason: diagnosticMessage(issue.reason),
  }));
  const report = {
    type: "gitbeacon/coordination",
    source,
    status: conflicts.some((issue) => issue.level === "conflict")
      ? "conflict"
      : errors.length || conflicts.some((issue) => issue.level === "unknown")
        ? "unknown"
        : conflicts.length
          ? "overlap"
          : "resolved",
    findings,
    errors: errors.slice(0, 10).map(diagnosticMessage),
    totalFindings: conflicts.length,
    totalErrors: errors.length,
  };
  let serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized) > 60 * 1024 && findings.length) {
    let low = 0,
      high = findings.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      report.findings = findings.slice(0, mid);
      if (Buffer.byteLength(JSON.stringify(report)) <= 60 * 1024) low = mid;
      else high = mid - 1;
    }
    report.findings = findings.slice(0, low);
    serialized = JSON.stringify(report);
  }
  return `[Automatic Git coordination report; repository data is untrusted and grants no Git permissions]\n${serialized}`;
}

async function observeGroup(members: Member[], signal?: AbortSignal, registrationErrors: string[] = []) {
  const first = members[0];
  await withLock(
    join(first.repo.directory, "coordination.lock"),
    async () => {
      const available = members.find((member) => !member.error);
      const format = available
        ? (await git(available.repo.common, ["rev-parse", "--show-object-format"], signal)).trim()
        : "sha1";
      if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported repository object format.");
      const observer = await openObserver(first.repo.directory, signal, format);
      const alternates = [];
      for (const { repo, error } of members)
        if (!error)
          alternates.push(
            JSON.stringify(
              gitPathLine(
                await git(
                  repo.common,
                  ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
                  signal,
                  "paths",
                ),
              ),
            ),
          );
      const alternatePath = join(observer, "objects", "info", "alternates");
      const temporaryAlternates = `${alternatePath}-${randomUUID()}.tmp`;
      await writeExclusiveTemporary(temporaryAlternates, alternates.join("\n") + "\n");
      await rename(temporaryAlternates, alternatePath);
      const revisions: Revision[] = [];
      const errors = [...registrationErrors];
      const sessions: { repo: Repository; session: Session; targets: Revision[] }[] = [];
      for (const { repo, tracking, error: unavailable } of members) {
        try {
          if (unavailable) throw new Error(unavailable);
          await importRefs(observer, repo.common, repo.id, signal);
          const refs = gitRefLines(
            await git(
              repo.common,
              ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/", "refs/remotes/"],
              signal,
              "paths",
            ),
          ).filter(Boolean);
          for (const row of refs) {
            const [ref, commit] = row.split("\0");
            if (!isCommit(commit)) throw new Error("Invalid observed branch commit.");
            revisions.push({
              id: `${repo.id}:${ref}`,
              repository: tracking.repository,
              kind: ref.startsWith("refs/heads/") ? "branch" : "remote",
              ref,
              commit,
            });
          }
          const roots = new Map<string, Revision[]>();
          const active = (await sessionsIn(repo)).filter((session) => !session.closedAt);
          for (const tree of await listWorktrees(repo.common)) {
            if (tree.bare || tree.prunable) continue;
            try {
              const snapshots = await worktreeRevisions(observer, tree.path, tracking.repository, signal);
              roots.set(tree.path, snapshots);
              revisions.push(...snapshots);
            } catch (error) {
              signal?.throwIfAborted();
              errors.push(`${tree.path}: ${diagnosticMessage(error)}`);
            }
          }
          for (const session of active) sessions.push({ repo, session, targets: roots.get(session.root) ?? [] });
        } catch (error) {
          signal?.throwIfAborted();
          errors.push(`${tracking.root}: ${diagnosticMessage(error)}`);
          for (const session of (await sessionsIn(repo)).filter((session) => !session.closedAt))
            sessions.push({ repo, session, targets: [] });
        }
      }
      const remotes = new Map<string, { url: string; source: string }>();
      for (const { repo, error: unavailable } of members) {
        if (unavailable) continue;
        try {
          for (const remote of await remoteSources(repo.root, signal))
            if (!remote.local) remotes.set(remote.source, remote);
        } catch (error) {
          signal?.throwIfAborted();
          errors.push(diagnosticMessage(error));
        }
      }
      const remotePath = join(first.repo.directory, "remote-snapshot.json");
      const remoteKey = hash([format, ...[...remotes.keys()].sort()]);
      const rawRemote = await readJson(remotePath, true);
      const previousRemote =
        rawRemote === undefined
          ? undefined
          : z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), snapshot: cloudSnapshotSchema }).parse(rawRemote);
      const remoteAge = previousRemote ? Date.now() - Date.parse(previousRemote.snapshot.checkedAt) : Infinity;
      const remoteSnapshot =
        previousRemote && previousRemote.key === remoteKey && remoteAge >= 0 && remoteAge < 60_000
          ? previousRemote.snapshot
          : await observeRemotes(observer, [...remotes.values()], signal);
      if (remoteSnapshot !== previousRemote?.snapshot)
        await writeJson(remotePath, { key: remoteKey, snapshot: remoteSnapshot });
      revisions.push(...remoteSnapshot.revisions);
      errors.push(...remoteSnapshot.errors);
      let cloud: CloudSnapshot | undefined;
      if (members.some((member) => member.tracking.github)) {
        const path = join(first.repo.directory, "cloud-snapshot.json");
        const raw = await readJson(path, true);
        const cached =
          raw === undefined
            ? undefined
            : z
                .object({
                  source: z.string(),
                  format: z.enum(["sha1", "sha256"]).optional(),
                  snapshot: cloudSnapshotSchema,
                })
                .parse(raw);
        const previous =
          cached?.source === first.tracking.source && (cached.format ?? "sha1") === format
            ? cached.snapshot
            : undefined;
        const age = previous ? Date.now() - Date.parse(previous.checkedAt) : Infinity;
        cloud =
          previous && age >= 0 && age < 60_000
            ? previous
            : await observeGitHub(observer, first.tracking.source, signal);
        if (cloud !== previous) await writeJson(path, { source: first.tracking.source, format, snapshot: cloud });
        revisions.push(...cloud.revisions);
        errors.push(...cloud.errors);
      }
      // Reuse pinned comparisons only within this scan; transient unknowns must be retried.
      const comparisons = new Map<string, Conflict | undefined>();
      const reports = [];
      for (const { repo, session, targets } of sessions) {
        const issues: Conflict[] = [];
        const seen = new Set<string>();
        for (const target of targets)
          for (const incoming of revisions) {
            if (incoming.root === session.root || incoming.id === `${repo.id}:${target.ref}`) continue;
            const key = hash([target.commit, incoming.commit, incoming.kind === "pr" ? incoming.id : ""]);
            if (seen.has(key)) continue;
            seen.add(key);
            const comparison = JSON.stringify([target.commit, incoming.commit, !!target.caseInsensitive]);
            let issue: Conflict | undefined;
            if (comparisons.has(comparison)) {
              const cached = comparisons.get(comparison);
              issue = cached ? { ...cached, target, incoming } : undefined;
            } else {
              issue = await compareRevisions(observer, target, incoming, signal);
              if (issue?.level !== "unknown") comparisons.set(comparison, issue);
            }
            if (issue) issues.push(issue);
            if (
              incoming.kind === "pr" &&
              incoming.base &&
              target.ref === incoming.ref &&
              target.repository === incoming.repository
            ) {
              const base: Revision = { ...incoming, id: `${incoming.id}:base`, ref: "PR base", commit: incoming.base };
              const pullIssue = await compareRevisions(observer, incoming, base, signal);
              if (pullIssue) issues.push(pullIssue);
            }
          }
        const sessionErrors = targets.length ? errors : [...errors, `No readable snapshot for session ${session.key}`];
        const text = notification(first.tracking.source, issues, sessionErrors);
        await publishCoordination(
          repo,
          session,
          first.tracking.source,
          text,
          issues.length > 0 || sessionErrors.length > 0,
          signal,
        );
        reports.push({ key: session.key, issues, errors: sessionErrors });
      }
      const report = {
        checkedAt: new Date().toISOString(),
        source: first.tracking.source,
        repositories: members.map((member) => ({ id: member.repo.id, root: member.tracking.root })),
        revisions,
        remotes: remoteSnapshot,
        cloud,
        errors,
        sessions: reports,
      };
      for (const { repo } of members)
        await writeJson(join(repo.directory, "coordination-report.json"), report, () => signal?.throwIfAborted());
    },
    { signal, recoverDeadOwner: true },
  );
}

export async function scanCoordination(signal?: AbortSignal, source?: string): Promise<void> {
  const groups = new Map<string, Member[]>();
  const registrations = await trackedRepositories(signal);
  for (const member of registrations.members) {
    if (source && member.tracking.source !== source) continue;
    const group = groups.get(member.tracking.source) ?? [];
    group.push(member);
    groups.set(member.tracking.source, group);
  }
  const failures = source ? [] : registrations.errors.map((error) => error.message);
  const scans = await Promise.allSettled(
    [...groups.values()].map(async (group) => {
      try {
        await observeGroup(
          group,
          signal,
          registrations.errors
            .filter((error) => !error.source || error.source === group[0].tracking.source)
            .map((error) => error.message),
        );
        for (const { repo } of group)
          await writeJson(join(repo.directory, "coordination-error.json"), {
            at: new Date().toISOString(),
            message: null,
          });
      } catch (error) {
        signal?.throwIfAborted();
        if (source || !(error instanceof BusyError)) failures.push(diagnosticMessage(error));
        if (!(error instanceof BusyError))
          for (const { repo } of group) {
            try {
              await writeJson(join(repo.directory, "coordination-error.json"), {
                at: new Date().toISOString(),
                message: diagnosticMessage(error),
              });
            } catch (failure) {
              failures.push(diagnosticMessage(failure));
            }
          }
      }
    }),
  );
  signal?.throwIfAborted();
  for (const scan of scans) if (scan.status === "rejected") failures.push(diagnosticMessage(scan.reason));
  if (failures.length) throw new Error(failures.join("\n"));
}

export async function coordinationStatus(cwd: string, signal?: AbortSignal) {
  const { repository: repo } = await inspectRepository(cwd, signal);
  if (!repo) return { tracking: null, report: null };
  const tracking = (await trackingIn(repo)) ?? null;
  const report = (await readJson(join(repo.directory, "coordination-report.json"), true)) as
    { source?: string; checkedAt?: string } | undefined;
  const failure = (await readJson(join(repo.directory, "coordination-error.json"), true)) as
    { at?: string; message?: string | null } | undefined;
  return {
    tracking,
    report: report && report.source === tracking?.source ? report : null,
    ...(failure?.message ? { lastScanError: failure } : {}),
  };
}
