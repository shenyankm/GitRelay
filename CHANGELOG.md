# Changelog

## [Unreleased]

### Rename to gitbeacon

- Rename the private source project and MCP server to `gitbeacon`; explicitly describe it as a Model Context Protocol server in the READMEs and project metadata.
- Update host configuration, help/diagnostics, inbox resource URIs, notification labels and the source-level `createGitbeaconServer` factory.
- Use a new `GITBEACON_*` environment/state namespace, `.gitbeacon-id` identities and gitbeacon event/lock/snapshot labels; old data is left untouched, not automatically imported.
- Rename the GitHub repository to `shenyankm/gitbeacon` and identify it as an MCP server; update the canonical URL while retaining the actual local checkout path.

### MCP-only breaking cleanup

- Delete legacy repository migration, cursor import, native instance identities, Pi proof handling and native-host delivery callbacks; remove the `migrate_repository` and old public-key `retire_session` tools and obsolete compatibility tests.
- Use standard MCP resource subscription/read/update/list-change workflows instead of logging notifications for business messages; keep explicit batch acknowledgement and connection-bound access.
- Retain transactional enrollment, Git safety checks, unread protection, GC journals and verified-dead lock recovery; old plugin and CLI state is outside the supported runtime.
- Keep SDK support for standard 2025 and 2026 MCP protocols; this is protocol support, not a native-client plugin compatibility layer.

### Source-only operation

- Make the Node.js project private and remove npm package files/bin/exports/types, install-time builds, tarball acceptance and publication-specific release checks.
- Remove the package SDK wrapper and declaration-only build; retain dependency locking, explicit JavaScript builds, strict type checking, core/MCP tests and CI.
- Replace package-install acceptance with private-project and built-source stdio checks; update current setup/release documentation while retaining historical evidence.

### Documentation alignment

- Index current source-only guides separately from historical evidence and pre-MCP optimization reports.
- Align setup, tracking/monitor lifecycle, notification/ACK guidance and migration tables with the current tools, including host-facing MCP instructions.
- Distinguish configured CI and dated model/package acceptance from verification of the current checkout; document rebuilding/restarting and future documentation checks.

### Coordination reliability fixes

- Recover verifiably dead MCP/monitor lock owners using serialized, crash-recoverable ownership tickets; atomically publish complete lock ownership and preserve ambiguous/live locks.
- Preserve existing source, GitHub and disabled preferences when discovering local clones.
- Quarantine corrupt registrations without blocking unrelated sources; retain explicit coverage gaps when ancestry cannot be established.
- Preserve safe source normalization settings in private snapshots, reject unsupported filtered/private-attribute snapshots, and diagnose receiver-side case-folding path collisions.
- Match observer object format to SHA-1/SHA-256 sources without deleting the legacy observation store.
- Run source scans independently of slow remote groups and the daemon heartbeat/ref loop; abort and settle in-flight scans on shutdown.
- Add negative regressions, eight-process stale-lock contention, SIGKILL takeover and stalled-SSH monitoring acceptance; support `diagnose-real.mjs --verify-fixes`.

### Source-centered automatic coordination

- Associate registered same-source clones through normalized upstream/origin identities and recursively discover local remotes, without merging existing mailboxes.
- Observe local branches and clean/dirty/staged worktree snapshots, configured remote branches, GitHub fork networks and open PRs using private observer objects/refs/indexes.
- Distinguish confirmed Git conflicts, mergeable path overlap and unknown coverage; publish deduplicated findings and resolution messages with existing explicit ACK/recovery.
- Add tracking/status/immediate-scan tools, connection-bound inbox resources, automatic MCP notifications and expiring online transport leases.
- Add real Git, multi-process stdio, read-only live GitHub PR and authenticated native Codex acceptance scripts; retain the boundary between transport notification and model activation.

### Breaking: MCP service

- Replace Codex hooks, the plugin installer/marketplace and shell subcommands with a local stdio MCP server.
- Add typed query, session, message, explicit acknowledgement, synchronization and maintenance tools.
- Remove the Web console, HTTP listener and catalog tools; select repositories with explicit tool cwd arguments.
- Bound tool-call rates and concurrency, sanitize diagnostics and allow same-connection protocol-version retries.
- Remove obsolete Codex environment actions, unused native-adapter options and the orphaned Darwin I/O benchmark helper; use gitbeacon in lock diagnostics.
- Preserve recovery invariants inside the current MCP state namespace; old native inbox identities are not transferred.
- Use connected MCP processes for shared monitoring and failover; automatic context injection and Stop continuation are removed.
- Keep source version 0.2.0. Hosted CI results require separate verification.

## [0.1.2] - 2026-11-04

- Publish under `@sistine29/git-relay`; npm rejected the unscoped name as too similar to the existing `gitrelay` package.
- Keep the `git-relay` CLI command, its aliases and Codex plugin ID unchanged.
- Update SDK imports, scoped installation tests and release checks while preserving the existing source tag `v0.1.1`.

## [0.1.1] - 2026-11-04

Source tag only; npm publication was rejected due to the unscoped package name.

- Reduce idle Codex hook Git subprocesses from five to three and skip unchanged repository metadata writes.
- Record 25-29% lower idle hook latency in two warm-cache comparisons, 666 passing local tests and 14 real Codex model turns.
- Retain full legacy publication recovery and corrupt-record validation; large retained-state performance remains inconclusive.

- Centralize session enable/disable transactions shared by Codex hooks and CLI controls.
- Separate status command handling and reject options unrelated to the selected command.
- Separate repository identity and recovery from file storage primitives; narrow session storage types.
- Provide a public package SDK with TypeScript declarations and explicit legacy import compatibility.

- Remove OpenCode integration, installer, SDK dependency, and dedicated tests; support Codex only.

- Consolidate plugin guidance into one GitRelay skill.
- Reuse healthy daemon status, remove redundant hook discovery, and load CLI maintenance/install modules only when needed.

- Automatically enroll native Codex root sessions; retain explicit opt-out and preserve unread messages.
- Start a shared daemon from native clients on macOS/Linux and stop it after the last client process exits.
- Support explicitly requested fast-forward synchronization under native Git index/ref locks; hooks remain read-only.
- Preserve the exact monitored branch when a tag has the same name, including Unicode whitespace.
- Cover read-only Git validation, synchronization and deterministic checkout races with isolated regressions.
- Trigger the Codex inspection timeout fixture after its process group is ready, including slow startup.
- Add formatting, unused-code and release-metadata checks to local validation and CI.
- Document source-release checks and reproducible benchmark evidence.
- Record historical targeted native acceptance and source-fingerprinted CLI benchmarks.
- Redact captured credentials and personal home paths from benchmark evidence.
- Align Codex plugin metadata with listing limits and declare the MIT license.
- Add manifest-limit assertions and a docs credential scan to local validation.

See [migration](docs/migration.md) for behavior changes and
[acceptance](docs/acceptance.md) for verified boundaries.
