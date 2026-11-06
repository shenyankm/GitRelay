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
in-flight operations and starts monitoring lazily on participation. `src/index.ts` exports the embeddable server factory.

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
state is preserved and rejected. A later receive can supersede an older batch.

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

The server has no HTTP listener or Web console. Tools select repositories through
explicit `cwd` arguments; no repository catalog is needed.

## Validation

Core regressions preserve native Git races, publication interruption, GC journals,
path/UTF-8 handling and lock ordering. MCP tests use real stdio clients, explicit
message acknowledgement, disconnect/reconnect and production package installs.
The absence of a delivery receipt remains observable before explicit acceptance.
A successful local test does not establish hosted CI or an actual model workflow.
