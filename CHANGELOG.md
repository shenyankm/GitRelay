# Changelog

## [Unreleased]

- Consolidate plugin guidance into one GitRelay skill.
- Reuse healthy daemon status, remove redundant hook discovery, and load CLI maintenance/install modules only when needed.

- Automatically enroll native Codex and OpenCode v2 root sessions; retain explicit opt-out and preserve unread messages.
- Start a shared daemon from native clients on macOS/Linux and stop it after the last client process exits.
- Keep automatic branch synchronization blocked pending safe worktree binding.
- Preserve the exact monitored branch when a tag has the same name, including Unicode whitespace.
- Separate read-only Git validation from pending synchronization tests and retain a deterministic checkout-race regression.
- Stabilize the OpenCode lost-response regression around independently persisted receipts.
- Keep mocked polling active while testing admission retries, including ticks during an in-flight scan.
- Trigger the Codex inspection timeout fixture after its process group is ready, including slow startup.
- Add formatting, unused-code and release-metadata checks to local validation and CI.
- Document source-release checks and reproducible benchmark evidence.
- Record targeted Codex/OpenCode native acceptance and source-fingerprinted CLI benchmarks.
- Redact captured credentials and personal home paths from benchmark evidence.
- Align Codex plugin metadata with listing limits and declare the MIT license.
- Add manifest-limit assertions and a docs credential scan to local validation.

This section is not a published release. See [migration](docs/migration.md) for
behavior changes and [acceptance](docs/acceptance.md) for verified boundaries.
