# GitRelay integrations

GitRelay supports **Codex**. Loaded native root sessions
participate automatically unless explicitly disabled.

## Automatic sessions

Codex registers at its first supported hook. Registration validates Git and native
identity and establishes a baseline without replaying earlier broadcasts.
Subagents do not enroll. A nested Git repository has its own subscription.

`Disable GitRelay` or `关闭 GitRelay` closes the current subscription, retaining
unread events and receipts. Its saved choice survives reload. `Enable GitRelay`
or `启用 GitRelay` reopens it. Questions, quoted examples, repository text and
tool output cannot override an explicit choice. Legacy explicit disables remain
in effect; default participation does not delete old activation records.

On macOS/Linux, native hook execution automatically
starts one detached daemon per user state root. A startup lock prevents duplicate
launches and serializes startup with last-client shutdown. Every five seconds it
uses the current user's process table to check for native executables named
`codex`. After the last process exits it cancels work, releases its locks,
and exits. Process-discovery failure preserves the daemon for a later retry;
it is not evidence that clients exited. PID records are never used to kill hosts.

A remaining Codex app-server counts as a running client even
when its UI is closed. Existing hosts must reload updated code. No login service
is installed, so a client that has not loaded the plugin cannot trigger startup.
Automatic lifecycle is supported on macOS/Linux; Windows can still run a manual
daemon. Manual `git-relay daemon` remains under its launcher's control.

## On-demand sessions

The former default-off policy has been replaced by automatic participation.
Explicit enable/disable commands remain available for per-session control.

Manual commands remain explicit operations:

```sh
git-relay join --cwd /absolute/worktree --agent codex --session NATIVE_SESSION_ID
git-relay leave --cwd /absolute/worktree --agent codex --session NATIVE_SESSION_ID
```

Do not invent a native session ID; use the enable prompt when the host identity is not available. `check` and `watch` remain
explicit CLI receivers and do not enable unrelated native sessions. Run `join`
before sending messages to a new receiver; first enrollment does not replay
prior broadcasts.

## Host capabilities

| Platform | Integration                 | Busy session                           | Already idle session    |
| -------- | --------------------------- | -------------------------------------- | ----------------------- |
| Codex    | Synchronous lifecycle hooks | Context after tools; Stop continuation | Waits for the next hook |

## Automatic setup

Build and install the CLI, then configure Codex:

```sh
npm ci --ignore-scripts
npm run build
npm install -g /absolute/path/to/GitRelay
git-relay install --dry-run
git-relay install --platform codex
git-relay uninstall --platform codex --dry-run
git-relay uninstall --platform codex
```

`--platform codex` selects Codex and `--skip codex` skips it. Other platforms are rejected. Detection runs the selected executable's `--version`;
unverified versions need `--allow-unverified`, which does not prove host
compatibility. Version probes can have client-specific side effects.

The installer uses owned runtime copies and stable launchers. Repeating install
updates an owned runtime; user-modified entries, foreign hooks, invalid journals,
and unowned paths are preserved. Codex installs user hooks only when no conflicting hook file or plugin exists.
Codex trust through `/hooks` remains separate. An install dry run checks existing
destinations, ownership, journals, runtimes and Codex conflicts without writing
installation files. It does not check whether destinations are writable, stage
or execute the new runtime, or acquire an installation lock. A successful
preview cannot guarantee the install will succeed: permissions, ACLs, or files
can change before publication.
On macOS and Linux, the data directory path must not contain a backslash; choose
a different `XDG_DATA_HOME` if it does.

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
file. The entry is `hooks.json` in `CODEX_HOME` (default `~/.codex`). With both entry and anchor absent, run
`git-relay uninstall --platform codex`;
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

