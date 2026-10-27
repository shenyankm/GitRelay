# GitRelay integrations

GitRelay supports **Codex** and **OpenCode v2**. Installation supplies a trigger
entry point; each native session remains off until explicitly enabled.

## On-demand sessions

Use a direct user prompt such as `Enable GitRelay`, `启用 GitRelay`,
`请并行开发这个功能`, or `Please use multiple worktrees for development`.
The prompt enables only its current worktree, monitored ref, adapter, and native
session. OpenCode also binds activation to its data root and session creation
time. A different conversation stays off; resuming the same bound conversation
retains its choice.

`Disable GitRelay` or `关闭 GitRelay` stops delivery and closes the subscription.
Unread events and receipts are preserved. An explicit opt-in reopens the inbox;
events published while it was closed are not retroactively addressed to it.

Recognition is deliberately conservative. Questions, explanations, quoted
examples, and code fences do not enable coordination. This is a small set of
English/Chinese request patterns, not a language model or arbitrary natural
language understanding. Use the explicit enable/disable prompts when wording is
not recognized. Repository text and tool output cannot change activation.

Codex still launches its small command hook at configured boundaries so it can
read the current user prompt and session choice. While off, it returns `{}`
without Git discovery, branch status, mailbox registration, or polling. OpenCode
keeps a prompt hook and performs a read-only native-session lookup to identify
saved activation; Git discovery, timers, and its event subscription start only
for enabled sessions or pending explicit opt-ins. When the last session is
disabled, its polling and event subscription stop.

Manual commands remain explicit operations:

```sh
git-relay join --cwd /absolute/worktree --agent codex --session NATIVE_SESSION_ID
git-relay leave --cwd /absolute/worktree --agent codex --session NATIVE_SESSION_ID
```

For OpenCode, use `--agent opencode` and the exact `--instance` reported by
`git-relay sessions`. Do not invent a native ID or instance; use the enable
prompt when the host identity is not available. `check` and `watch` remain
explicit CLI receivers and do not enable unrelated native sessions. Run `join`
before sending messages to a new receiver; first enrollment does not replay
prior broadcasts.

## Host capabilities

| Platform    | Integration                 | Busy session                           | Already idle session           |
| ----------- | --------------------------- | -------------------------------------- | ------------------------------ |
| Codex       | Synchronous lifecycle hooks | Context after tools; Stop continuation | Waits for the next hook        |
| OpenCode v2 | Promise plugin              | Durable host queue                     | Polling can start another turn |

## Automatic setup

Build and install the CLI, then inspect or select the two supported clients:

```sh
npm ci --ignore-scripts --omit=optional
npm run build
npm install -g /absolute/path/to/GitRelay
git-relay install --dry-run
git-relay install --platform codex --platform opencode
git-relay uninstall --platform opencode --dry-run
git-relay uninstall --platform opencode
```

Use repeated `--platform` to select clients or `--skip` to exclude one. Unknown
platforms are rejected. Detection runs the selected executable's `--version`;
unverified versions need `--allow-unverified`, which does not prove host
compatibility. Version probes can have client-specific side effects.

The installer uses owned runtime copies and stable launchers. Repeating install
updates an owned runtime; user-modified entries, foreign hooks, invalid journals,
and unowned paths are preserved. OpenCode installs a global plugin entry;
Codex installs user hooks only when no conflicting hook file or plugin exists.
Codex trust through `/hooks` remains separate. A dry run does not install entries.

Uninstall only removes a verified owned entry, keeping archives, runtimes and
shared message state. Inspect reported retained paths rather than deleting them
blindly. Cancellation can occur after publication; a diagnostic saying the
operation may have completed requires inspecting `uninstall --dry-run` and the
client configuration before retrying. Stop sessions before migrating a legacy
launcher: already-running old code and its short publication gap are not fenced.

If an installer reports that entry ownership cannot be established because its
hidden anchor is missing, do not recreate the anchor from matching content: a
replacement file can have the same bytes. Inspect the entry and, if you decide
to remove it, move it to a safe backup location that does not overwrite another
file. The entry is `hooks.json` in `CODEX_HOME` (default `~/.codex`) for Codex,
or `opencode/plugins/git-relay.js` in `XDG_CONFIG_HOME` (default `~/.config`)
for OpenCode. With both entry and anchor absent, run
`git-relay uninstall --platform codex` or `git-relay uninstall --platform opencode`;
then reinstall that platform if needed. If an uninstall was interrupted and an archive is
recorded, preserve it and investigate instead of using this recovery path.

