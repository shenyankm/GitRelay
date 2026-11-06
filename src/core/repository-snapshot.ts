import { basename } from "node:path";
import { diagnosticMessage } from "./diagnostics.ts";
import { listWorktrees } from "./git.ts";
import { branchStatus } from "./branch-status.ts";
import { daemonStatus } from "./daemon-state.ts";
import { eventsIn, readReceipt, sessionsIn } from "./mailbox.ts";
import { inspectRepository } from "./repository.ts";

/** Observe existing state without initializing identities, polling, or acknowledging delivery. */
export async function repositorySnapshot(cwd: string, signal?: AbortSignal) {
  const { root, common, id, repository: repo } = await inspectRepository(cwd, signal);
  const [worktrees, status, daemon] = await Promise.all([
    listWorktrees(root),
    branchStatus({ cwd: root, signal }).then(
      (value) => ({ value }),
      (error: Error) => ({ error: diagnosticMessage(error) }),
    ),
    daemonStatus(),
  ]);
  const base = {
    capturedAt: new Date().toISOString(),
    repository: { name: basename(root), root, common, id },
    worktrees,
    status,
    daemon: { running: daemon.running, heartbeatAt: daemon.state?.heartbeatAt ?? null },
  };
  if (!repo) return { ...base, initialized: false, sessions: [], events: [], retainedEvents: 0 };
  const [sessions, retained] = await Promise.all([sessionsIn(repo), eventsIn(repo, undefined, signal)]);
  const events = [];
  // shortcut: enumerate retained history; introduce a read index if large histories make refresh expensive.
  for (const event of retained.slice(-100).reverse()) {
    signal?.throwIfAborted();
    const delivery = [];
    for (let offset = 0; offset < event.recipients.length; offset += 16) {
      delivery.push(
        ...(await Promise.all(
          event.recipients.slice(offset, offset + 16).map(async (key) => {
            const receipt = await readReceipt(repo, key, event.id);
            return { key, status: receipt?.status ?? "pending", at: receipt?.at ?? null };
          }),
        )),
      );
    }
    events.push({ ...event, delivery });
  }
  return {
    ...base,
    initialized: true,
    sessions: sessions.map(({ activationToken: _token, ...session }) => session),
    events,
    retainedEvents: retained.length,
  };
}
