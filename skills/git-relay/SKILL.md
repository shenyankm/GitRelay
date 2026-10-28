---
name: git-relay
description: Inspect branch status and worktrees, and explain automatic native-session coordination. Start a separate status watch only when requested.
---

# GitRelay

Resolve `../../dist/cli/main.js` relative to this skill directory and invoke it with Node from the user's target worktree. If using an unbuilt source checkout, build the package first. Do not change cwd to the plugin directory.

For a one-time overview, run the bundled CLI's `status --format markdown` and `git worktree list --porcelain`. Add `--github` when cloud status is requested; this requires authenticated `gh` on PATH. Use `--branch NAME` for another short branch name and `--repo [HOST/]OWNER/REPO` when the user specifies a repository or a fork makes inference ambiguous. Report a missing dependency or authentication error without interpreting it as branch deletion.

Distinguish the current worktree from the selected monitored branch. Ahead/behind uses cached tracking refs; GitHub commit equality does not determine who is ahead. Report errors as unknown state. Do not fetch or change branches merely to produce a status report.

Start `status --watch --no-auto-sync --format markdown` only when continuous monitoring is requested. Add `--github` if requested; default cloud polling is 30 seconds. Keep the process handle so the user can stop it. Starting read-only monitoring does not stop another auto-sync process. Do not claim a snapshot is live or persist an unattended automation implicitly.

For authorized synchronization, read [the sync skill](../git-relay-sync/SKILL.md). For mailbox notifications, use [coordination](../worktree-coordination/SKILL.md). See [integrations](../../docs/integrations.md) for output fields and host limits.