Automatic setup on Windows has not been accepted on a real host. Codex automatic
installation is unavailable there. `.cmd`/`.bat` client launchers may fail version
probing without a shell; use manual configuration where necessary.

## CLI and hook installation

Node.js 22.19+ and Git are required. GUI applications may not inherit the shell's
PATH. Use the bundled plugin CLI or correctly quoted absolute paths when needed.
Merge manual hooks into existing configuration and review the host's trust flow.

### Codex

Use a Codex version supporting lifecycle hooks. User-level hooks were exercised with Codex CLI `0.164.0`; prefer merging [`src/adapters/codex/hooks.json`](../src/adapters/codex/hooks.json) into `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`) when not installing the plugin. Review and trust individual hooks via `/hooks`; trusting the project alone is insufficient.

Project `.codex/hooks.json` discovery also requires the host to enable that configuration layer. Discovery failed in the temporary local-worktree acceptance run, so it is not claimed as verified. Check `/hooks`, then confirm registration with `git-relay sessions`. The isolated test used a separate `CODEX_HOME` and a one-time trust bypass for reviewed package hooks; ordinary installation uses the host trust flow.

A shared app-server daemon must inherit the required CLI PATH and state environment. Isolated tests can use `codex --no-daemon exec ...` without stopping an existing user daemon.

The configured events are `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop`. Prompt/tool hooks provide `additionalContext`; a new event at Stop can return `decision: block` to request continuation. `stop_hook_active` prevents another continuation request. Old outbound-only `notify` support cannot inject into the original session. Upgrade, read CLI output at task checkpoints, or implement an App Server host consuming NDJSON and calling `turn/start` / `turn/steer`. GitRelay does not manage App Server connections.

### Codex App status and actions

The hook template enables `--branch-status`. After opt-in, SessionStart/UserPromptSubmit read a local snapshot, return it in `hookSpecificOutput.additionalContext`, and expose `systemMessage` for UI display. Mailbox deliveries also include a short `systemMessage`. Status alone never forces Stop continuation. Subagents do not register or display separate status. Hooks neither query the network nor auto-sync.

The plugin manifest and marketplace are `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`. Build and install:

```sh
npm ci --ignore-scripts
npm run build:codex-plugin
codex plugin marketplace add /absolute/path/to/GitRelay
codex plugin add git-relay@git-relay-local
codex plugin list --marketplace git-relay-local --json
```

The package includes its runtime, docs, skills, and visual assets. Hooks resolve the CLI through `${PLUGIN_ROOT}`, including paths containing spaces. There is no duplicate project `.codex/hooks.json`; do not enable duplicate user-level commands. Reopen the chat and inspect `/hooks` for discovery and trust. Installation does not automatically trust hooks.

The listing uses the same presentation fields as Ponytail: display name, developer, description, three starter prompts, brand color, logo/composer icon, skills, and lifecycle hooks. GitRelay provides focused status, synchronization, help, and coordination skills. Each has English display metadata. Codex owns the listing layout, management controls, and source indicator; a local marketplace remains a local source. Local installation does not publish a Git-backed marketplace or prove the App has refreshed its view.

App actions in `.codex/environments/environment.toml` provide **Branch status**, **Monitor branches (read-only)**, and **Auto-sync (fast-forward)**. The snapshot action writes `.codex/git-relay-status.md`; monitors stream output. Actions use Node 22.19+ native TypeScript support without requiring generated `dist`. GitHub queries require authenticated `gh` on the terminal PATH. The sync action currently reports blocked. Stop any older running sync process in its terminal after upgrading.

`status --format markdown` produces readable output; JSON remains the default. `--output FILE` is only valid for a single Markdown snapshot and overwrites the explicitly supplied path, relative to the process cwd. Snapshots do not refresh automatically. The App must load the environment config to show actions; if it does not, add those commands through Local environments settings. Configuration generation, protocol tests, installed-cache verification, and native App rendering are separate acceptance checks.

