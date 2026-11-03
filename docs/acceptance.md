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

`npm run check` passed on the Codex-only working tree: 639 tests passed,
zero failed, one skipped and zero TODOs (640 total). Formatting, TypeScript,
release metadata and npm packaging checks also passed. The bundled Codex plugin
was built and its generated hook command exercised by the package tests.

The regressions verify rejection of the removed platform in install/uninstall,
absence of its adapter and installer in source/build output, Codex installation
and recovery, and daemon shutdown after the last Codex client exits even if a
retired client remains. Shared state and legacy inbox identities are retained.

This is local CLI/core and generated-package evidence. Real Codex discovery,
normal hook trust, native delivery and model behavior were not rerun for this
revision. Hosted CI and the supported Node/OS matrix were not verified locally.

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

The [dated acceptance archive](evidence/acceptance-history.md) retains earlier
synchronization, hook-overhead, lifecycle and native-host results. The raw
[`acceptance-results.json`](acceptance-results.json) and
[evidence files](evidence/README.md) include retired clients, old test counts,
and source/build hashes. They do not verify current compatibility or behavior.

Forced termination, power-loss durability, Windows client lifecycle and completed
production agent work remain outside the current acceptance claims. See
[platform boundaries](platform-matrix.md).
