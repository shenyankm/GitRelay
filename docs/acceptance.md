# GitRelay acceptance

## Current scope

The maintained integration is Codex hooks. Root sessions now
participate automatically, with explicit disable/re-enable retained. Native
macOS/Linux clients start a shared daemon that stops after all client processes
exit. Earlier native-host results are archived separately and do not validate
this Codex-only revision.

Local regression coverage includes:

- Ordinary native Codex hooks enroll root sessions.
- Automatic daemon singleton startup, Codex-client liveness, discovery failure,
  last-client shutdown and restart use isolated process fixtures.
- English/Chinese direct requests enable the current session only; questions,
  quoted examples, tool output, and negations do not override explicit choices.
- Activation is isolated by worktree, ref, adapter, session and native instance.
- Disabling preserves unread events, closes enrollment, and permits explicit rejoin.
- Codex context injection, Stop continuation, recursion and subagent guards.
- Installer ownership, cancellation, runtime digests, and safe configuration updates.
- Shared Git history, repository identity, independent inboxes, causal delivery,
  state validation, backpressure, daemon behavior and confirmed-event cleanup.

Run the checks for the exact source revision being evaluated:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build:codex-plugin
npm pack --dry-run
```

CI is configured for macOS/Linux on Node.js 22.19.0 and 24. A local pass does not
establish hosted CI status or actual hook discovery/trust in a client.

## Codex-only local validation: 2026-11-03

`npm run check` passed on the Codex-only working tree after the architecture refactor: 641 tests passed,
zero failed, one skipped and zero TODOs (642 total). Formatting, TypeScript,
release metadata and npm packaging checks also passed. The bundled Codex plugin
was built and its generated hook command exercised by the package tests.
The installed SDK was exercised without source files and its declarations were
compiled by a separate TypeScript consumer. Command-option regressions reject
unrelated flags before initializing state or starting work.

The regressions verify rejection of the removed platform in install/uninstall,
absence of its adapter and installer in source/build output, Codex installation
and recovery, and daemon shutdown after the last Codex client exits even if a
retired client remains. Shared state and legacy inbox identities are retained.

These are local CLI/core and generated-package results. Native CLI acceptance
was subsequently completed as recorded below. Hosted CI remains a separate gate
for the exact pushed commit and its supported Node/OS matrix.

## Native Codex CLI architecture acceptance: 2026-11-03

Codex CLI `0.166.0` and the existing `gpt-6.1-sol` configuration completed
14 real model turns in disposable worktrees with isolated Codex configuration
and GitRelay state. See the sanitized [native acceptance summary](https://github.com/shenyankm/GitRelay/blob/main/docs/evidence/2026-11-03-codex-architecture/summary.json)
for source/build fingerprints, independent checks and synthetic model markers.

- The four configured hook events were reviewed and trusted through the normal
  CLI `/hooks` interface, including again after managed installation changed the
  launcher. No hook-trust bypass was used. See the [official trust flow](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
- Two real sessions registered automatically and independently received the same
  peer message and real upstream-commit diff. The models returned unpredictable
  synthetic markers; receipts were checked separately and local dirty work survived.
- A message published while a native terminal tool was running reached the model
  in the same turn. A distinct forced Stop-continuation race was not isolated.
- Native disable survived resume, closed sessions were excluded from broadcasts,
  and explicit re-enable did not replay closed-period broadcasts. Shared lifecycle
  leave preserved an unread message; native re-enable delivered it, and a later
  retry did not rewrite its receipt.
- Managed uninstall/reinstall preserved the same native identity and receipts.
  Both manually copied and managed installed runtime files matched the current
  build byte-for-byte.

The first isolated plugin-list inspection exceeded the installer's 60-second
bound; a later standalone inspection and install retry succeeded. Installation
used `--allow-unverified` because `0.166.0` is outside the installer's previously
recorded version. This targeted result does not establish every newer version.

Automatic daemon startup was observed. Last-user-client shutdown was not forced
while other real user Codex processes remained. The test-owned daemon was stopped
only after checking its kernel command and working directory, and temporary Codex
credentials were removed. Native desktop rendering, Windows lifecycle, power-loss
durability and completed production work remain outside this acceptance.

## Repeat for runtime changes

In disposable repositories with isolated state and client configuration:

1. Install/reinstall the runtime; verify Codex discovery and normal `/hooks` trust.
2. Send ordinary prompts to two root conversations and confirm automatic registration.
3. Verify relevant upstream changes and messages reach each intended inbox.
4. Check tool-hook delivery, Stop continuation, idle-session limits and normal deduplication.
5. Disable one conversation, preserve unread messages, then resume and explicitly re-enable it.
6. Check offline delivery, Git failures, restart, upgrade/uninstall, and separate-repository isolation.

Record client versions, source revision, commands, raw outputs, host admissions,
receipts and model responses separately. Completed hook output or a delivery receipt does not prove the model read
every item or completed the requested adaptation.

## Historical evidence

The [dated acceptance archive](https://github.com/shenyankm/GitRelay/blob/main/docs/evidence/acceptance-history.md) retains earlier
synchronization, hook-overhead, lifecycle and native-host results. The raw
[`acceptance-results.json`](https://github.com/shenyankm/GitRelay/blob/main/docs/acceptance-results.json) and
[evidence files](https://github.com/shenyankm/GitRelay/blob/main/docs/evidence/README.md) include retired clients, old test counts,
and source/build hashes. They do not verify current compatibility or behavior.

Forced termination, power-loss durability, Windows client lifecycle and completed
production agent work remain outside the current acceptance claims. See
[platform boundaries](platform-matrix.md).
