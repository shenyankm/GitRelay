# MCP integration

gitbeacon 0.2 is a stdio MCP server with an optional [local Codex plugin](plugin.md)
combining skills and reminder hooks. Configure the server directly in any compatible
MCP host, or install the plugin in Codex; avoid activating both entries together.
Then use the tool workflow in [shared messages](shared-messages.md).

## Local source checkout

Run these commands from the gitbeacon source checkout:

```sh
npm ci --ignore-scripts
npm run build
codex mcp add gitbeacon -- node /absolute/path/to/gitbeacon/dist/mcp/main.js --cwd /absolute/path/to/worktree
```

For another stdio host, use `node` as the command with the same absolute entry
path and optional `--cwd` arguments. Use an absolute path rather than relying on
the host's working directory. Node 22.19+ and Git must be available on its PATH;
actual merge diagnosis needs Git 2.38+.

The checkout is a private Node.js project, not an installable gitbeacon npm
package. npm remains the dependency/build/test tool. There is no package-provided
global executable, install-time build hook or package-name SDK entry; run the
built JavaScript entry directly.

## State and environment

`GITBEACON_STATE_DIR` selects the shared local state root. If omitted,
the engine uses XDG_STATE_HOME when absolute, or its established default under
`~/.local/state/gitbeacon`. Independent clients sharing a repository
must use the same root to coordinate. `GITBEACON_MAIN_REF` can set the default
full monitored branch ref. Explicit tool fields select other worktrees or refs.

The server does not load model API credentials. `branch_status` only queries
GitHub when requested with `github=true`. Authorized `track_repository` enables
private fetches of configured remote branches; its `github=true` additionally
enables GitHub fork/PR APIs. gh handles GitHub authentication.

Some hosts require approval for open-world tracking tools, even with
`github=false`. An operator can enable tracking explicitly before the model joins.
If a host filters subprocess environment variables, configure
`GITBEACON_STATE_DIR` explicitly in the MCP server's `env`, not only in the
host launcher environment.

## Host lifecycle and polling

The MCP connection owns server shutdown. EOF, SIGINT, SIGTERM and a broken stdout
abort domain operations and release owned locks.
Subscriptions persist unless explicitly closed. Joining, receiving or enabling
tracking starts a shared monitor candidate; ownership can fail over between
connected candidates. Leaving a subscription does not disable source tracking.
Restart the host's MCP server after rebuilding to load updated JavaScript.

A generic MCP connection does not activate an idle model. After joining, subscribe
to the returned inbox URI: MCP 2026-07-28 clients use `subscriptions/listen` with
`resourceSubscriptions: [inboxUri]`; supported 2025-era clients use
`resources/subscribe` and `resources/unsubscribe`. Read the resource after
subscribing and when `notifications/resources/updated` arrives. Dynamic inbox
membership is announced through `notifications/resources/list_changed`.

The server advertises resource subscriptions, not logging. Business notices are
not sent as `notifications/message`. Resource reads and notifications never ACK
events or return a `deliveryId`; receive and explicitly acknowledge an accepted
complete batch. Hosts without subscriptions can poll `receive_messages` at work
checkpoints. See [coordination](coordination.md) and [breaking upgrades](migration.md).

All commands' stdout is reserved for MCP JSON-RPC, except `--help` and `--version`
when explicitly invoked outside a protocol session. Send diagnostics to stderr.

## Embedding

Within a source checkout, `src/mcp/server.ts` defines
`createGitbeaconServer({cwd?, signal?, onDiagnostic?})`; the built equivalent is
`dist/mcp/server.js`. It returns `{server, close}`. Serve its `server` with a
compatible MCP transport and await `close()` when the connection ends. This is
source-level integration, not a published package export or declaration bundle.

## Protected synchronization and recovery

`sync_branch` is a one-shot explicit operation. It uses the existing native Git
locks, verifies the selected branch/worktree and preserves dirty or diverged
work. A blocked or interrupted operation must be inspected; do not bypass it
with reset, stash, rebase, or automatic retry. Retain lock/journal evidence when
an outcome is uncertain. See [maintenance](maintenance.md).

## Deployment boundary

gitbeacon currently uses local filesystem access and should be configured as a
local stdio service. A remote transport alone would not grant access to a user's
local worktrees. This refactor does not deploy a remote multi-user service or
publish to a plugin directory.

## Bounded status and large deliveries

`repository_status` omits retained event bodies by default; request
`includeEvents=true` explicitly when full history is needed. `eventsIncluded`
and `retainedEvents` distinguish omission from an empty repository.

An inline receive stays within 8 KiB. `detailsRequired=true` defers its notification
array to `read_message_details`: read successive UTF-8 byte offsets through
`complete`, parse/accept the reconstructed batch, then ACK. The server refuses
ACK before all detail pages have been read. Inbox resource previews can also
contain only event IDs/kinds; obtain the accepted delivery through receive.
See [message protocol](shared-messages.md). Old clients must add this detail flow
before accepting large batches. Rebuild/restart the MCP server and reinstall
updated plugin skills together.

In Codex code mode, forward `result.structuredContent ?? result` once rather than
printing the entire MCP envelope; this retains error output without duplicating
successful JSON. The server keeps both standard representations for other hosts.
