# MCP integration

GitRelay 0.2 is a stdio MCP server. It has no client-specific hook installation or
plugin marketplace step. Configure the same server command in a compatible MCP
host, then use the tool workflow in [shared messages](shared-messages.md).

## Local source checkout

```sh
npm ci --ignore-scripts
npm run build
codex mcp add git-relay -- node /absolute/path/to/GitRelay/dist/mcp/main.js --cwd /absolute/path/to/worktree
```

For another stdio host, use `node` as the command with the same absolute entry
path and optional `--cwd` arguments. Use an absolute path rather than relying on
the host's working directory. Node 22.19+ and Git must be available on its PATH.

The executable `git-relay` starts the same server when the new npm release is
installed. Version 0.2.0 in this checkout is not a claim that it is published.

## State and environment

`WORKTREE_SYNC_STATE_DIR` selects the existing shared local state root. If omitted,
the engine uses XDG_STATE_HOME when absolute, or its established default under
`~/.local/state/worktree-agent-sync`. Independent clients sharing a repository
must use the same root to coordinate. `WORKTREE_MAIN_REF` can set the default
full monitored branch ref. Explicit tool fields select other worktrees or refs.

The server does not load model API credentials. `branch_status` only queries
GitHub when requested with `github=true`. Authorized `track_repository` enables
private fetches of configured remote branches; its `github=true` additionally
enables GitHub fork/PR APIs. gh handles GitHub authentication.

Some hosts require approval for open-world tracking tools, even with
`github=false`. An operator can enable tracking explicitly before the model joins.
If a host filters subprocess environment variables, configure
`WORKTREE_SYNC_STATE_DIR` explicitly in the MCP server's `env`, not only in the
host launcher environment.

## Host lifecycle and polling

The MCP connection owns server shutdown. EOF, SIGINT, SIGTERM and a broken stdout
abort domain operations and release owned locks.
Subscriptions persist unless explicitly closed. The shared monitor starts on
join/receive and can fail over between participating MCP processes.

A generic MCP connection is not a lifecycle-hook trigger or a guarantee that an
idle model will process a notification. Joined connections receive
`notifications/resources/updated` for the returned inbox URI, and automatic
coordination reports via `notifications/message` (SDK logging compatibility;
logging is deprecated in the 2026 protocol). The connection-bound inbox resource
is the non-logging read path. Read/notification delivery never acknowledges events.
Hosts ignoring notifications should poll `receive_messages` at work checkpoints,
then explicitly acknowledge accepted batches. Do not claim model injection or
wake-up support from transport delivery. See [coordination](coordination.md).

All commands' stdout is reserved for MCP JSON-RPC, except `--help` and `--version`
when explicitly invoked outside a protocol session. Send diagnostics to stderr.

## Embedding

The package root exports `createGitRelayServer({cwd?, signal?, onDiagnostic?})`,
which returns `{server, close}`. Serve its `server` using a compatible MCP
transport, and await `close()` when the connection ends. Repository/storage deep
imports from former releases are no longer public exports.

## Protected synchronization and recovery

`sync_branch` is a one-shot explicit operation. It uses the existing native Git
locks, verifies the selected branch/worktree and preserves dirty or diverged
work. A blocked or interrupted operation must be inspected; do not bypass it
with reset, stash, rebase, or automatic retry. Retain lock/journal evidence when
an outcome is uncertain. See [maintenance](maintenance.md).

## Distribution

GitRelay currently uses local filesystem access and should be configured as a
local stdio service. A remote transport alone would not grant access to a user's
local worktrees. This refactor does not deploy a remote multi-user service or
publish to a plugin directory.
