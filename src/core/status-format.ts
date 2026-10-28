import type { branchStatus } from "./branch-status.ts";
import type { SyncResult } from "./branch-sync.ts";

type Status = Awaited<ReturnType<typeof branchStatus>> & { sync?: SyncResult };

const cell = (value: string) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\\`*_[\]|]/g, "\\$&")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function formatBranchStatus(status: Status): string {
  const tracking = status.local.tracking;
  const cloud = status.github;
  const rows = [
    ["Worktree branch", status.worktree.branch ?? "HEAD is not on a local branch"],
    ["Worktree", status.worktree.dirty ? "Uncommitted or untracked changes" : "Clean"],
    ["Monitored branch", status.local.ref],
    ["Local commit", status.local.commit ?? "Missing / no commits yet"],
    ["Upstream", tracking?.ref ?? "Not configured"],
    [
      "Cached comparison",
      tracking?.ahead != null && tracking.behind != null
        ? `Ahead ${tracking.ahead} / behind ${tracking.behind}`
        : "Unknown",
    ],
    [
      "GitHub",
      !cloud
        ? "Query disabled"
        : "error" in cloud
          ? `Query failed: ${cloud.error}`
          : `${cloud.repository} / ${cloud.branch}`,
    ],
    ["Remote commit", cloud && !("error" in cloud) ? (cloud.commit ?? "Branch missing") : "Unknown"],
    [
      "Remote vs. local",
      cloud && !("error" in cloud) && cloud.matchesLocal !== null
        ? cloud.matchesLocal
          ? "Equal"
          : "Different"
        : "Unknown",
    ],
    [
      "Auto-sync for this invocation",
      status.sync
        ? `${status.sync.state}${status.sync.remote ? ` (${status.sync.remote})` : ""}${status.sync.reason ? `: ${status.sync.reason}` : ""}`
        : "Off",
    ],
  ];
  return `# GitRelay\n\nQueried at: ${new Date().toISOString()}\n\n| Item | Status |\n| --- | --- |\n${rows.map(([key, value]) => `| ${key} | ${cell(value)} |`).join("\n")}\n\nThis is a point-in-time snapshot; ahead/behind uses cached local refs. Sync status describes only this invocation, not other monitoring processes.\n`;
}
