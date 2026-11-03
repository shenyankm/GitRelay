# Changelog

## [Unreleased]

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

This section is not a published release. See [migration](docs/migration.md) for
behavior changes and [acceptance](docs/acceptance.md) for verified boundaries.
