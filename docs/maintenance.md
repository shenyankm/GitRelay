# GitRelay: Session exit, safe cleanup, and the optional daemon

These features share the existing user-level message store. Plugins, hooks, and manual cleanup work without a daemon.

## Stopping monitoring and synchronization

`git-relay daemon` serves registered message subscriptions; `git-relay status --watch` is a separate branch-monitoring process. Stopping the daemon or running `leave` does not stop a status monitor or auto-sync process in another terminal.

To disable synchronization, press Ctrl+C in the terminal running `status --watch --auto-sync`, then restart with `status --watch --no-auto-sync` if needed. The switch is not persisted. Starting another read-only process does not stop the original writer. Current auto-sync returns `blocked` without fetching or changing files. Upgrading does not stop older running auto-sync processes; stop those processes in their own terminals. See [manual synchronization guidance](migration.md#monitoring-and-automatic-synchronization).

Renaming or reinstalling the plugin does not clean up unread messages. See [migration](migration.md).

## 1. Explicitly leave subscriptions

```sh
git-relay leave --cwd /project/worktree-B --agent codex --session native-session-B
git-relay join  --cwd /project/worktree-B --agent codex --session native-session-B
git-relay sessions --cwd /project/worktree-B
```

- `leave` saves `closedAt`, excluding the session from future broadcasts and upstream events.
- Existing unread events, receipts, and baselines remain. **Leaving is not acknowledgement and does not make unread events eligible for cleanup.**
- Ordinary checks, hooks, and receiver restarts do not reopen closed sessions. Use `join` explicitly.
- Rejoining preserves the inbox and deduplication state, but does not backfill broadcasts not addressed to the session while it was closed.
- Leaving an unregistered session does not create a registration.
- Closing a terminal, reloading an extension, or going offline is not permanent departure. These lifecycle events do not automatically call `leave`, and `lastSeen` does not expire subscriptions.
- Messages already queued by the host may not be retractable. An active receiver lock makes leave return busy; retry rather than overriding the lock.

Commands identify a subscription by worktree, ref, adapter, and native session ID. Supply `--ref` for a nondefault branch. Handle the inbox and explicitly leave before deleting a worktree; deleting its directory does not acknowledge messages. After deletion, `leave --cwd` can use the original canonical absolute root path, but only when persistent state uniquely matches that path, ref, adapter, and session. Record the `root` shown by `git-relay sessions` before removal; a symbolic-link alias may no longer resolve to the original worktree and is not resolved after removal. Do not substitute the main worktree path.

If that lookup is ambiguous or an unrelated damaged repository entry prevents
the scan, you may explicitly select the retained repository state:

```sh
git-relay leave --cwd /original/absolute/worktree --agent codex \
  --session native-session-B --ref refs/heads/main --repository-id STATE_ID
```

`STATE_ID` is the 64-character directory name under `<state-root>/repos/`,
not the repository's `.git-relay-id` marker. The state root is described in
[storage and isolation](shared-messages.md#storage-and-isolation). Inspect
each candidate's `repo.json` and `sessions/*.json` there to identify the
original common directory and the matching `root`, `ref`, `adapter`, and
`session`. These files can contain private paths and session details. Select
only a candidate you can verify: two repositories may contain the same session
key after a worktree path is reused, and selecting the wrong one closes that
repository's subscription. The command validates the selected state and
leaves unrelated entries untouched; it does not infer which repository you
intended. This option is accepted only when the worktree path is missing.
For a missing worktree, GitRelay checks both the supplied path and the
normalized path used for the session key. A dangling link at either path or
along a checked ancestor causes it to stop and preserve the subscription;
inspect the link and use the original canonical root. These checks and the
state update are not atomic with external path creation or replacement, so
coordinate with processes recreating the worktree.

The small `closedAt` tombstone remains so later polling cannot register the same closed ID as a new session. Other agents can use the CLI to leave at the user's request; host shutdown hooks are not automatically rewritten.

`send` does not establish a receiving subscription. Older send-only identities or `parent-session/agent_id` subagent registrations are not automatically deleted. Inspect `sessions`. To acknowledge their old unread events, pause other participants, repeatedly `check` and review output while subscribed, then `leave`; closed identities need `join` first. Only acknowledged messages can be collected. See [legacy migration](shared-messages.md#legacy-state-migration-and-maintenance).

## 2. Collect only acknowledged events

```sh
# Preview only. Default retention is seven days.
git-relay gc --cwd /project/worktree-A
git-relay gc --cwd /project/worktree-A --dry-run

# Apply after reviewing the preview.
git-relay gc --cwd /project/worktree-A --apply

# Explicitly collect acknowledged events immediately; unread messages remain.
git-relay gc --cwd /project/worktree-A --apply --retention-days 0
```

An event is eligible only when:

1. Every publication-time recipient has a valid `delivered` or `irrelevant` receipt.
2. Retention has elapsed since the **latest** event creation or acknowledgement timestamp. An old event just read by an offline session is not immediately deleted because of its age.
3. Every recipient's legacy migration is complete, preventing reimport of collected history.
4. Every recipient's consumption lock can be acquired, preventing receipt removal while a consumer still caches the event.
5. An upstream event is not the publication that the current ref cursor can still retry. A missing cursor also prevents collection of that ref's upstream events.

Reports contain `dryRun`, eligible event IDs in `eligible`, successful deletions in `removed`, and retained items in `kept` with reasons `unconfirmed`, `retention`, `migration`, `busy`, or `publication`. The last reason means that an upstream publication may still need cursor recovery, or its cursor is missing. Invalid cursors cause GC to fail before deleting any events.

Closed/offline sessions and deleted worktrees do not replace acknowledgement. Missing receipts retain events; invalid UTF-8, malformed JSON and invalid event or receipt structures are rejected rather than counted as acknowledgements. This validation cannot detect every valid-looking modification: in an isolated test, changing an event's recipient list to an empty array let GC collect it despite its original recipient lacking a receipt. Independent recipient-integrity protection remains unresolved. Preserve state and restore a trusted copy if corruption is suspected. Events recorded with no recipients can otherwise be collected after retention.

### Concurrency and interrupted cleanup

Cleanup holds the repository `publish.lock` while it checks and removes events. For each event it briefly acquires and releases each recipient lock in turn, rather than holding an open descriptor for every recipient. An existing consumer that already passed the publication lock still holds its recipient lock, so GC skips that event as busy; a new consumer cannot pass the publication lock until GC finishes. This barrier covers the documented GitRelay consumer, join and leave paths, not non-cooperating processes that edit state files directly.

While a fresh, identifiable GC holds the publication lock, a consumer skips that polling round and join/leave report busy; even a session unrelated to the current event can briefly be skipped. Sending and other publication operations retain their usual five-second bounded wait. If the lock is unreadable, cannot be verified, or its timestamp is at least 60 seconds old, session operations also fall back to the normal bounded wait and may report a busy error during a long GC. Age limits silent skips; it does not establish that a lock is stale or authorize its removal. PID reuse and non-cooperating file changes cannot be excluded, and locks are never stolen automatically.

Approved events move atomically from `events/` to `trash/` before their receipts and journal files are deleted. This move commits the deletion:

- Failure before the move retains the original event and receipts.
- Interruption afterward normally leaves approved events in `trash/`; a later `gc --apply` completes deletion. An upstream event left there by an older interrupted cleanup is retained while its publication may still need recovery.
- Preview lists pending journal entries but does not delete them.
- Increasing retention later does not undo a committed deletion.

GC preserves ref cursors, registrations, closed markers, and legacy migration sources. Do not manually move unread events into `trash/` or edit events/receipts during cleanup.

### Upstream publication recovery and upgrades

If creation of an identity or migration temporary file fails, GitRelay reports
its path and leaves any file at that path intact. It may be a pre-existing file
or an incomplete write; preserve it for inspection rather than removing it to
force a retry. These files can contain private messages, receipts, or metadata. This
does not protect against another process replacing an already-created temporary
path during a subsequent publication or cleanup; coordinate other processes
that can modify the same state and repository metadata directories.

An upstream event may have been delivered before its ref cursor was saved. Under the publication lock, ref synchronization scans retained events and `trash/` for a matching unfinished publication, completes a unique match, then observes the current ref. This allows recovery even if the ref advanced or reset in the meantime. A missing cursor with existing upstream events, multiple matching candidates, a damaged cursor, or the same event ID in both `events/` and `trash/` needs investigation; preserve those files and receipts rather than deleting or editing them to force progress.

For a matching event left in `trash/` by an earlier version, recovery moves it back only if the original receipts are still present and valid. If an earlier cleanup already removed a receipt, automatic recovery cannot reconstruct it: stop the participants and preserve the event, remaining receipts, native session history, and cursor for manual investigation. The current implementation validates all event and trash records during each ref synchronization, so damaged unrelated state can block a ref check. See the [measured scan cost](performance.md#upstream-publication-recovery-scan-2026-10-27-asiasingapore).

A session's inbox scan can skip an event it has already confirmed, but ref synchronization must still inspect the event: its receipt does not establish whether a damaged payload was an upstream publication whose cursor was never saved. Consequently, a previously confirmed but damaged message can block a consumer during ref synchronization. Earlier versions could skip that payload for the confirming session. Preserve the event, receipts, and cursor and restore a trusted copy before retrying; do not delete the record merely to unblock the scan.

Per-session inbox scans order retained upstream events by the publisher's hash-linked chain and recognized legacy migration predecessors. Clock rollback and a reset such as A→B→A→C do not reorder those linked publications. An unconfirmed or `isPending` upstream event prevents later upstream callbacks and receipts. Unlinked historical events retain their stable timestamp/ID order; existing receipts are not rewritten, and collected predecessors cannot be reconstructed.

Explicit messages rotate through a durable per-inbox `delivery-cursor.json` and alternate with upstream candidates. Repeated `false` callbacks or one oversized notification therefore do not keep independent messages behind the same first scan window. The cursor schedules retries; it is never a delivery receipt. An unreadable upstream comparison retains that event and its successors, while independent messages can still be delivered before the comparison error is reported. Corrupt state and Git execution failures can still stop the whole scan. See [history-gap recovery](migration.md#history-gap-recovery) for explicit acknowledgement when trusted history cannot be restored.

Upgrade and reload **all** participating CLIs, daemons, plugins, and hooks before resuming shared state. Older versions can publish or collect events without the current recovery checks; a new participant cannot make their operations safe. There is no protocol-enforced version gate or atomic journal that makes mixed-version operation safe, and no migration command that certifies older processes have stopped. Keep backups of the existing state until the upgrade and recovery are verified.

### Interrupted JSON writes

A process killed between writing a temporary JSON file and renaming it can leave a `<target>.json.<UUID>.tmp` file; legacy delivery-proof publication could leave a `<event>.<hash>.pi-proof.<UUID>.tmp` file. Normal scans and GC do not remove these files. Preserve them while investigating: an event may represent a send with an unknown outcome, and a temporary receipt or proof does not prove delivery was acknowledged. Do not promote or delete a candidate solely because it is old. Stop the relevant GitRelay operations and verify any remaining lock owner before inspecting the target and temporary files; installation journals and daemon files have separate locks. There is currently no automatic reconciliation or cleanup for these candidates.

## 3. Optional daemon

```sh
# One instance per user state root; runs in the foreground for supervision.
git-relay daemon

# Defaults: poll every 5000 ms and retain acknowledged events for seven days.
git-relay daemon --interval-ms 5000 --retention-days 7

git-relay daemon status
```

The daemon is not limited by the current `--cwd`. It discovers all registered repositories in the state root and monitors refs subscribed to by sessions that have not closed.

- Each repository/ref is checked once per round without creating synthetic recipients.
- A client consume that acquires the locks and proceeds for an active session checks its ref and recovers pending publications under the publication lock, regardless of daemon heartbeat or earlier ref observations. File-scoped message relevance resolves the live worktree ref. A failed Git check or state read stops that consume and can delay unrelated messages until a retry.
- New sessions establish their baseline through the same check. An active session lock skips a receiving round; repository locks wait up to five seconds. Empty stdout does not prove registration; use `join` and `sessions` to confirm.
- One bad repository or subscription does not block others. A missing common directory produces one `daemon.repository-missing` report per missing episode in each run; monitoring resumes when it returns. Maintenance still collects eligible events while preserving unread events, sessions, and repository directories.
- GC is attempted when each repository is first discovered, then hourly after a successful pass, with the same retention and safety rules. A failed pass is retried no sooner than five seconds and no sooner than the polling interval. After a busy pass, the retry waits at least five seconds, the polling interval, or the duration of that pass, whichever is longest. Busy items remain available for later maintenance or manual GC. Scheduling uses elapsed process time, so wall-clock corrections do not defer the next attempt. Retention still uses wall-clock timestamps. Sleep behavior depends on the operating system and has not been validated across platforms.
- The daemon does not fetch, answer messages, or call models. Host adapters still determine local relevance, inject messages, and write receipts.

### Background operation and shutdown

On macOS/Linux, use an existing service manager or explicitly start it from a shell:

```sh
umask 077
nohup git-relay daemon > "$HOME/git-relay-daemon.log" 2>&1 &
daemon_pid=$!
# Use the process handle from this launcher, not an unverified old PID file.
kill -TERM "$daemon_pid"
```

All CLI commands install signal handlers before operating. Ctrl+C/SIGTERM cancels lock waits and Git checks, then waits for acquired locks to be released in cleanup. The daemon also clears its own heartbeat and process lock. Incomplete stdout writes can be canceled without acknowledging messages. Diagnostics are emitted outside publication locks, so blocked output does not hold the publication lock. Shutdown finishes state cleanup without waiting for blocked stdout; final diagnostics may be truncated. Output-pipe failure also cleans up resources. A conflicting second instance cannot remove the first instance's lock or heartbeat.

Interrupted one-shot commands return a nonzero status (normally 130 for SIGINT or 143 for SIGTERM) and warn that the operation may already have completed. A nonzero status does not mean it was rolled back: inspect the resulting state before retrying, especially after `send`. `watch`, `daemon`, and `status --watch` retain their normal graceful-stop behavior; installer cancellation retains its existing behavior. Repeated Ctrl+C continues waiting for cleanup rather than forcing it to stop.

No launchd/systemd/Windows service is installed, no automatic detachment occurs, and no stop command blindly kills a PID read from disk. Windows can run the daemon in the foreground or under a user-chosen service manager. Normal operation does not require a daemon, and it never starts automatically.

### Files and recovery

```text
<state-root>/daemon.lock     # Singleton lock with PID and instance token
<state-root>/daemon.json     # Heartbeat, instance token, polling interval
<repo-store>/trash/          # Journal for approved deletions
```

Heartbeat freshness is `max(15 seconds, 3 × interval-ms)`. `daemon status` is a local liveness hint, not process authentication or proof that a host session is online. It does not replace a client-side ref check.

A non-string or malformed heartbeat time makes daemon status unavailable. A non-string or malformed ref check time is reported
as an invalid cursor; preserve the state for inspection or restore it from a
trusted backup. Valid historical parseable time strings remain supported.

The ref observation time is sampled before its Git lookup and event scan. A
slow scan therefore does not make an older ref value appear newly checked.
Large clock changes and concurrent ref changes still prevent an atomic view.

The per-ref token records a past successful check; current clients do not rely
on it to skip their own checks. Older clients can mistake a newer daemon's
heartbeat for monitoring their old path-keyed state. Stop older clients and
daemons during migration; this change does not make mixed-version operation
safe. The token does not protect against state changes by other processes
running as the same user.

SIGKILL or power loss can leave locks. Confirm the original relay operation exited before removing only its `.lock`. PID files cannot reliably distinguish PID reuse or suspended processes. Lock timeouts report paths and PIDs without recommending removal of occupied locks; even a healthy daemon lock older than 60 seconds remains busy. Nonregular lock files, including dangling symlinks, fail immediately. Dead-PID diagnostics and release both recheck lock identity; never replace locks while participants are running. Upgrade and reload all participating CLIs/plugins to versions supporting the current state fields.

## Acceptance

See [acceptance records](acceptance.md). Automated maintenance tests use temporary repositories, isolated state, and real CLI subprocesses; they do not modify existing user messages or install services.
