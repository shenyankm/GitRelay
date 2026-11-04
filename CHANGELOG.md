# Changelog

## [Unreleased]

## [0.1.1] - 2026-11-04

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
