# Performance evidence — 20 rounds, 2026-11-07

The [report and round ledger](../../performance-20-rounds-2026-11-07.md) explain the seven retained and thirteen reverted candidates.

- `summary.json`: starting/final production source fingerprints, twenty decisions, initial A/B samples and output hashes. Round 3 was later rejected by confirmation.
- `confirmation.json`: independent repeats of initially retained candidates, including the negative paging result.
- `combined.json`: whole starting snapshot versus final retained combination; slower and unchanged controls are preserved.
- `follow-up-controls.json`: large paging repeat and Unicode/escaped/empty report controls.
- `retained.patch`: combined production delta; reverse it in a disposable source copy to reconstruct the starting baseline.
- `checks.log`, `delivery.json`, `validation.json`: actual regression and transport-smoke acceptance.
- `discarded-attempts.json`: patch-generation and concurrency-expression mistakes, superseded by corrected runs.
- `round-01.patch` through `round-20.patch`: exact attempted source changes, including reverted candidates; these are experimental patches, not instructions to apply all twenty.

Only local disposable repositories and state were used. No remote or user Git writes, native model turns, new dependencies or persistent benchmark daemons were involved. Initial fixture/module setup and output hashing are outside timing. Strict hashes verify observable outputs; synthetic fixture results do not establish production traffic, network or provider performance.

Validation: **428/428 passed**; details and source hashes are recorded in `validation.json`. Temporary source snapshots are test artifacts; baseline fingerprints plus preserved patches distinguish them from the underlying Git commit.
