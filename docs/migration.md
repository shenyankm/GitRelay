# Breaking upgrade to gitbeacon MCP

`gitbeacon` is a local Model Context Protocol (MCP) server, not a lifecycle plugin
or a shell-command integration. This is a deliberately incompatible source
refactor; old plugin, CLI and native-host state migration is not provided.

## Configure the MCP server

1. Build the source checkout as described in [integration](integrations.md).
2. Remove or disable old plugin/hook and duplicate MCP registrations in your host.
   This checkout does not manage or uninstall client plugins.
3. Register the built `dist/mcp/main.js` entry as `gitbeacon`, using its actual
   absolute path. The canonical GitHub repository is now
   [shenyankm/gitbeacon](https://github.com/shenyankm/gitbeacon); the local checkout
   directory need not be renamed.
4. Restart the host's MCP server and call `join_session` for each participant.
   Save each returned private `sessionToken`; independent participants must not
   share one. Authorize `track_repository` separately for automatic coordination.

## New state namespace

- `GITBEACON_STATE_DIR` selects an absolute shared state directory. The default is
  `$XDG_STATE_HOME/gitbeacon` when XDG_STATE_HOME is absolute, otherwise
  `~/.local/state/gitbeacon`.
- `GITBEACON_MAIN_REF` selects the default full branch ref.
- `GITBEACON_REPOSITORY_IDS` supplies explicit identities for read-only Git
  common directories; otherwise `.gitbeacon-id` records the repository identity.
- Inbox resources use `gitbeacon://inbox/<public-session-key>`; discover the URI
  returned by the current connection rather than inventing one.

The previous `WORKTREE_SYNC_*` / `WORKTREE_MAIN_REF` environment variables,
`.git-relay-id` marker and `worktree-agent-sync` state directory are not read.
Old private handles, inbox URIs and receipts are not automatically transferred.
Do not point the new server at an old state directory expecting compatibility.
Review and retain old unread data separately; the refactor does not delete it or
mark it delivered. `migrate_repository`, `retire_session` and native delivery-proof recovery have
been removed, not hidden behind a compatibility flag.

## MCP notification and acceptance workflow

Use standard resource subscriptions for automatic change notices:
`subscriptions/listen` on MCP 2026-07-28, or `resources/subscribe` on supported
2025-era connections. Read the bound inbox resource after subscribing and when
it changes. No business messages are sent through `notifications/message`.
Hosts without resource subscriptions can poll `receive_messages` instead.

Neither a resource read nor a change notification acknowledges delivery. Accept
an entire `receive_messages` batch with `acknowledge_messages` using its exact
worktree, ref, token and `deliveryId`. MCP transport delivery does not prove that
a model has understood a message or wake an idle model.

The source-level factory is `createGitbeaconServer` with
`GitbeaconServerOptions`. Tools and the Git coordination engine retain their
validation, dirty-work protection, journaled recovery and explicit authorization
requirements. See [shared messages](shared-messages.md) and
[maintenance](maintenance.md).

Historical evidence and changelog entries keep their original names and source
fingerprints. They are not compatibility claims for this checkout.
