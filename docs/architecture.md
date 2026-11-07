# GitRelay architecture

GitRelay is a local stdio MCP server over a filesystem coordination engine. The
MCP service and shared ref monitor use the same
repository identities, event files, receipts and locks for one OS user.

## Entrypoints and protocol

`src/mcp/main.ts` owns stdio serving, process signals, bounded stderr diagnostics
and shutdown. It uses the official MCP TypeScript server SDK and serves both
modern clients and older initialize-based clients through the SDK's stdio entry.
Stdout carries only protocol traffic, except explicit `--help`/`--version` output.

`src/mcp/server.ts` registers strict input schemas, tool annotations and workflow
instructions. It combines request cancellation with connection shutdown, tracks
in-flight operations and starts monitoring lazily on join, receive or enabled
tracking. Its server
factory is also used directly by source-level integration tests.

`scripts/build.mjs` emits runnable JavaScript into `dist`; strict type checking is
a separate `npm run typecheck` task. The private source project has no npm package
export wrapper, executable shim, declaration build or publication pipeline.

There are no Codex hook adapters, client process scanners, plugin manifests,
installers, shell-command dispatchers or generated TOML vendor bundles.

## Sessions and acknowledgement

`join_session` generates a random private handle or resumes a supplied handle.
`mcpIdentity` derives a public session identity from its digest, so listed session
records never expose the resumable handle. The same token can be used after
reconnect; separate participants need separate tokens. This is a binding and
resumption mechanism, not tenant isolation from the same OS user.

`session-lifecycle.ts` retains transactional enable/disable and interrupted
activation recovery. It is no longer driven by natural-language prompt matching.

`mcp-mailbox.ts` receives through the existing consumer with `deliver` returning
false. It persists the bounded pending batch in the receiver's receipt directory
and returns a `deliveryId`; no delivered receipt is written by receive itself.
`acknowledge_messages` validates the latest batch and session, then writes
receipts only after the client explicitly accepts the response. Corrupt delivery
state is preserved and rejected. The handle is derived from the repository,
subscription and ordered event IDs: an unchanged batch can reuse it, while a
changed batch supersedes the older handle.

The session lock precedes the publication lock. GC holds the publication lock
and probes session locks without waiting; busy receivers retain their events.
Acknowledgement and cleanup keep these same ordering and recovery boundaries.

## Shared monitoring and observation

`monitor.ts` runs the existing daemon under its singleton filesystem lock and
retries contention so another connected process can take over. Shutdown is tied
to the owning MCP connection, not the executable name of a specific host. Durable
subscriptions remain after disconnect; only an explicit leave closes them.
The monitor publishes events; it does not deliver them into an idle model.

`repository.ts` owns discovery, identity, initialization and migration readiness.
`inspectRepository` observes existing state without creating identities,
directories or locks. Read-only MCP tools and `core/repository-snapshot.ts` use this path.
`store.ts` retains bounded JSON I/O, atomic writes, directory checks and locks.
Recoverable MCP locks atomically publish complete ownership and serialize
verified-dead reclamation with unique bakery tickets; live/ambiguous records stay
protected. Recovery keeps the existing event/receipt journals and lock ordering.

The server has no HTTP listener or Web console. Tools select repositories through
explicit `cwd` arguments; no repository catalog is needed.

## Source coordination and connection delivery

`coordination.ts` stores opt-in `tracking.json` beside each existing repository
identity. Canonical upstream/origin URLs or local Git common directories link
related clones. The daemon groups registrations by source and serializes each
group under `coordination.lock`; it does not merge ordinary mailboxes. Local
remote registrations are recursive without overwriting existing member settings;
unrelated disk paths are not crawled. Invalid registrations are quarantined per
entry and retained as coverage errors instead of aborting global enumeration.
Groups scan concurrently under their individual locks. The daemon schedules scans
without awaiting remote work in its heartbeat/ref loop, and aborts/settles all
in-flight scans before releasing ownership.

`conflicts.ts` imports refs into a private bare observer matching the source's
SHA-1/SHA-256 object format. Separate temporary indexes and fixed-date synthetic
commits represent staged and working snapshots. A whitelist of non-executable
source normalization settings preserves CRLF/EOL, file-mode and related semantics;
global/system Git config and hooks stay disabled for observer operations.
Unsupported external-filter/private-attribute snapshots remain unknown. Native
`merge-tree` diagnoses Git conflicts; a receiver-side merged-tree path check also
rejects case-folding file/directory aliases, including fast-forward updates.
Filesystem folding is calibrated with existing paths, not just `core.ignorecase`.
Cleanly mergeable path overlap remains a separate warning.
Missing history, unsupported/racing snapshots and failed observations remain
unknown. No user ref/index/worktree is synchronized by analysis.

`cloud.ts` refreshes configured remote refs and GitHub fork/branch/open-PR
inventories using a one-minute cache, pinned SHAs, validated metadata and private
fetch refspecs. Cloud caches are source-scoped. Failures remain in reports;
stale fetch refs are never substituted for successful cloud observation.

Automatic findings use the existing message event/receipt machinery. Per-session
coordination cursors deduplicate stable reports, preserve interrupted publication
and distinguish subsequent changes/resolutions. Unread notices survive disconnect.

`connections.ts` binds joined/resumed subscriptions to this transport. It renews
10-second presence leases, pushes automatic notices and inbox resource updates,
and removes its presence on shutdown. Resource reads are connection-bound and do
not confirm receipt. There is no cross-process command execution or implicit ACK.
MCP logs/resources are transport signals, not guaranteed model-context injection.

## Validation

Core regressions preserve native Git races, publication interruption, GC journals,
path/UTF-8 handling and lock ordering. MCP tests use real stdio clients, explicit
message acknowledgement, disconnect/reconnect and the built source entry running
from an unrelated worktree with spaces.
The absence of a delivery receipt remains observable before explicit acceptance.
A successful local test does not establish hosted CI or an actual model workflow.