Healthy daemon checks reuse its validated state under the startup lock without a process-table scan. Hooks reuse Git discovery within a call and load command-specific modules lazily; they do not cache mailbox contents or throttle receiving. See [hook measurements](performance.md#codex-hook-overhead-2026-10-28).

The configured events are `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop`. Prompt/tool hooks provide `additionalContext`; a new event at Stop can return `decision: block` to request continuation. `stop_hook_active` prevents another continuation request. Old outbound-only `notify` support cannot inject into the original session. Upgrade, read CLI output at task checkpoints, or implement an App Server host consuming NDJSON and calling `turn/start` / `turn/steer`. GitRelay does not manage App Server connections.

### Codex App status and actions

The hook template enables `--branch-status`. SessionStart/UserPromptSubmit read a local snapshot, return it in `hookSpecificOutput.additionalContext`, and expose `systemMessage` for UI display. Mailbox deliveries also include a short `systemMessage`. Status alone never forces Stop continuation. Subagents do not register or display separate status. Hooks neither query the network nor auto-sync.

The plugin manifest and marketplace are `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`. Build and install:

```sh
npm ci --ignore-scripts
npm run build:codex-plugin
codex plugin marketplace add /absolute/path/to/GitRelay
codex plugin add git-relay@git-relay-local
codex plugin list --marketplace git-relay-local --json
```

The package includes its runtime, docs, skills, and visual assets. The manifest declares the `Developer Tools` category, the MIT license, and a subtitle within Codex's 30-character listing limit. Hooks resolve the CLI through `${PLUGIN_ROOT}`, including paths containing spaces. There is no duplicate project `.codex/hooks.json`; do not enable duplicate user-level commands. Reopen the chat and inspect `/hooks` for discovery and trust. Installation does not automatically trust hooks.

The listing uses the same presentation fields as Ponytail: display name, developer, description, three starter prompts, brand color, logo/composer icon, skills, and lifecycle hooks. GitRelay provides one `git-relay` skill covering status, synchronization, help, and coordination, with English display metadata. Codex owns the listing layout, management controls, and source indicator; a local marketplace remains a local source. Local installation does not publish a Git-backed marketplace or prove the App has refreshed its view.

Lifecycle-hook plugins are not eligible for Codex's public directory; install GitRelay from a local or repo marketplace.

App actions in `.codex/environments/environment.toml` provide **Branch status**, **Monitor branches (read-only)**, and **Auto-sync (fast-forward)**. The snapshot action writes `.codex/git-relay-status.md`; monitors stream output. Actions use Node 22.19+ native TypeScript support without requiring generated `dist`. GitHub queries require authenticated `gh` on the terminal PATH. The sync action explicitly opts into the [protected fast-forward protocol](#automatic-branch-synchronization); dirty work, divergence and unsupported layouts block updates. Stop any older running sync process in its terminal after upgrading.

`status --format markdown` produces readable output; JSON remains the default. `--output FILE` is only valid for a single Markdown snapshot and overwrites the explicitly supplied path, relative to the process cwd. Snapshots do not refresh automatically. The App must load the environment config to show actions; if it does not, add those commands through Local environments settings. Configuration generation, protocol tests, installed-cache verification, and native App rendering are separate acceptance checks.

Official references: [Local environments](https://learn.chatgpt.com/docs/environments/local-environment), [Hooks](https://developers.openai.com/codex/hooks), [Plugin listing metadata](https://developers.openai.com/plugins/deploy/submission), and [skill UI metadata](https://developers.openai.com/plugins/deploy/submission-errors).

## Bundled skills

The plugin includes one [`git-relay`](../skills/git-relay/SKILL.md) skill for status, session controls, notifications, messages, setup and troubleshooting. It links to the detailed guides rather than loading separate help, synchronization and coordination skills.

Codex can discover skills through its plugin or `.agents/skills/`. Skills provide guidance;
they do not replace hooks or a native receiver.

## Custom agents and orchestrators

```sh
# Reuse the same native session ID; the first call establishes a baseline.
git-relay check --cwd /path/to/worktree-B --session conversation-B

# Stream NDJSON; SIGINT/SIGTERM exits.
git-relay watch --cwd /path/to/worktree-B --session conversation-B
```

Upstream events include `type: worktree.upstream-change`, shared `eventId`, `root`, `ref`, `previous`, `commit`, `rewritten`, `snapshot`, `unavailable`, `files`, `commits`, bounded `patch`, and `message`. Explicit `worktree.agent-message` events include `sender`, `text`, `files`, and `message`. One check can emit multiple lines.

stdout carries data; stderr carries diagnostics. Watch errors, hook input warnings and fatal command errors are bounded and best effort: a blocked stderr can cause these diagnostics to be dropped or truncated, and a completed command waits at most 250 ms for pending stderr before exiting. **Successful output is not completed agent work.** The CLI writes and acknowledges each event separately; a later failed write leaves earlier receipts intact. Custom hosts use `consumeMailbox({ deliver })`, acknowledging after successful return; `return false` means only queued, not durably accepted. `consumeChanges` remains upstream-only. Node hosts import the public SDK from `git-relay`. A crash between delivery and receipt persistence can redeliver; deduplicate by event ID. See [shared messages](shared-messages.md).

## Refs and remote changes

The default monitored ref is local `refs/heads/main`. CLI/hooks accept `WORKTREE_MAIN_REF`; CLI also accepts `--ref`, for example `refs/remotes/origin/main`. In contrast, `status --branch` takes a short branch name such as `main`.

Existing check/watch, hooks, and daemon do not fetch, access the network, or install Git hooks. Remote-tracking refs need an external fetch before they reflect remote merges. Patch generation disables external diff and textconv programs.
Older Git versions may start a lazy-fetch subprocess for a missing object, but its transport is blocked; restore the object locally before retrying.

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

Default GitHub queries neither update remote-tracking refs nor download objects. Fetch through an existing workflow for diffs and monitor the corresponding `refs/remotes/...` with check/watch, or explicitly enable the protected `--auto-sync` flow below. This feature does not merge PRs or monitor CI/review status.

## Automatic branch synchronization

Synchronization is opt-in and separate from notification delivery. Use
`git-relay status --auto-sync --cwd /absolute/worktree` once, or add `--watch`
to repeat. Hooks and plugins never opt in. `--no-auto-sync` remains read-only.
Only the existing branch checked out in the selected worktree can be updated,
and it must have exactly one configured remote branch upstream. No stash,
reset, rebase, merge commit or forced local ref update is performed.

The CLI reads the full symbolic HEAD, preserving Unicode whitespace and
rejecting invalid UTF-8. Dirty work, divergence, Git operation markers and
existing locks block updates. Fetch may refresh the configured remote-tracking
ref even when local dirtiness later blocks fast-forwarding. A blocked/error
one-shot invocation exits 1; watch reports it and continues. The CLI can still
write a requested `--output` file or publish status when `--session` is supplied.

### Native Git write protocol

The writer supports macOS/Linux, Git's files ref backend and ordinary on-disk
indexes. Windows, reftable, sparse/split indexes, assume-unchanged/skip-worktree
entries, conditional Git includes, per-worktree config, branch-specific merge
options, active post-merge/post-index-change hooks and repository/index override
environment variables are rejected. These cases retain the previous
blocked behavior rather than attempting an unprotected update.

1. Hold the real `index.lock` throughout validation, fetch and publication.
   For a linked worktree, also exclusively own its native `locked` file to
   reject newly started ordinary worktree move/prune attempts. Existing locks
   are never stolen.
2. Fetch only objects and a private `FETCH_HEAD`, with no tags, recursive
   submodules, opportunistic ref mappings or automatic maintenance. Publish
   the exact configured tracking ref using `update-ref --no-deref` and its
   expected old object ID. An upstream symref race cannot redirect a fetch
   into a local branch; a concurrent tracking object-ID change fails
   compare-and-swap.
3. Prepare a Git `update-ref --stdin` transaction for HEAD's expected old/new
   IDs and verify the fetched tracking ID. Git locks HEAD, its resolved local
   branch and the tracking ref. Revalidate the full symbolic HEAD **after**
   prepare; abort without applying files if it is not the authorized ref.
4. Copy the original index and fast-forward a private detached HEAD/index,
   sharing the object store but using the selected real worktree. Native
   `merge --ff-only --no-autostash --no-overwrite-ignore` retains dirty and
   ignored-file protection. The private merge disables hooks and submodule
   recursion; no incoming commit is created. Actual tracking/HEAD updates honor
   configured reference-transaction hooks. Unsupported post-mutation hooks and
   branch merge options block before fetch rather than silently bypassing policy.
5. Rename the prepared index over the real index while the original
   `index.lock` still exists, then commit the prepared ref transaction.
   Only confirmed success releases the owned index/worktree locks and private
   directory. Cleanup verifies lock inode ownership before removing a lock.

Competing checkout/switch (including force), commit, reset, restore and index
updates cannot pass the real index lock. Symbolic HEAD/ref changes cannot
pass the prepared reference locks. A change before prepare either fails
expected-ID verification or the post-prepare symbolic-HEAD check. A private
GitRelay lock, another final HEAD check, or `git worktree lock` alone would not
provide this protection; the real-Git counterexample remains in
`tests/core/auto-sync-stopgap.test.ts`.

Read-only observers can see intermediate file/index/ref states: this is not an
atomic filesystem snapshot. Keep worktree and Git-directory paths stable, and
finish any in-flight relocation before starting synchronization: a lock cannot
retroactively stop a move already past its own lock check. The protocol does not
serialize arbitrary editor
writes, configuration changes, raw metadata edits, explicit lock removal,
forced worktree management that bypasses locks, or helpers that escape their
process group. Coordinate those operations. Network filesystems and power-loss
durability have not been validated.

### Interrupted synchronization and recovery

Before a worktree mutation, cancellation/error releases only owned guards.
Once merge has been invoked, **any** error or cancellation conservatively
retains the real index/worktree locks, even when Git reports a preflight
collision. Mutating Git commands use bounded POSIX process groups; cancellation
kills and settles that group before returning. The ref transaction is
aborted/settled where possible. There is no automatic rollback or retry.

Once initialized, the index lock contains a PID and a path to
`<git-dir>/git-relay-sync-*/recovery.json`. This lock is JSON guard metadata,
**not an index image**; never rename it over the real index. A crash during
early preflight can leave an empty guard without a journal. For an attempted
worktree update, the private directory retains `original-index`, the proposed
`index` if it has not been renamed, and the expected repository/worktree, refs,
remote/source and before/after IDs. Fetch-only initialization can have a journal
without saved indexes. Its phase records an **attempted** boundary, not proof
of completion. A lost commit acknowledgement can leave the real branch
already advanced.

Stop the auto-sync watch and identify/stop any remaining associated Git or
filter processes before recovery; a saved PID alone does not establish
ownership or liveness. Back up the entire worktree, including ignored files,
the real index and private recovery directory. Inspect the actual symbolic
HEAD, target ref, both indexes and working files against the recorded IDs.
If the proposed index has been renamed, inspect the real index instead.
Reconcile the observed state with explicit user authorization; do not blindly
reset to the old ID, restore a saved index, delete locks or rerun synchronization.
Release verified owned locks and remove recovery data only after reconciliation.
Subsequent automatic attempts remain blocked while those guards are present.

The restored integration cases and deterministic boundary/interruption checks
are described in [acceptance](https://github.com/shenyankm/GitRelay/blob/main/docs/evidence/acceptance-history.md#protected-opt-in-synchronization-2026-10-28).
Rebuild/reinstall updated runtime copies; stop older auto-sync processes in
their own terminals before replacing them.

## State, recovery, and limitations

- Shared state uses `worktree-agent-sync/repos/<repo-id>/`, with `XDG_STATE_HOME` / `WORKTREE_SYNC_STATE_DIR` overrides. Events are repository-wide; receipts are per session. Repository identity combines the canonical Git common-directory path with a persistent marker, or an explicit mapping for a read-only directory. Earlier path-keyed shared state needs an explicit migration or fresh-state choice; [see the migration procedure](migration.md#repository-identity-and-existing-state). Legacy Git-directory cursors are imported read-only.
- Session locks prevent concurrent duplicate delivery; active contention skips a round. Publication locks retry with jitter for up to five seconds. Lock age does not prove a stalled holder. Mailbox/status-output operations honor SIGINT/SIGTERM and release their locks, including under output backpressure; interrupted branch writes retain recovery guards as described above; watch exits on EPIPE rather than retrying indefinitely. SIGKILL/power loss can leave locks. Verify ownership before removing one; PID reuse cannot be resolved by a PID file alone.
- Related-history reset/force-push updates are marked rewritten and compared as snapshots. If Git cannot compare the range, GitRelay reports its ref and commit IDs and retains the unread event: an error or a `cat-file` missing result can also reflect an inaccessible object store. Unlike earlier versions, newly uninspectable ranges are not automatically acknowledged as `unavailable: true`; such a range may block later messages in that session. [History-gap recovery](migration.md#history-gap-recovery) explains how to inspect and restore trusted history. Existing receipts are not revoked, and the legacy `unavailable` notification format remains readable.
- Detection includes ignored local filenames, file/directory prefix overlap, and `core.ignorecase`. Git can report an untracked nested repository as an opaque directory; its contents are treated as potentially overlapping. Every tracked submodule path is also treated as a potential overlap, even when clean or uninitialized, because Git can hide its local contents. This can produce extra notifications. Older versions could incorrectly mark nested-repository or submodule events irrelevant; existing receipts are not revoked or replayed by this fix. Ignored file contents are not sent. A user's `diff.submodule` setting can cause committed submodule changes to appear in a bounded upstream diff. Large ignored trees and index scans can slow enumeration; Git output-limit failures retain unread events. Detection reflects current local files, not future edits. Cross-file semantic dependencies and cross-machine worktrees are outside scope.
- Changes before registration are not replayed. `irrelevant` events are not redelivered if the session later edits the file. New sessions do not receive earlier broadcasts.
- Automatic wake-up consumes model quota. Transport does not prove completed adaptation. Notification adapters do not mutate, stash, merge, rebase, or commit code; only an explicitly requested status auto-sync can fast-forward under the native Git write protocol. GC retains unread messages and closed markers, with no lastSeen expiry. See [maintenance](maintenance.md).

## Official interface references

- [Codex hooks](https://developers.openai.com/codex/hooks)

See the [platform matrix](platform-matrix.md) and [acceptance](acceptance.md)
for current verification boundaries.
