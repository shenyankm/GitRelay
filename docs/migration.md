# Migrating to GitRelay 0.2 MCP

This is a breaking interface change. The local event/receipt storage remains;
the old shell subcommands, compatibility executable aliases, public core deep
imports, Codex hooks, installer and plugin marketplace are removed.

## Before upgrading an existing installation

1. Finish or inspect unread work under the old native subscriptions. Keep the
   original state root and repository identity markers.
2. If managed hooks were installed by 0.1.2, use that version's uninstall before
   upgrading, for example `npx --yes @sistine29/git-relay@0.1.2 uninstall --platform codex`.
   Review its result; it preserves user-owned configuration and uncertain state.
3. If installed as a local Codex plugin, remove `git-relay@git-relay-local` through
   Codex's plugin manager. Remove any independently configured duplicate hooks
   only after identifying their owner. Restart the host afterwards.

The refactor does not edit your normal Codex configuration or silently uninstall
an existing global runtime. Do not leave old hooks pointing at the new executable:
`git-relay hook codex` is no longer a valid command.

## Connect MCP

Build this checkout, then configure a stdio server as described in
[integration](integrations.md). The source version is 0.2.0; publishing npm or a
public listing is a separate action.

Call `join_session` once for each logical participant. Save its private token and
resume with the same token after reconnect. Do not put one shared token in every
agent's configuration. New MCP identities do not assume an old native session ID.
Old subscriptions and unread records remain on disk; there is no automatic inbox
transfer or automatic acknowledgement. Use `list_sessions` and
`repository_status` to inspect existing records, then explicitly retire a listed
subscription after reviewing its data.

## Workflow changes

| Former behavior                                   | MCP behavior                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| Hook-driven automatic enrollment                  | Explicit `join_session`                                           |
| Context injection after tools / Stop continuation | Client polls `receive_messages` at work checkpoints               |
| Output completion confirms delivery               | Explicit `acknowledge_messages` after accepting the batch         |
| Codex process scanner owns the daemon             | Connected participating MCP processes own monitoring and failover |
| CLI status / synchronization                      | `branch_status` / explicit `sync_branch` tools                    |

The Web console, HTTP listener and catalog tools are removed. Select repositories
with explicit `cwd` arguments. Existing saved catalog files are left untouched;
Git repositories, messages and receipts are not deleted.

Dirty-work protection, native Git locking, publication recovery, unread retention,
receipt validation, path relevance and safe GC remain core contracts. MCP does
not provide exactly-once model processing or guarantee wake-up of idle models.
