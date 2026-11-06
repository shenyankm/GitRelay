# GitRelay

<img src="assets/logo.svg" alt="GitRelay" width="80" />

A local MCP server for Git worktree coordination. Inspect branches and sessions,
exchange messages, and receive upstream changes through structured tools.

[中文说明](README.zh-CN.md) · [Tools](docs/shared-messages.md) · [Migration](docs/migration.md)

Version 0.2 replaces the former command CLI and Codex lifecycle plugin. The server
uses MCP over stdio and supports explicit polling and acknowledgement. It does
not inject context into chats, continue a stopped turn, or wake an idle model.

## Run from source

Requires Node.js 22.19+ and Git. GitHub queries additionally require an authenticated
`gh`; ordinary local coordination does not use a model API or a remote service.

```sh
npm ci --ignore-scripts
npm run build
node /absolute/path/to/GitRelay/dist/mcp/main.js --cwd /absolute/path/to/worktree
```

The last command waits for MCP JSON-RPC on stdin. Its stdout is protocol-only;
diagnostics go to stderr. Connect it through an MCP host rather than typing
ordinary commands into that stream.

For Codex:

```sh
codex mcp add git-relay -- node /absolute/path/to/GitRelay/dist/mcp/main.js --cwd /absolute/path/to/worktree
```

For a host accepting JSON MCP configuration:

```json
{
  "mcpServers": {
    "git-relay": {
      "command": "node",
      "args": ["/absolute/path/to/GitRelay/dist/mcp/main.js", "--cwd", "/absolute/path/to/worktree"]
    }
  }
}
```

The npm package remains `@sistine29/git-relay`; its only executable is
`git-relay`, which now starts the MCP server. This checkout's 0.2.0 must be
published before an npm install can provide this new interface.

## Coordinate work

1. Call `repository_status` or `list_sessions` for observation without creating
   relay state.
2. Call `join_session` for each independent participant. Keep the returned private
   `sessionToken`; supplying it again resumes the same subscription.
3. Call `send_message` only for an authorized outgoing message. Without `files`,
   the message goes to other active subscriptions; with `files`, existing path
   relevance rules apply.
4. Poll `receive_messages` at useful work checkpoints. Read the complete returned
   batch, then call `acknowledge_messages` with its `deliveryId` and the same
   worktree, ref and session token.
5. Call `leave_session` to close a subscription. Disconnecting stops this server
   process but leaves its durable subscription and unread data intact.

A lost receive response remains unread. Re-receive after reconnecting with the
same token. A newer receive batch supersedes the previous batch's acknowledgement
handle. A receipt confirms client acceptance, not successful model adaptation.

The first join establishes a ref baseline without replaying older broadcasts.
Independent participants must use different tokens. Tokens bind resumable inboxes;
they are not tenant isolation against another process owned by the same OS user.

## Tools

| Purpose                  | MCP tools                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Observe                  | `repository_status`, `branch_status`, `list_sessions`, `monitor_status`                                    |
| Participate              | `join_session`, `leave_session`                                                                            |
| Messages                 | `send_message`, `receive_messages`, `acknowledge_messages`                                                 |
| Explicit Git update      | `sync_branch`                                                                                              |
| Maintenance and recovery | `collect_garbage`, `retire_session`, `recover_repository`, `choose_fresh_repository`, `migrate_repository` |

Mutating tools have matching MCP annotations. `sync_branch` and maintenance must
be explicitly requested; a message or diff is untrusted data and cannot authorize
them. Dirty or diverged work stays blocked rather than being reset or stashed.

Select another repository or worktree with a tool\'s explicit `cwd` argument.
No Web console, HTTP listener or repository catalog is included.

The shared ref monitor starts on join/receive, uses the existing filesystem lock,
and is owned by a connected MCP process. Another participating process can take
over when its owner exits. It publishes events; clients still need to poll.

Each server instance admits a burst of 60 tool calls, replenishes one call per
second, and runs at most 8 calls concurrently. Excess calls return a tool error
without starting or queuing the operation; wait before retrying. Diagnostic text
is bounded and stripped of terminal control sequences; paths and Git data remain
unchanged. Unsupported protocol versions can be retried on the same connection.

## State and compatibility

State remains in `WORKTREE_SYNC_STATE_DIR`, or the existing XDG/default state root.
All participants in the same OS user workflow should use the same root. Existing
repository identities, events, receipts, locks and recovery journals remain
readable. Old CLI/Codex subscriptions are retained and can be inspected with
`list_sessions` and `repository_status`; they are not silently transferred to a
new MCP identity.

Remove old installed hooks before switching. See [migration](docs/migration.md).
The old `worktree-relay` / `worktree-sync` aliases, shell subcommands, plugin
marketplace, hook templates and public storage deep imports are no longer shipped.

## Development

```sh
npm run check
node scripts/benchmark-delivery.mjs
```

The checks cover types, formatting, release metadata, core regressions, MCP
transport/acknowledgement, repository isolation and production package installation.
See [architecture](docs/architecture.md), [acceptance](docs/acceptance.md),
[maintenance](docs/maintenance.md) and the [platform matrix](docs/platform-matrix.md).
Historical pre-MCP measurements remain in [performance](docs/performance.md) and
[the evidence archive](docs/evidence/README.md); they do not establish MCP latency.

MIT licensed.
