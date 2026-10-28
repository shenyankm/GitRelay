# Platform capability and verification matrix

Only Codex and OpenCode v2 have maintained integrations. Loaded root sessions
participate automatically unless explicitly disabled. Existing clients need to
reload updated code; hook trust is still required.

| Capability                    | Codex                                                           | OpenCode v2                                                            |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Entry point                   | Lifecycle hooks / bundled plugin                                | Promise plugin (`id`, `setup`)                                         |
| Enable                        | First native hook; explicit rejoin after disable                | Creation event or normal prompt; explicit rejoin after disable         |
| Explicitly disabled           | Command hook retains the saved disable                          | Prompt hook retains the saved disable; creation listener stays active  |
| Busy delivery                 | Additional context after tools; Stop continuation               | Durable host queue                                                     |
| Already idle                  | Waits for next hook                                             | Five-second polling can start a turn                                   |
| Disable                       | Explicit prompt or `leave`; unread events preserved             | Same; cancels checks and drains known in-flight delivery               |
| Resume                        | Same native session retains choice                              | Same data root, creation time, session, worktree and ref retain choice |
| Recreated native ID           | Depends on host session-ID uniqueness                           | Different native instance; separate inbox and activation               |
| Installation                  | Managed user hooks, with separate `/hooks` trust; manual plugin | Managed global entry or manual project entry                           |
| Historical real-host evidence | CLI 0.164.0 on earlier source snapshots                         | 2.1.2 on earlier source snapshots                                      |
| Historical on-demand flow     | Local regressions and targeted native acceptance on 0.164.0     | Local regressions and targeted native acceptance on 2.1.2              |

The declared OpenCode peer range `^2.1.2` is a dependency constraint, not proof
that every matching host is accepted. Minimum full-lifecycle compatibility is
not established. Automatic daemon lifecycle uses macOS/Linux process discovery. Its current local
regressions are separate from the historical native acceptance below.
The new activation behavior requires rebuilding and refreshing
installed copies; source changes alone do not update clients.

The [2026-10-27 acceptance record](acceptance.md#targeted-native-acceptance-2026-10-27)
covers explicit opt-in/out, messages, real upstream commits, normal deduplication,
busy OpenCode queueing, restart/identity isolation, offline recovery,
reinstallation and separate-repository isolation. It does not establish every
failure mode or completed production agent work.

OpenCode deletion events stop in-process checks but do not automatically close
persisted subscriptions. Verify the exact old instance before manual `leave`.
Missed deletion events are not replayed. Host session lookup and prompt admission
are not atomic, and an accepted prompt cannot be retracted by disabling GitRelay.
A hung host admission can delay shutdown.

Messages have stable IDs and independent receipts; normal operation deduplicates,
while crash windows can cause retries. A receipt does not prove completed agent
work. Automatic branch synchronization remains blocked. Repository replacement,
legacy inboxes, and historical delivery proofs require explicit recovery rather
than deleting state.

See [integrations](integrations.md), [migration](migration.md), and
[acceptance](acceptance.md) for details and evidence boundaries.
