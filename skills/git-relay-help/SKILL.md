---
name: git-relay-help
description: Explain GitRelay commands, Codex installation, skills, monitoring modes, and troubleshooting. Use when the user asks for GitRelay help or why its plugin or hooks are not visible.
---

# GitRelay Help

Give a concise answer tailored to the question. Resolve bundled resources relative to this skill directory; the CLI is `../../dist/cli/main.js` and docs are under `../../docs/`. Inspect installed/source state before claiming capabilities are currently enabled.

| Need                                               | Entry point                                                |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Local/cloud status and worktree inventory          | [GitRelay](../git-relay/SKILL.md)                          |
| Requested fast-forward sync or disabling a monitor | [GitRelay Sync](../git-relay-sync/SKILL.md)                |
| Upstream notifications and agent messages          | [Worktree Coordination](../worktree-coordination/SKILL.md) |
| Installation, App actions, hooks, host limitations | [Integrations](../../docs/integrations.md)                 |
| Rename, aliases, refreshing the installed plugin   | [Migration](../../docs/migration.md)                       |
| Leave/join, safe GC, daemon lifecycle              | [Maintenance](../../docs/maintenance.md)                   |

A plugin card requires a registered marketplace and installed plugin. Hook files or App action configuration alone do not create it. A source edit does not refresh the installed cache: rebuild the plugin and reinstall when the user requests an update. Check CLI installation status and hook discovery separately from actual App rendering. Hook trust remains the host's normal review flow.

Native root sessions enroll automatically unless explicitly disabled. On macOS/Linux the native clients start one shared daemon per state root, and it stops after the last `codex`/`opencode` process exits. Existing clients must reload updated code.

`watch` receives mailbox events, `status --watch` monitors branch state, and `daemon` centralizes local ref checks and safe cleanup. Auto-sync defaults off. An idle hook-only Codex session waits for the next hook; installing a plugin does not make it wake automatically. A status page is a snapshot, not a persistent dashboard.

Help does not itself authorize starting services, synchronizing branches, sending messages, or cleaning state.
