---
name: gitbeacon-setup
description: Diagnose or set up the gitbeacon local Codex plugin and MCP connection, including missing prerequisites, duplicate registrations and hook trust. Setup does not enable repository coordination.
---

Check the installed plugin and report a concrete next step. Explicit user instructions take precedence over this workflow.

In code mode, forward MCP output with `text(result.structuredContent ?? result)` so results are shown once and errors remain visible.

1. Check Node >=22.19, Git (>=2.38 for merge diagnosis), and `codex --version`. CLI 0.167.0 is the first acceptance baseline, not a guarantee for other versions. Check `gh` authentication only if GitHub observation is requested; do not print credentials.
2. Inspect `codex plugin list --json` and `codex mcp list --json` without echoing sensitive configuration. Identify plugin-provided and manually registered gitbeacon instances, including namespaced server names. If both are active, explain which entry to disable/remove using native Codex commands. Do not automatically edit configuration, remove an entry or delete state.
3. Discover the actual exposed gitbeacon tools; do not assume a fixed namespaced tool prefix. For the user's target worktree, call `repository_status` with an explicit absolute `cwd`. A non-Git directory or missing entry is an actionable error, not evidence that coordination is active. This check must not join, track, receive, acknowledge or initialize collaboration state.
4. Explain that non-managed hooks require normal review in `/hooks`; never bypass trust. Hooks are optional reminders, not background receivers. If the MCP entry is missing, rebuild from the original source checkout with `npm ci --ignore-scripts` and `npm run build:plugin`, then use the local marketplace installation commands in that checkout's integration guide. Do not install dependencies inside Codex's plugin cache.
5. Report available, missing prerequisite, duplicate registration, or hooks awaiting review, with the affected component and next step. State untested host/platform behavior honestly.

The plugin's generated `.mcp.json` contains an absolute Node/source entry. The original source checkout and its dependencies must remain available. Rebuild/reinstall after moving it or changing configured environment. Coordination state uses the existing shared `GITBEACON_STATE_DIR` or core default, independently of plugin cache removal. Installing or diagnosing the plugin does not authorize tracking, sending messages, synchronization or maintenance.
