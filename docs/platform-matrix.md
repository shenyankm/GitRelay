# Platform capability and verification matrix

Only Codex has a maintained integration. Loaded root sessions
participate automatically unless explicitly disabled. Existing clients need to
reload updated code; hook trust is still required.

| Capability                    | Codex                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point                   | Lifecycle hooks / bundled plugin                                                                                                            |
| Enable                        | First native hook; explicit rejoin after disable                                                                                            |
| Explicitly disabled           | Command hook retains the saved disable                                                                                                      |
| Busy delivery                 | Additional context after tools; Stop continuation                                                                                           |
| Already idle                  | Waits for next hook                                                                                                                         |
| Disable                       | Explicit prompt or `leave`; unread events preserved                                                                                         |
| Resume                        | Same native session retains choice                                                                                                          |
| Recreated native ID           | Depends on host session-ID uniqueness                                                                                                       |
| Installation                  | Managed user hooks, with separate `/hooks` trust; manual plugin                                                                             |
| Targeted current CLI evidence | 0.166.0 on the Codex-only architecture refactor; see [native acceptance](acceptance.md#native-codex-cli-architecture-acceptance-2026-11-03) |
| Historical real-host evidence | CLI 0.164.0 on earlier source snapshots                                                                                                     |
| Historical on-demand flow     | Local regressions and targeted native acceptance on 0.164.0                                                                                 |

Automatic daemon lifecycle uses macOS/Linux process discovery. Its current local
regressions are separate from the historical native acceptance below.
The new activation behavior requires rebuilding and refreshing
installed copies; source changes alone do not update clients.

The [2026-10-27 acceptance record](https://github.com/shenyankm/GitRelay/blob/main/docs/evidence/acceptance-history.md#targeted-native-acceptance-2026-10-27)
covers explicit opt-in/out, messages, real upstream commits, normal deduplication,
restart/identity isolation, offline recovery,
reinstallation and separate-repository isolation. It does not establish every
failure mode or completed production agent work.

Messages have stable IDs and independent receipts; normal operation deduplicates,
while crash windows can cause retries. A receipt does not prove completed agent
work. Explicit `status --auto-sync` can fast-forward supported clean branches
under the [protected write protocol](integrations.md#automatic-branch-synchronization);
hooks remain read-only. Repository replacement,
legacy inboxes, and historical delivery proofs require explicit recovery rather
than deleting state.

See [integrations](integrations.md), [migration](migration.md), and
[acceptance](acceptance.md) for details and evidence boundaries.
