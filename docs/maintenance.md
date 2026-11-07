# Maintenance and recovery

State belongs to one OS user and is shared through `WORKTREE_SYNC_STATE_DIR` or the
existing XDG/default path. Keep repository identity markers, events, receipts,
activation state and owned lock/journal files together. Never delete them to
force a successful operation.

## Monitoring

Joining, receiving or enabling source tracking through MCP starts a monitor
candidate. At most one owns the daemon lock; other connected candidates retry and
can take over after its owner exits. `monitor_status` is observation only. Monitoring stops when no
participating server remains. It publishes changes but does not acknowledge
messages or run model turns. An old subscription's heartbeat does not prove the
agent is still online. Leaving a subscription does not stop the candidate or
disable source tracking; use `track_repository({enabled:false})` for each
registration you intend to disable.

## Verified-dead lock recovery

MCP identity/session/publication locks and shared monitor/group locks publish a
complete PID/token record atomically with a hard link. A process crash therefore
does not expose a newly created empty owner record. Local state storage must
support hard links and atomic rename.

Automatic reclamation requires a verifiably dead PID and matching file identity.
Recovery contenders publish unique, never-reused bakery tickets under
`<lock>.recovery/`, serialize the identity check/unlink, and remove only their own
ticket afterward. A crashed recovery participant's unique ticket can itself be
removed after its PID is verifiably dead; no age-based stealing or permanent
second recovery mutex is used. Lock ordering and event/receipt recovery journals
are unchanged. Generic legacy lock calls retain their explicit-recovery default.

Live PIDs, permission-denied/ambiguous owners, corrupt records and old ownerless
locks remain protected and need inspection. PID reuse can conservatively prevent
automatic reclamation; age alone never authorizes deleting a lock. Never manually
remove a live lock or delete event/receipt evidence to force recovery.

## Tracked source state

`tracking.json` enables same-source analysis. Disable with
`track_repository({enabled:false})` to stop that local registration; recursively
discovered source repositories have independent registrations and may also need
disabling. Existing inbox data is retained. Registrations are tied to the main
worktree/bare root rather than an ephemeral calling worktree. Discovering a local
remote does not overwrite its existing GitHub/source/disabled preferences. A
clone inherits a known local parent's source identity, including resolved fork
ancestry, without re-enabling a deliberately disabled parent.

`coordination-report.json` records inventories, coverage errors and scan times;
cloud and remote snapshots have a one-minute cache. Check timestamps before
assuming a report is current. Missing repositories are unknown, not clean, and
healthy members continue scanning. Corrupt registrations are quarantined and
preserved with a local `coordination-error.json`. Their last complete source
association identifies the affected coverage gap; unknown ancestry remains an
explicit unknown rather than being assumed unrelated. Other healthy source
groups keep producing fresh reports. Reading the corrupt registration itself
still fails closed until repaired.

The private `observer.git` (SHA-1) or `observer-sha256.git` retains imported objects
and synthetic snapshots. A SHA-256 observer does not overwrite/delete an older
SHA-1 store left by the previous implementation. Remote caches include object
format in their identity.
It can consume significant disk space for large fork networks. Do not remove it
while monitoring; no automatic observer-compaction policy is claimed here.
Ordinary message GC does not compact Git object databases.

`connections/` contains expiring per-transport leases. Graceful shutdown removes
only the owning connection file. Leases expire within ten seconds without
renewal; a verifiably dead process is considered offline sooner. A lease says
nothing about whether a model is running or has understood a notice.

## Cleanup

Call `collect_garbage` without apply to preview. Set apply=true only for explicitly
requested maintenance. The default retention is seven days. Every original
recipient must have a valid confirmed/irrelevant receipt before an event is
eligible. Busy receivers, unread data and uncertain publication remain protected.

GC retains its existing journal: move eligible files to trash, finish bounded
proof deletion, then complete removal. Failed writes/deletes retain recovery
state. The monitor also performs the engine's existing periodic cleanup of
confirmed events; it cannot make unread events eligible.

## Message acceptance

`receive_messages` writes a bounded `mcp-delivery.json` journal under that
receiver's receipt directory, without marking the returned events delivered.
`acknowledge_messages` accepts the complete latest batch. If a response is lost,
reconnect with the same private session token and receive again. Do not invent a
delivery ID or manually write receipts. Invalid journals or receipts are errors
and are preserved for inspection.

Keep a receiver's calls sequential. A later receive can supersede an earlier
batch, and stale acknowledgement must not confirm a newer batch. Receipts are
transport/application acceptance, not evidence of model adaptation.

## Repository identity

`repository_status` and `list_sessions` observe without initialization. Mutating
operations verify current identity and migration readiness. Replacing an identity
does not silently connect to prior state.

Use `choose_fresh_repository` only after deciding to start separate state.
Use `migrate_repository` to finish the existing explicit legacy copy protocol.
Use `recover_repository` to archive a verified empty incomplete initialization.
Nonempty, damaged or unowned directories are retained for manual inspection.

For a removed worktree, `leave_session` accepts its repositoryId when needed.
`retire_session` can explicitly close a listed old subscription, preserving unread
state. Inspect old data before retirement; a new MCP identity does not inherit
an old native client's inbox.

## Interrupted operations

MCP cancellation may happen after a message, Git update or metadata replacement
commits. Stop the caller, inspect current files, receipts and locks, and establish
what completed before retrying. Keep event/publication/deletion journals on
failure. Never kill a process solely because its PID appears in a saved file.
`repository_status` snapshots are observations, not recovery commands.
