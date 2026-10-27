# GitRelay: User-level shared message storage

Native Codex/OpenCode receivers are off by default. Explicitly enable each
conversation before publishing messages; see [on-demand sessions](integrations.md#on-demand-sessions).

All adapters use the same platform-independent message layer. Messages and receipts live in the user state directory; a writable Git common directory contains a repository identity marker.

The state and Git common directories must not be modified concurrently by
non-cooperating processes. GitRelay's path-based temporary-file and lock
checks are not atomic conditions on file identity: an external process that
replaces a checked temporary or lock path can cause a replacement file to be
removed, overwrite a state file, or invalidate mutual exclusion. These windows
have been reproduced by isolated fault injection; they have not been shown to
occur between ordinary GitRelay participants following the locking protocol.

## Storage and isolation

The default is `~/.local/state/worktree-agent-sync`, or `$XDG_STATE_HOME/worktree-agent-sync` when `XDG_STATE_HOME` is absolute. An absolute `WORKTREE_SYNC_STATE_DIR` overrides the entire state root. All participants must use the same root.

```text
<state-root>/repos/<repo-id>/
├── identity-ready.json          # Completed state initialization
├── repo.json                    # Common directory and repository identity
├── publish.lock                 # Short exclusive publication/registration lock
├── refs/<ref-key>.json           # Position of each monitored ref
├── sessions/<session-key>.json   # Adapter, native ID, worktree, subscription, lastSeen
├── sessions/<session-key>.lock   # Per-session consumption lock
├── events/<event-id>.json        # One shared copy of each event
├── trash/                       # Recovery journal for approved deletions
└── receipts/<session-key>/
    ├── <event-id>.json           # Independent delivery/irrelevance receipt
    ├── delivery-cursor.json     # Scheduling only; never an acknowledgement
    └── <event-id>.<hash>.pi-proof # legacy pre-delivery proof; retained for recovery
```

- `repo-id` is the SHA-256 of the canonical absolute Git common-directory path and a persistent random repository identity. GitRelay creates `<git-common-dir>/.git-relay-id` on first use, containing a 64-character hexadecimal identity. Worktrees of the same repository share it; independent clones at different paths remain separate.
- If a repository is recreated at the same path, its new marker selects a new state. GitRelay detects earlier state for the path and requires an explicit choice to migrate eligible legacy state or start fresh. It preserves the earlier data. See [migration](migration.md#repository-identity-and-existing-state).
- Existing markers must be regular files with valid contents. GitRelay preserves and rejects invalid markers and links. Do not remove or replace a marker while clients or the daemon are running. If a marker is copied or restored at the same path, it identifies the same state; give an independent replacement a new identity and follow the explicit recovery prompts. A separate process replacing the Git directory during an operation cannot be serialized by GitRelay.
- Initial state publication requires hard-link support in the state root's `repos` directory. If the link is refused, initialization can leave an empty directory without an ownership marker; retries and automatic recovery refuse it because its ownership cannot be proved. Stop participating processes and inspect the reported path before any manual recovery. State directories and events are preserved. An external repository identity can avoid creating a marker in an unsupported Git common directory, but does not remove the state-root hard-link requirement.
- Session keys combine the real worktree path, monitored ref, adapter, native session ID, and optional native `instance`. Pi/OpenCode supply an instance to isolate recreated histories; existing unbound inboxes are preserved. Identical IDs on different platforms do not consume each other's messages; subscriptions to different refs are independent.
- Hooks with a nonempty `agent_id` return an empty response. This skips Codex subagents; they do not register subscriptions or consume their parent's inbox. The parent can check its inbox at its next hook.
- Directories are created with mode `0700`, JSON files with `0600`. Messages stay outside version control. Windows permissions still depend on system ACLs.
- The selected state root and its ancestors may be symbolic links, but GitRelay's managed child directories (including each repository's `sessions`, `events`, `receipts`, `refs` and `trash`, and accessed `receipts/<session-key>` directories) must be real directories. Delivery receipts must be regular files, not symbolic links. GitRelay rejects and preserves these links; stop all participants and inspect any existing linked layout before moving its contents into real managed directories. This changes prior behavior for linked receipt files and internal directories. Other JSON readers can still follow file links, and hard links are not rejected. These checks address static layouts, not a process replacing directories or modifying files after inspection. Windows behavior has not been verified for this change.
- This is local cooperation by one OS user, not a sandbox against malicious processes under that user or a cross-user/cross-machine service.

### Read-only Git common directories

An existing valid marker remains readable when the common directory becomes read-only. If no marker exists and GitRelay cannot create one, provide `WORKTREE_SYNC_REPOSITORY_IDS` as a JSON object mapping each **canonical absolute Git common-directory path** to its stable 64-character lowercase hexadecimal identity. For example, obtain the canonical common-directory path with `git rev-parse --path-format=absolute --git-common-dir` and resolve any symlinks; generate an identity once with `openssl rand -hex 32`, and retain the resulting mapping outside the repository:

```sh
# Replace the examples with your canonical path and the identity you generated once.
export WORKTREE_SYNC_REPOSITORY_IDS='{"/absolute/path/to/repository/.git":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
```

Configure the same mapping in every client, hook, and daemon process that uses that repository. The object may contain entries for multiple repositories. An explicit mapping takes precedence over a marker, so changing or removing an entry changes which state identity the process selects. When replacing a repository at the same path, assign the replacement a **different** identity; a path-keyed mapping cannot detect that replacement automatically. An inconsistent or reused mapping can split state or expose old messages to the replacement repository. Preserve the old identity and state for recovery.

## Event types

### Automatic upstream changes

When a receiver detects a monitored-ref update, it publishes one shared commit-range event under the repository lock, then advances the repository cursor. Repeated polling does not republish it. If a range recurs after a reset, the preceding event ID distinguishes the new occurrence.

Each recipient computes its own file overlap and diff. Events store commit pointers; delivery reads Git objects instead of copying every worktree's diff into shared storage.

Sessions with no relevant local changes record an `irrelevant` receipt without waking the agent. New sessions establish a baseline at the current monitored branch and do not receive earlier history. Registered offline sessions retain their eligibility and catch up on return.

### Explicit cross-agent messages

Register recipients through their native receiver, a hook, or one `check` before sending from another worktree:

```sh
# List registered sessions. lastSeen does not guarantee that they are online.
git-relay sessions --cwd /project/worktree-A

# Send to other registered sessions in this repository.
git-relay send --cwd /project/worktree-A \
  --agent codex --session codex-session-A \
  --message 'The configuration interface changed. Check implementations that depend on it.'

# Match only sessions modifying these files. --file is repeatable.
git-relay send --cwd /project/worktree-A \
  --agent codex --session codex-session-A \
  --file src/config.ts --file src/types.ts \
  --message 'The interfaces in these files changed. Assess whether your task needs adaptation.'
```

Without `--file`, messages target other registered sessions in the repository. With files, matching happens **at receive time**, against committed, staged, unstaged, untracked, and ignored worktree changes relative to the live monitored ref. Matching includes file/directory prefix overlap and follows Git `core.ignorecase`. The sending session does not receive its own message; other sessions in the same worktree can.

`send` only publishes; it does not create or refresh the sender's receiving subscription. One-time senders do not become future broadcast recipients. Use a receiver, `check`, or `join` to subscribe. A previously closed sender must explicitly `join` before sending.

The response is `{ "eventId": "...", "recipients": 2 }`. The count is the publication-time candidate count, not confirmed delivery. Filtering, offline sessions, and host capabilities can delay or prevent delivery. `recipients: 0` means no other sessions were registered then; later subscribers do not receive that message.

If `send` is interrupted or its output fails after the event is published,
the command can fail without returning its ID even though recipients may
receive it. Retrying the same command creates another event with a different
ID and can deliver the same text twice. The current CLI and SDK do not expose
an idempotency key or an automatic result-recovery operation; preserve the
event and receipt state and inspect it before deciding whether to resend.

Text must be nonempty and at most 64 KiB in UTF-8. The JSON serialization of `{ text, files }` must also be at most 64 KiB, including JSON syntax and escaping, so the maximum text size depends on its contents and file list. Files must be repository-relative file paths: no absolute paths, directories, or `..` traversal. Existing directories are rejected even without a trailing slash. Deleted or renamed paths and files present only in other worktrees are allowed; a regular file at a sender-side prefix does not invalidate an otherwise valid target.

Each serialized JSON state file is limited to 2 MiB. A sufficiently large recipient snapshot can exceed this limit even when the message itself is valid. Publication then fails before replacing or creating the event; recipients are never silently truncated, and an upstream ref cursor does not advance. Inspect subscriptions and preserve unread state before any explicit maintenance.

SDK publication captures message inputs before asynchronous work. The low-level upstream publisher validates its identity, commit IDs and recipient IDs before reading or changing stored events; invalid inputs are rejected instead of writing an unreadable event.

State files must contain valid UTF-8. An invalid sequence causes an explicit error rather than replacing bytes in a message or accepting a corrupted receipt. Preserve the file and restore it from a trusted copy before retrying; do not acknowledge or delete an unread event merely to clear the error.

Session `createdAt`, `lastSeen` and optional `closedAt` must be parseable date strings. Previously, malformed non-string values could be coerced into dates; for example, `closedAt: 0` could be treated as an open subscription. GitRelay now reports the invalid session and preserves it for inspection. Restore trusted state rather than modifying or deleting unread events to bypass the error.

Historical directory-style paths remain readable and eligible for normal GC. Without file overlap they receive `irrelevant`, rather than becoming broadcasts or blocking the inbox. `./src/config.ts` and `src//config.ts` normalize to `src/config.ts` before deduplication and matching, including retained events. Backslashes are separators on Windows and filename characters on Unix. Existing `irrelevant` receipts are not revoked by upgrades; previously missed messages must be republished. Message text is agent data and grants no task or Git permissions.

## Receiving and receipts

Native adapters and hooks receive both event types. Manual integration:

```sh
git-relay check --cwd /project/worktree-B --agent codex --session codex-session-B
git-relay watch --cwd /project/worktree-B --agent codex --session codex-session-B
```

Use the host's adapter name and stable session ID. For OpenCode, also pass the exact `--instance` from `git-relay sessions`; omitting it selects a separate legacy inbox. The default CLI adapter is `cli`; omitting `--agent` creates an independent CLI consumer rather than using a native agent's identity.

CLI output is NDJSON: `worktree.upstream-change` for upstream changes and `worktree.agent-message` for explicit messages. A check can output multiple lines; empty stdout means no delivery this time.

Every consumer has independent receipts. B receiving an event neither deletes it nor changes C's consumption. Receipt states are:

- `delivered`: accepted by the adapter, not proof that the model completed adaptation.
- `irrelevant`: no relevant file overlap at the time of checking.

If Git cannot compare an upstream range, GitRelay reports the ref and commit
IDs and preserves the event without a receipt. This can mean missing objects,
unrelated histories, or a Git access or execution failure; a Git exit code or
`cat-file` result alone cannot reliably distinguish them. This is a change from
older versions, which could emit and acknowledge `unavailable: true` after an
ambiguous failure. Previously acknowledged receipts are not revoked. The
legacy notification format remains readable, but the current receiver does not
automatically acknowledge a newly uninspectable range. Later upstream events wait until the history or Git access is restored; independent messages can still progress. An operator can explicitly accept the gap with `check --acknowledge-history-gap --apply` after reviewing the retained state. See [history-gap recovery](migration.md#history-gap-recovery).

If an upstream event lists this session as a recipient but names a different
ref, GitRelay stops before checking host delivery or writing a receipt. Preserve
the event and state for inspection. Registration and receipts for earlier
events in the same check may already have been written; the check is not a
transactional rollback. If the host may already have accepted it
without a receipt, inspect the native session history and any delivery proofs
before retrying; the result may otherwise be duplicated. Existing receipts are
filtered before this check and not revoked; events already collected cannot be
reconstructed by this check.

OpenCode acknowledges durable host queue admission; Codex acknowledges completed hook output. A host crash before reading hook output may still lose model-level delivery; this is not exactly-once processing.

A check selects at most eight events and targets roughly 64K characters. A single larger event can occupy a batch to allow progress. Unsent events remain for the next check. By default, `consumeMailbox` sends the selected events as one batch; a failed or cancelled delivery does not acknowledge that batch. With `deliverIndividually: true`, it sends and acknowledges each notification separately. CLI `check`/`watch` and the compatibility API `consumeChanges` use individual delivery, so a later output failure retains earlier successful receipts. In either mode, interruption after a successful callback but before its receipt is written can cause redelivery.

## SDK integration

Node hosts import built JavaScript:

```js
import { consumeMailbox } from './dist/core/consumer.js';
import { sendMessage, formatNotifications } from './dist/core/mailbox.js';

await consumeMailbox({
  cwd: '/project/worktree-B',
  ref: 'refs/heads/main',
  adapter: 'my-agent',
  session: 'stable-native-session-id',
  async deliver(notifications) {
    await host.acceptMessage(formatNotifications(notifications));
    // Returning acknowledges; throw on failure or return false if only queued.
  },
});
```

`signal` cancels Git checks and lock waits; sending, join/leave, and GC also support cancellation. Repository publication locks normally retry with jitter for up to five seconds, then report the lock path and PID. During a fresh identifiable GC, consumers instead skip a round and join/leave report busy; long or unverifiable locks fall back to the normal wait. An active per-session consumption lock skips that round to prevent duplicate delivery. Lock age does not prove a stalled owner; locks are not stolen. See [maintenance](maintenance.md) for the GC barrier and its limits.

`consumeMailbox` captures the identity, working directory, ref, and signal when called. It reads the ref before resolving the repository, so an error from a ref getter can precede a repository error. It reads callbacks and `initialCursor` when needed; callers should not mutate these while a check is running. Callback methods retain the original options object as `this`.

`joinSession` and `leaveSession` likewise capture their identity, working directory, ref, and signal when called; `leaveSession` also captures `repositoryId`. As a result, ref and signal getters can run earlier than in older versions, including before repository lookup or missing-worktree discovery.

`isDelivered(eventId)` lets hosts with durable history confirm previous acceptance on retry. A pending legacy delivery proof blocks ordinary CLI `check`/`watch` and `consumeChanges` from acknowledging that event: successful CLI output alone is not proof that the retired client accepted it. Existing manual consumption without a pending legacy proof remains available. The native adapter's verification callbacks are a trusted integration contract, not protection against a malicious SDK caller. `consumeChanges({ deliver })` remains an upstream-only compatibility API and does not acknowledge explicit messages. Its session can still be a recipient of broadcasts, so those messages remain unread and cannot be collected while it only uses `consumeChanges`. To process them, use `consumeMailbox` or the matching `check` identity; leaving alone preserves the unread messages. This also lets an existing session switch to the full mailbox without losing messages sent before the switch.

## Legacy state migration and maintenance

- Older shared state used only the common-directory path for its repository key. It is not silently claimed by a new identity. Use the explicit [migration procedure](migration.md#repository-identity-and-existing-state), or choose fresh state while retaining the old directory. The old state may already contain data from multiple repositories previously recreated at the same path; inspect its provenance before claiming it.
- Legacy `<git-common-dir>/worktree-agent-sync/<key>.json` cursors are imported read-only into session-specific catch-up events. Source files are not deleted or overwritten.
- Upgrades do not delete or close old subscriptions. Old send-only identities or `parent-session/agent_id` subagent identities may have left stale registrations. Inspect `sessions` first. Explicit `leave` prevents future delivery while retaining unread events. To acknowledge old messages, pause other publishers/receivers, repeatedly `check` with the matching `--cwd`, `--agent`, and `--session`, review output until empty, then `leave` and use normal GC. Closed identities need `join` first. Do not automatically retire genuinely offline sessions.
- A killed process may leave a `.lock`. Confirm the owner has exited before removing only that lock, never its events or receipts. Locks possibly held by live processes are not stolen.
- `leave` stops future subscriptions; `join` resumes them. Leaving does not acknowledge messages. `gc` previews by default and only collects fully acknowledged events past retention. The optional daemon attempts GC when discovering a repository and hourly after a successful pass; failed or busy passes are retried. There is no offline TTL; `lastSeen` is diagnostic. See [maintenance](maintenance.md).
- Inbox scanning reads retained event and session receipt filenames, validates receipts first, and loads only unacknowledged event bodies, with up to 32 concurrent reads per batch. Recognizable upstream publication chains and migration predecessors are delivered in causal order; an unconfirmed upstream event holds its successors. Independent messages rotate through a durable scheduling cursor to avoid starvation. See [maintenance](maintenance.md#upstream-publication-recovery-and-upgrades) for historical-event and failure boundaries. Corrupt receipts fail rather than count as read. A consume that acquires the locks and proceeds for an active session synchronizes its ref and separately validates all retained events and trash, including events that the session has already confirmed; GC also validates all events. A Git or state read failure stops that consume, including delivery of unrelated messages, until it can be retried. Safe periodic cleanup reduces scanning. Before clearing state, stop the daemon and all participants and back it up; clearing loses pending messages and deduplication records.
- Shared storage does not bypass host delivery limits. Codex hooks cannot wake an already idle session; OpenCode polling can. Local cancellation cannot retract a request already accepted by a remote host.

Git paths and refs used for repository identity, file relevance and branch
operations must be valid UTF-8. If Git returns an unrepresentable path or ref,
GitRelay reports an error and does not acknowledge the affected unread event;
repair or rename the affected path or ref using tools that can safely represent
its bytes, then retry. A valid Unicode replacement character is distinct from
invalid UTF-8 bytes. Free-text Git output retains its normal decoding behavior.
See [migration](migration.md#repository-paths-ending-in-carriage-return) before
handling state produced by older versions for Unix paths ending in carriage
return.
