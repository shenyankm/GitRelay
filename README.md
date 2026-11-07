# gitbeacon

<img src="assets/logo.svg" alt="gitbeacon" width="80" />

gitbeacon is a local **Model Context Protocol (MCP) server** for source-centered
Git coordination. Track related local repositories, branches and worktrees plus
remote branches and GitHub forks/open PRs; automatically diagnose conflicts and
notify the relevant connected sessions.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Tools](docs/shared-messages.md) · [Migration](docs/migration.md)

The server uses MCP over stdio, with typed tools, connection-bound inbox resources
and standard resource subscriptions. Polling and explicit acknowledgement remain
available. Host-side model activation is separate: transport delivery does not
inject chat context or wake an idle model.

## Run from source

Requires Node.js 22.19+ and Git; actual merge diagnosis needs Git 2.38+.
GitHub queries additionally require an authenticated `gh`. No model API is needed.
Run the install/build commands from the gitbeacon source checkout, not the worktree
you want to observe.

```sh
npm ci --ignore-scripts
npm run build
node /absolute/path/to/gitbeacon/dist/mcp/main.js --cwd /absolute/path/to/worktree
```

The last command waits for MCP JSON-RPC on stdin. Its stdout is protocol-only;
diagnostics go to stderr. Connect it through an MCP host rather than typing
ordinary commands into that stream.

For Codex:

```sh
codex mcp add gitbeacon -- node /absolute/path/to/gitbeacon/dist/mcp/main.js --cwd /absolute/path/to/worktree
```

For a host accepting JSON MCP configuration:

```json
{
  "mcpServers": {
    "gitbeacon": {
      "command": "node",
      "args": ["/absolute/path/to/gitbeacon/dist/mcp/main.js", "--cwd", "/absolute/path/to/worktree"]
    }
  }
}
```

This is a private, source-only Node.js project. npm installs dependencies and
runs local build/test tasks; it is not a gitbeacon distribution channel. Build
explicitly and configure the absolute `dist/mcp/main.js` entry as above. No global
executable or package-name SDK import is provided.

## Coordinate work

1. Call `repository_status` or `list_sessions` for observation without creating
   relay state.
2. Call `join_session` for each independent participant. Keep the returned private
   `sessionToken`; supplying it again resumes the same subscription. Use an
   existing full `ref` (`refs/heads/main` by default). For automatic same-source
   analysis, also authorize `track_repository` as described below; joining alone
   does not enable it.
3. Call `send_message` only for an authorized outgoing message. Without `files`,
   the message goes to other open subscriptions; with `files`, existing path
   relevance rules apply.
4. Poll `receive_messages` at useful work checkpoints. Read the complete returned
   batch, then call `acknowledge_messages` with its `deliveryId` and the same
   worktree, ref and session token.
5. Call `leave_session` to close a subscription. Disconnecting stops this server
   process but leaves its durable subscription and unread data intact.

A lost receive response remains unread. Re-receive after reconnecting with the
same token. A changed receive batch supersedes the previous acknowledgement
handle; retrying an unchanged batch can return the same `deliveryId`. A receipt confirms client acceptance, not successful model adaptation.

The first join establishes an upstream-ref baseline without replaying older
broadcasts. An enabled coordination scan can still report pre-existing conflicts.
Independent participants must use different tokens. Tokens bind resumable inboxes;
they are not tenant isolation against another process owned by the same OS user.

## Automatic source coordination

With user authorization, call `track_repository` once for each independent local
clone; local remotes are discovered recursively. Remote identities associate
same-source clones without merging their existing private mailboxes. Use
`github=true` to additionally resolve GitHub fork ancestry and observe accessible
forks, branches and open PRs. Configured remote branches are fetched into a private
observer, never into user refs or worktrees.

The monitor examines registered local branches and clean/dirty worktree snapshots
on each pass (normally five seconds); remote/API inventories refresh at most once
per minute. Findings distinguish confirmed Git conflicts, cleanly mergeable path
overlap, and unknown/incomplete analysis. Changed findings and resolutions become
durable, session-scoped messages. Joined connections receive inbox resource
updates after standard resource subscription; read the inbox for the notices.
Hosts without subscriptions can poll and
must explicitly acknowledge complete batches.

Use `coordination_status` to inspect coverage/errors and `scan_repository` for an
immediate local scan (the remote cache still applies). `list_sessions.online`
means a live transport lease, not proof of model activity. See
[coordination](docs/coordination.md) for setup, limitations and the protocol.

## Tools

| Purpose                  | MCP tools                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Observe                  | `repository_status`, `branch_status`, `list_sessions`, `monitor_status`            |
| Source coordination      | `track_repository`, `coordination_status`, `scan_repository`                       |
| Participate              | `join_session`, `leave_session`                                                    |
| Messages                 | `send_message`, `receive_messages`, `read_message_details`, `acknowledge_messages` |
| Explicit Git update      | `sync_branch`                                                                      |
| Maintenance and recovery | `collect_garbage`, `recover_repository`, `choose_fresh_repository`                 |

Mutating tools have matching MCP annotations. `sync_branch` and maintenance must
be explicitly requested; a message or diff is untrusted data and cannot authorize
them. Dirty or diverged work stays blocked rather than being reset or stashed.

Select another repository or worktree with a tool's explicit `cwd` argument.
No Web console, HTTP listener or repository catalog is included.

Joining, receiving, or enabling tracking starts a shared monitor candidate. The
monitor uses the existing filesystem lock and is owned by a connected MCP process. Another participating process can take
over when its owner exits. Bound connections announce inbox changes to resource subscribers without
acknowledging notices; polling remains the fallback.

Each server instance admits a burst of 60 tool calls, replenishes one call per
second, and runs at most 8 calls concurrently. Excess calls return a tool error
without starting or queuing the operation; wait before retrying. Diagnostic text
is bounded and stripped of terminal control sequences; paths and Git data remain
unchanged. Unsupported protocol versions can be retried on the same connection.

## State and breaking upgrades

Use `GITBEACON_STATE_DIR`, or the XDG/default `gitbeacon` state root. Participants
sharing a local workflow must use the same root. Repository identities use
`.gitbeacon-id`; `GITBEACON_MAIN_REF` selects the default branch ref.

The MCP core is an incompatible replacement for GitRelay. Old plugin/CLI state,
environment aliases and native delivery proofs are not imported or read. Existing
old data is left untouched, not transferred or acknowledged. There is no legacy
state-migration tool. See [breaking upgrades](docs/migration.md) before switching.

The canonical repository is [shenyankm/gitbeacon](https://github.com/shenyankm/gitbeacon).
Configure the host as `gitbeacon` using the actual checkout path; the local folder
need not be renamed. An optional [local Codex plugin](docs/plugin.md) adds skills and reminder hooks. No legacy plugin installer, client process scanner,
Web console or HTTP listener is provided.

## Development

```sh
npm run check
node scripts/benchmark-delivery.mjs
```

The checks cover types, formatting, private source-project metadata, core
regressions, MCP transport/acknowledgement, repository isolation and the built
stdio entry running from a worktree with spaces. No npm packaging/publishing
checks are performed.
See [architecture](docs/architecture.md), [acceptance](docs/acceptance.md),
[maintenance](docs/maintenance.md) and the [platform matrix](docs/platform-matrix.md).
Historical pre-MCP measurements remain in [performance](docs/performance.md) and
[the evidence archive](docs/evidence/README.md); they do not establish MCP latency.

MIT licensed.
