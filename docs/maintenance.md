# Maintenance and recovery

State belongs to one OS user and is shared through `WORKTREE_SYNC_STATE_DIR` or the
existing XDG/default path. Keep repository identity markers, events, receipts,
activation state and owned lock/journal files together. Never delete them to
force a successful operation.

## Monitoring

Joining or receiving through MCP starts a monitor candidate. Exactly one owns
the daemon lock; other connected candidates retry and can take over after its
owner exits. `monitor_status` is observation only. Monitoring stops when no
participating server remains. It publishes changes but does not acknowledge
messages or run model turns. An old subscription's heartbeat does not prove the
agent is still online.

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