Official references: [Local environments](https://learn.chatgpt.com/docs/environments/local-environment), [Hooks](https://developers.openai.com/codex/hooks), [Plugin listing metadata](https://developers.openai.com/plugins/deploy/submission), and [skill UI metadata](https://developers.openai.com/plugins/deploy/submission-errors).

## OpenCode v2

Only the **v2 Promise plugin API** is supported, exercised with `2.1.2`. The default export is an `{ id, setup(ctx) }` object, statically checked against official `@opencode/plugin@2.1.2` types without requiring the SDK at runtime.

Add a thin `.opencode/plugins/git-relay.ts` or global plugin entrypoint:

```ts
export { default } from "/absolute/path/to/GitRelay/dist/adapters/opencode/index.js";
```

Run `npm run build` for source use; npm packaging builds automatically. Remove old duplicate entrypoints and restart OpenCode.

Git discovery is lazy. After opt-in, failures produce best-effort warnings and
retry with backoff up to one minute. A directory initialized later as a Git
repository can recover without a reload. No session is registered before Git
and native identity validation succeed. Existing saved activations resume after
a normal user prompt; historical host sessions are not enumerated. If the
resolved Git root changes, reload the plugin before resuming. Git's diagnostics
can contain unsanitized paths; redact them before sharing.

If the host's session lookup fails during an explicit opt-in prompt, the plugin
warns and retries that session without requiring another prompt. It retains at
most 128 pending session IDs and starts up to eight retries per five-second
poll. It does not start a second background lookup for an ID until the host's
underlying lookup settles, even if the host ignored cancellation. If 128
underlying retries never settle, later background retries cannot start; a
manual user prompt can attempt a fresh lookup. An initial lookup that never
settles can still leave the prompt hook waiting. When the pending-ID limit is
reached, the plugin warns and the affected session needs another user prompt.
Sessions are registered only after a successful lookup verifies that the
session is a root session in this directory. Messages sent before registration
are not retroactively addressed to it. A deletion event cancels pending retry
work, but missed events, moved sessions and reused session IDs remain subject
to the identity and event-order limitations below.

- `ctx.session.hook("prompt", ...)` enables only requested or previously opted-in root sessions and establishes/restores their baselines.
- Registered sessions are checked every five seconds, with at most one check in flight per session. Delivery uses `ctx.session.prompt({ sessionID, id, text, delivery: "queue", metadata })`. Busy sessions queue; idle sessions start. Each event is submitted separately with a stable message ID derived from the GitRelay repository identity, worktree, native session instance, and event ID. This can create more queued turns and model usage than combining a batch into one prompt. A receipt is written after each individual event is accepted.
- The [OpenCode plugin documentation](https://opencode.ai/v2/docs/build/plugins/) says retrying an ID already pending or delivered returns the original admission. This lets the adapter retry an uncertain response or failed receipt without creating another admission while the host retains that ID. A local OpenCode 2.1.2 test verified this for a pending queue item, not after model processing. Permanent deduplication and exactly-once agent work are not claimed.
- `metadata.source: "git-relay"` marks automatic messages. Both that and legacy `worktree-relay` sources are recognized, preventing recursive registration.
- `ctx.event.subscribe()` observes `session.deleted` and cancels in-flight checks, but **does not close the GitRelay subscription**. Later sends can still select that deleted session, and unread messages remain ineligible for GC. Inspect `git-relay sessions --cwd /absolute/worktree`, verify the session is no longer needed in the correct OpenCode data directory, then run `git-relay leave --cwd /absolute/worktree --agent opencode --session SESSION_ID --instance INSTANCE_ID`. `leave` prevents future targeting without acknowledging existing unread messages. The adapter resubscribes after an event-stream error or early end using a 1–60 second backoff; OpenCode exposes no replay cursor here, so events missed during disconnection or while the plugin is unloaded are not replayed. OpenCode can recreate a session using the same ID, and another OpenCode data directory can report a live session as not found; neither a delayed deletion event nor a host lookup failure alone safely identifies the session incarnation. Automatic deleted-session cleanup remains unresolved.
- Native sessions are bound to the OpenCode data root and their creation time. A recreated ID has a separate inbox; missing or invalid creation metadata is rejected. Identity is checked before and after prompt admission. Preserve old unbound inboxes for manual review and use the exact `--instance` reported by `sessions` for manual commands. A host lookup and admission are not atomic, and indistinguishable host metadata cannot identify a replacement. See [migration](migration.md#native-session-identity-upgrade).
- The plugin does not enumerate historical sessions or enroll subagents. Before delivery, it checks the session's `location.directory` against `ctx.location.directory` rather than mapping other directories to this worktree. This check and host prompt admission are not atomic; a concurrent session move can occur between them.
- Shutdown cancels polling and waits for known in-flight scans, even if the host's hook disposal fails. The locally inspected 2.1.2 Promise adapter ignores cancellation options for `session.get` and `session.prompt`. GitRelay stops waiting for a pending read-only `get` after shutdown or session deletion, but the underlying host operation can still run. An in-flight `prompt` can already have been accepted, so GitRelay waits for it while holding the session lock; if it never settles, cleanup can remain pending. No bounded shutdown time or cancellation of a submitted prompt is guaranteed.

Load an entrypoint in each receiving worktree. Local acceptance used an isolated authenticated loopback-only `opencode serve`, without replacing the user's service.

## Bundled skills

The plugin includes `git-relay`, `git-relay-sync`, `git-relay-help`, and [`worktree-coordination`](../skills/worktree-coordination/SKILL.md). The coordination skill covers event handling, full diffs, current local state, authorization boundaries, and integration checks.

Codex can discover skills through its plugin or `.agents/skills/`; OpenCode can
load `.opencode/skills/` in versions supporting skills. Skills provide guidance;
they do not replace hooks or a native receiver.

## Custom agents and orchestrators

```sh
# Reuse the same native session ID; the first call establishes a baseline.
git-relay check --cwd /path/to/worktree-B --session conversation-B

# Stream NDJSON; SIGINT/SIGTERM exits.
git-relay watch --cwd /path/to/worktree-B --session conversation-B
```

Upstream events include `type: worktree.upstream-change`, shared `eventId`, `root`, `ref`, `previous`, `commit`, `rewritten`, `snapshot`, `unavailable`, `files`, `commits`, bounded `patch`, and `message`. Explicit `worktree.agent-message` events include `sender`, `text`, `files`, and `message`. One check can emit multiple lines.

stdout carries data; stderr carries diagnostics. Watch errors, hook input warnings and fatal command errors are bounded and best effort: a blocked stderr can cause these diagnostics to be dropped or truncated, and a completed command waits at most 250 ms for pending stderr before exiting. **Successful output is not completed agent work.** The CLI writes and acknowledges each event separately; a later failed write leaves earlier receipts intact. Custom hosts use `consumeMailbox({ deliver })`, acknowledging after successful return; `return false` means only queued, not durably accepted. `consumeChanges` remains upstream-only. Node hosts import built `dist/core/consumer.js`. A crash between delivery and receipt persistence can redeliver; deduplicate by event ID. See [shared messages](shared-messages.md).

## Refs and remote changes

The default monitored ref is local `refs/heads/main`. CLI/hooks/OpenCode accept `WORKTREE_MAIN_REF`; CLI also accepts `--ref`, for example `refs/remotes/origin/main`. In contrast, `status --branch` takes a short branch name such as `main`.

Existing check/watch, hooks, and daemon do not fetch, access the network, or install Git hooks. Remote-tracking refs need an external fetch before they reflect remote merges. Patch generation disables external diff and textconv programs.

## Local and GitHub branch monitoring

`git-relay status [--cwd PATH] [--branch NAME]` needs no session. `--github` queries through authenticated GitHub CLI. `--repo [HOST/]OWNER/REPO` overrides gh's inferred repository; use it explicitly for forks when appropriate. Queries target the same branch name. Each gh call has a 30-second timeout, honors SIGINT/SIGTERM, and disables login prompts. Missing gh, authentication, permission, or network errors remain explicit while preserving local results.

Output type is `worktree.branch-status`:

HEAD and dirty state are point-in-time observations, not an atomic snapshot. When Git's HEAD label is ambiguous, GitRelay rechecks the symbolic reference and commit; `dirty` still comes from the first status read. Concurrent changes, including a switch away and back, can remain undetected.

- `worktree`: current worktree `branch`, `commit`, and `dirty`, even when another branch is selected. Dirty follows Git's porcelain status, includes staged, unstaged, and untracked files that Git reports, excludes ignored files, and is a boolean rather than a file-content change stream. Git's submodule ignore settings can hide modifications inside a submodule, so a clean result does not establish that every submodule is clean.
- `local`: selected `ref`, `commit`, and `tracking`. Tracking has the upstream ref, cached commit, and `ahead`/`behind`. No upstream is null; a missing upstream ref retains its name with null commit/counts. A missing or unborn local target has null commit and can still be queried remotely.
- `github`: present only when enabled. Success contains repository URL, branch, commit, and `matchesLocal`. Missing branches have null commit; comparison is null when either side lacks a commit. Failure is `{ "error": "..." }`, not branch absence or sync success. Only a successful exact-ref match establishes existence.

`--watch` emits a full initial snapshot, then deduplicated changes. Local intervals default to 5000 ms with a 50–3600000 range; GitHub intervals default to 30000 ms with a 5000–3600000 range. Each interval begins after the round finishes; requests do not overlap. Sampling may miss transient states. One-shot GitHub errors exit 1; watch emits errors and retries, including a recovery snapshot. Local Git errors go to stderr and retry; stdout failures exit.

`--watch --session ID [--agent NAME]` broadcasts changes after the baseline as ordinary agent messages. Receivers must already be registered; the monitor itself does not subscribe. Initial/restart snapshots are not broadcast. There is no persistent status history while stopped, and crash/retry boundaries can duplicate broadcasts. Normally run one monitor per target. Status messages are untrusted data and cannot authorize code/history changes or bypass idle hook limitations.

Status messages share the 64 KiB serialized message limit. An oversized snapshot is shown locally but is not broadcast. If another broadcast error occurs, delivery may have completed; the monitor shows the status locally and does not automatically retry that same snapshot, so inspect the mailbox before retrying manually. Diagnostics go to stderr on a best-effort basis and may be lost if the stream is closed or blocked. These cases can leave recipients without an update; the monitor does not provide durable, exactly-once status delivery.

Watch diagnostic content is capped at 4,096 UTF-16 code units, with a marker appended when truncated. While stderr is backpressured, additional diagnostics, including distinct errors and broadcast-outcome warnings, can be dropped until it drains. This limit does not truncate status output. Synchronous terminal or file writes can still block.

Default GitHub queries neither update remote-tracking refs nor download objects. Fetch through an existing workflow for diffs and monitor the corresponding `refs/remotes/...` with check/watch. `--auto-sync` currently reports blocked and does not fetch. This feature does not merge PRs or monitor CI/review status.

## Automatic branch synchronization

Automatic branch synchronization is temporarily unavailable because concurrent checkout can redirect a merge to a different branch. `--auto-sync` returns `blocked` before fetching or changing the worktree. A one-shot invocation exits 1; watch continues monitoring without Git writes. The CLI can still write a requested `--output` file or publish status changes when `--session` is supplied. `--no-auto-sync` still selects read-only monitoring. Existing older processes continue running across upgrades and must be stopped in their own terminals. See [migration guidance](migration.md#monitoring-and-automatic-synchronization) for the manual alternative and its concurrency limits.

The CLI reads the full symbolic HEAD and removes only `refs/heads/` when selecting
the monitored branch. Git's abbreviated symbolic ref can include `heads/` if a
tag shares the branch name. Unicode whitespace is preserved, invalid UTF-8 is
rejected, and a symbolic HEAD outside local branches requires an explicit
`--branch` for monitoring. Selecting a branch does not protect a future write.

### Recovery gates

Read-only validation has ordinary tests for exact upstream selection, Unicode
whitespace, invalid HEAD bytes, single-record configuration parsing, and operation
path decoding. These tests exercise existing readers without enabling fetch or
merge. The pending synchronization cases still require the complete writer:

| Pending behavior                                                      | Required before enabling writes                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Fetch and fast-forward, including Unicode refs                        | Bind the authorized repository, worktree, local ref, upstream and expected object IDs throughout the write                      |
| Dirty and ignored data, divergence and Git operations                 | Preserve local data, forbid automatic stash/reset/rebase, and inspect all operation markers before fetch and again before merge |
| Invalid refs, multiple config records and undecodable operation paths | Apply the validated readers in the writer before fetch; settle sibling Git processes before returning an error                  |
| Concurrent checkout, commit or index modification                     | Demonstrate safety against external Git processes, with deterministic barriers around each write boundary                       |
| Cancellation, partial failure and restart                             | Specify recovery without blind rollback or retry; retain user changes and report which writes completed                         |

`tests/core/auto-sync-stopgap.test.ts` includes an isolated real-Git counterexample:
after a worktree lock and final HEAD/ref checks, another checkout still succeeds,
and merging a pinned incoming object ID advances the newly checked-out branch.
The current blocked implementation leaves both branches unchanged at that point.
A private GitRelay lock, another final check, or `git worktree lock` alone therefore
does not satisfy the write boundary. A ref-only transaction also needs a protocol
for the index and working files. An exclusively owned worktree would require an
enforced ownership model; it cannot be assumed for a user's existing worktree.

After a write protocol is implemented, remove TODOs only when their full integration
assertions pass, add adversarial concurrency and interruption tests, and rerun
the synchronization benchmark and relevant native-client acceptance. Passing the
old TODO cases alone does not establish concurrency safety. Automatic fetch with
notification would be a separate feature: it writes remote-tracking refs and
does not restore automatic fast-forwarding.

## State, recovery, and limitations

- Shared state uses `worktree-agent-sync/repos/<repo-id>/`, with `XDG_STATE_HOME` / `WORKTREE_SYNC_STATE_DIR` overrides. Events are repository-wide; receipts are per session. Repository identity combines the canonical Git common-directory path with a persistent marker, or an explicit mapping for a read-only directory. Earlier path-keyed shared state needs an explicit migration or fresh-state choice; [see the migration procedure](migration.md#repository-identity-and-existing-state). Legacy Git-directory cursors are imported read-only.
- Session locks prevent concurrent duplicate delivery; active contention skips a round. Publication locks retry with jitter for up to five seconds. Lock age does not prove a stalled holder. CLI operations honor SIGINT/SIGTERM and release locks, including under output backpressure; watch exits on EPIPE rather than retrying indefinitely. SIGKILL/power loss can leave locks. Verify ownership before removing one; PID reuse cannot be resolved by a PID file alone.
- Related-history reset/force-push updates are marked rewritten and compared as snapshots. If Git cannot compare the range, GitRelay reports its ref and commit IDs and retains the unread event: an error or a `cat-file` missing result can also reflect an inaccessible object store. Unlike earlier versions, newly uninspectable ranges are not automatically acknowledged as `unavailable: true`; such a range may block later messages in that session. [History-gap recovery](migration.md#history-gap-recovery) explains how to inspect and restore trusted history. Existing receipts are not revoked, and the legacy `unavailable` notification format remains readable.
- Detection includes ignored local filenames, file/directory prefix overlap, and `core.ignorecase`. Git can report an untracked nested repository as an opaque directory; its contents are treated as potentially overlapping. Every tracked submodule path is also treated as a potential overlap, even when clean or uninitialized, because Git can hide its local contents. This can produce extra notifications. Older versions could incorrectly mark nested-repository or submodule events irrelevant; existing receipts are not revoked or replayed by this fix. Ignored file contents are not sent. A user's `diff.submodule` setting can cause committed submodule changes to appear in a bounded upstream diff. Large ignored trees and index scans can slow enumeration; Git output-limit failures retain unread events. Detection reflects current local files, not future edits. Cross-file semantic dependencies and cross-machine worktrees are outside scope.
- Changes before registration are not replayed. `irrelevant` events are not redelivered if the session later edits the file. New sessions do not receive earlier broadcasts.
- Automatic wake-up consumes model quota. Transport does not prove completed adaptation. Notification adapters do not mutate, stash, merge, rebase, or commit code; status auto-sync is temporarily blocked before writes. GC retains unread messages and closed markers, with no lastSeen expiry. See [maintenance](maintenance.md).

## Official interface references

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [OpenCode v2 plugins](https://opencode.ai/v2/docs/build/plugins/)
- [OpenCode client](https://opencode.ai/v2/docs/build/client/)

See the [platform matrix](platform-matrix.md) and [acceptance](acceptance.md)
for current verification boundaries.
