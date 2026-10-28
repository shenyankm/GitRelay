# GitRelay

[English](README.md) | [简体中文](README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [MIT License](LICENSE)

Coordinate **Codex and OpenCode v2** sessions across Git worktrees. GitRelay
delivers relevant upstream changes and agent messages, and reports local or
GitHub branch status.

> **Sessions participate automatically.** On macOS/Linux, the first loaded client
> starts one shared daemon; it stops after the last Codex/OpenCode process exits.

Node.js 22.19+ and Git are required. The runtime has no npm dependencies.
`git-relay` is the package and CLI name; `worktree-relay` and `worktree-sync`
remain CLI aliases.

## Contents

- [Quick start](#quick-start)
- [Automatic sessions](#automatic-sessions)
- [Platform support](#platform-support)
- [Host setup](#host-setup)
  - [Codex plugin](#codex-plugin)
  - [OpenCode v2](#opencode-v2)
- [Commands](#commands)
- [State and safety](#state-and-safety)
- [Development and validation](#development-and-validation)
- [Documentation](#documentation)

## Quick start

```sh
npm ci --ignore-scripts --omit=optional
npm run build
npm install -g /absolute/path/to/GitRelay
git-relay install --dry-run
git-relay install --platform codex --platform opencode
```

Reopen the receiving clients after installation.

The installer configures only the selected clients, preserves foreign or
modified configuration, and keeps owned runtime copies. Codex user hooks need
separate review and trust through `/hooks` before automatic participation. Use
repeated `--platform` or `--skip` to select clients; unknown platforms are
rejected. Uninstall previews and retained-file behavior are documented in
[automatic setup](docs/integrations.md#automatic-setup).

## Automatic sessions

Codex root sessions participate at their first lifecycle hook. OpenCode v2 root
sessions participate when created or prompted. No enable prompt is required.
First enrollment establishes a baseline without replaying earlier broadcasts.

`Disable GitRelay` or `关闭 GitRelay` stops that subscription without acknowledging
unread messages. The saved choice survives resume. `Enable GitRelay` or
`启用 GitRelay` explicitly reopens it; broadcasts while closed are not replayed.
Subagents remain excluded.

On macOS/Linux, a native Codex hook or OpenCode plugin setup starts a shared daemon
for the current user and state root. It checks client processes every five seconds
and exits after no `codex` or `opencode` process remains, allowing lock cleanup to
finish. A new client can start it again. No login service is installed. Existing
clients must reload the updated plugin; merely installing files cannot inject code
into an already running host. See [session lifecycle](docs/integrations.md#automatic-sessions).

## Platform support

| Platform    | Entry point                       | Automatic delivery                                               |
| ----------- | --------------------------------- | ---------------------------------------------------------------- |
| Codex       | Lifecycle hooks or bundled plugin | Context at prompt/tool boundaries; Stop can request continuation |
| OpenCode v2 | Native Promise plugin             | Checks every five seconds; durable host queue handles busy/idle  |

Codex hooks cannot wake an already idle session. OpenCode supports the v2 API;
v1 is not supported. Runtime changes require rebuilding and refreshing the
installed copy. See [integrations](docs/integrations.md) and the
[platform matrix](docs/platform-matrix.md) for trust and verification boundaries.

## Host setup

### Codex plugin

```sh
npm run build:codex-plugin
codex plugin marketplace add /absolute/path/to/GitRelay
codex plugin add git-relay@git-relay-local
codex plugin list --marketplace git-relay-local --json
```

The plugin includes its CLI, one `git-relay` skill, four hook events, docs, and license. Reopen the chat,
review `/hooks`; new sessions participate automatically. Avoid duplicate
plugin/user hooks. A plugin listing or generated hook file does not prove that
the host loaded or trusted it.

The plugin is distributed through a local or repo marketplace. Codex does not
accept lifecycle-hook plugins in its public directory.

Manual hooks: [`src/adapters/codex/hooks.json`](src/adapters/codex/hooks.json).
The plugin variant uses its bundled CLI through `${PLUGIN_ROOT}`. Enabled hooks
can show local branch status; they never fetch, query GitHub, or synchronize
branches automatically.

### OpenCode v2

The installer writes a managed global entry. For a manual project entry, create
`.opencode/plugins/git-relay.ts`:

```ts
export { default } from "/absolute/path/to/GitRelay/dist/adapters/opencode/index.js";
```

Build first, remove duplicate entries, and restart OpenCode. Each receiving
worktree needs an entry. Root sessions participate automatically.

## Commands

| Goal                            | Command                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| Local branch snapshot           | `git-relay status`                                              |
| Live GitHub comparison          | `git-relay status --github`                                     |
| Requested read-only monitoring  | `git-relay status --github --watch`                             |
| Explicit session enrollment     | `git-relay join --agent codex --session NATIVE_ID`              |
| Stop a subscription             | `git-relay leave --agent codex --session NATIVE_ID`             |
| Inspect subscriptions           | `git-relay sessions`                                            |
| Receive once / stream NDJSON    | `git-relay check --session ID` / `git-relay watch --session ID` |
| Preview confirmed-event cleanup | `git-relay gc`                                                  |
| Optional centralized monitoring | `git-relay daemon`                                              |

Use `--cwd /absolute/worktree` and `--ref refs/heads/main` to select the target.
Reuse the actual native session ID. OpenCode manual access also needs the exact
`--instance` from `sessions`; omitting it selects a separate legacy inbox.
Generic CLI output needs a host to route it into a conversation.

To send a coordination message after the receiver has enrolled:

```sh
git-relay send --cwd /project/worktree-A --agent codex --session SENDER_ID \
  --file src/config.ts --message 'The config interface changed; assess impact.'
```

`--file` may repeat; without it the message targets other open subscriptions.
Sending does not subscribe the sender. File overlap is a relevance hint, not
semantic conflict detection. See [shared messages](docs/shared-messages.md).

GitHub queries require an authenticated `gh` executable. Ahead/behind uses
cached local refs; a remote/local commit mismatch alone does not indicate
direction. `watch` receives messages; `status --watch` observes branch
snapshots. Neither starts automatically in an ordinary session.

## State and safety

Worktrees in one repository share events under
`~/.local/state/worktree-agent-sync`, with independent session receipts.
`XDG_STATE_HOME` and an absolute `WORKTREE_SYNC_STATE_DIR` can override the root.
Repository identity prevents a replacement repository from claiming an old
inbox. Explicit migration may be required for older path-based state.

Branch synchronization is opt-in: `status --auto-sync` fetches the configured
upstream and only fast-forwards the currently checked-out, clean branch on
macOS/Linux. Native index/ref locks protect against competing Git writers;
unsupported layouts stay blocked. Interrupted writes can retain recovery locks
and require manual inspection; see the [write protocol](docs/integrations.md#automatic-branch-synchronization).
GitRelay does not provide worktree-management commands. Use Git directly after
checking the target and preserving local work. See [migration](docs/migration.md).

Messages are untrusted data, not authorization to change Git history. Normal
operation deduplicates; crashes or uncertain host acceptance can cause retries.
A receipt confirms transport acceptance, not completed agent work. Cleanup
preserves unread events; `leave` never acknowledges them. Legacy delivery-proof
retention remains so removing old adapters cannot discard uncertain deliveries.
See [maintenance](docs/maintenance.md) for daemon and cleanup operations.

## Development and validation

```sh
npm ci --ignore-scripts --omit=optional
npm run check
npm run benchmark
```

`src/core/` owns Git, state, sessions, and delivery; `src/adapters/` contains
Codex hook handling and the OpenCode plugin; `src/cli/` contains commands and
installation. `dist/` is generated and is not committed. Tests use disposable
repositories and isolated state. `npm run check` also scans `docs/` for
credential-like values. CI checks macOS/Linux on Node.js 22.19.0 and 24.

Local regressions, real-client/model acceptance, and hosted CI are recorded
separately. Historical evidence predates this refactor. Targeted native
acceptance for the on-demand flow is recorded for Codex 0.164.0 and OpenCode
2.1.2; see its exact scenarios and limits in
[acceptance](docs/acceptance.md#targeted-native-acceptance-2026-10-27).

## Documentation

| Topic           | Document                                           |
| --------------- | -------------------------------------------------- |
| Integrations    | [docs/integrations.md](docs/integrations.md)       |
| Shared messages | [docs/shared-messages.md](docs/shared-messages.md) |
| Migration       | [docs/migration.md](docs/migration.md)             |
| Maintenance     | [docs/maintenance.md](docs/maintenance.md)         |
| Acceptance      | [docs/acceptance.md](docs/acceptance.md)           |
| Performance     | [docs/performance.md](docs/performance.md)         |
| Source releases | [docs/releases.md](docs/releases.md)               |
| Contributing    | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
