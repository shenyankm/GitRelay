# GitRelay acceptance

## Current scope

The maintained integrations are Codex hooks and OpenCode v2. Root sessions now
participate automatically, with explicit disable/re-enable retained. Native
macOS/Linux clients start a shared daemon that stops after all client processes
exit. Historical native acceptance below predates this lifecycle change.

Local regression coverage includes:

- Ordinary native hooks/prompts and OpenCode creation events enroll root sessions.
- Automatic daemon singleton startup, either-client liveness, discovery failure,
  last-client shutdown and restart use isolated process fixtures.
- English/Chinese direct requests enable the current session only; questions,
  quoted examples, tool output, and negations do not override explicit choices.
- Activation is isolated by worktree, ref, adapter, session and native instance.
- Disabling preserves unread events, closes enrollment, and permits explicit rejoin.
- Codex context injection, Stop continuation, recursion and subagent guards.
- OpenCode durable queue admission, independent per-event receipts, stable IDs,
  retry after uncertain admission, session replacement, cancellation and recovery.
- Installer ownership, cancellation, runtime digests, and safe configuration updates.
- Shared Git history, repository identity, independent inboxes, causal delivery,
  state validation, backpressure, daemon behavior and confirmed-event cleanup.

Run the checks for the exact source revision being evaluated:

```sh
npm ci --ignore-scripts --omit=optional
npm run typecheck
npm test
npm run build:codex-plugin
npm pack --dry-run
```

CI is configured for macOS/Linux on Node.js 22.19.0 and 24. A local pass does not
establish hosted CI status or actual hook discovery/trust in a client.

## Protected opt-in synchronization: 2026-10-28

The complete `npm run check` passed locally with 751 passed, zero failed,
one skipped and zero TODOs (752 tests total). The 14 previously pending
synchronization cases now run as ordinary integration tests. They cover
fetch/fast-forward, dirty and ignored data, divergence, all
seven operation markers, exact Unicode refs, invalid HEAD bytes, ambiguous
configuration and operation-path decoding. Hooks/plugins still never opt in
to branch synchronization.

`tests/core/branch-sync-concurrency.test.ts` adds isolated real-Git barriers
before/after private merge and before real ref commit. Competing force
checkout/switch, commit, reset, restore, index updates, symbolic HEAD/ref writes
and worktree moves are rejected by native locks. Additional interleavings
cover HEAD/branch/upstream changes before prepare, tracking compare-and-swap
and an upstream symref that attempts to redirect fetch into a local branch.

Cancellation before/after index publication and after a real commit with an
uncertain acknowledgement retains recovery guards without rollback or retry.
Injected index-rename failure preserves both indexes and working files.
Existing locks and unsupported sparse/split/flagged indexes or configuration
are rejected before fetch. Native reference-transaction policy can reject a
real fast-forward before files change; post-mutation hooks and branch-specific
merge options are blocked rather than silently bypassed. The retained stopgap counterexample still proves
why a worktree lock plus a final HEAD check alone is insufficient.

These are local CLI/core regressions, not new native Codex/OpenCode or model
acceptance. Windows, reftable, conditional/per-worktree configuration and
nonordinary indexes remain unsupported for automatic writes. Raw filesystem
changes, deliberate lock bypass, escaped helper processes, network filesystems
and power-loss durability are outside the validated protocol. See
[write recovery](integrations.md#interrupted-synchronization-and-recovery).

## Single skill and hook overhead: 2026-10-28

The plugin now packages only the `git-relay` skill; its four Codex hook events
remain unchanged. The merged skill covers status, session controls, messages,
notification handling, installation, maintenance and synchronization limits.

`npm run check` passed with 705 passed, zero failed, one skipped and 14 existing
automatic-synchronization TODOs. New regression checks cover avoiding process
scans for a healthy daemon, retrying native startup when shutdown wins the lock,
and excluding installer/maintenance modules from the hook path. Existing Git
error, recovery, message delivery and opt-out checks remain covered.

Real Codex CLI 0.164.0 and OpenCode 2.1.2 lifecycle smoke checks were rerun with
the optimized runtime. Automatic enrollment, daemon startup and last-test-client
shutdown passed in isolated process scopes, as described below. Successful model
completion was not tested.

The [hook benchmark](performance.md#codex-hook-overhead-2026-10-28) retains all
polling and delivery checks, verifies immediate messages and Stop continuation,
and records the measured scope and limits. This local validation is separate
from hosted CI and model-task acceptance.

## Automatic lifecycle acceptance: 2026-10-28

On macOS arm64, `npm run check` passed with 702 passed, zero failed, one skipped
and 14 existing automatic-synchronization TODOs. See the source fingerprints and
bounded results in [the lifecycle summary](evidence/2026-10-28-automatic-lifecycle/summary.json).

- Real Codex CLI 0.164.0 used reviewed hooks trusted in an isolated configuration.
  An ordinary first turn enrolled its session and started the daemon without an
  enable prompt; closing its native host stopped the daemon.
- Real OpenCode 2.1.2 loaded a native plugin entry. Creating a session enrolled it
  and started the daemon without a prompt; closing the server stopped the daemon.
- Native runs used OS process tables filtered to test clients and descendants,
  allowing last-client shutdown checks without closing the user's active clients.
  They verify lifecycle and registration, not successful model completion.
- Isolated regressions cover simultaneous launches, either client keeping the
  daemon alive, last-client shutdown, subsequent restart, and discovery failure.
- The refreshed local Codex cache and OpenCode runtime matched the tested build.
  Existing hosts must reload their installed code. This is local evidence, not a
  hosted CI result or a release.

## Targeted native acceptance: 2026-10-27

The on-demand flow was exercised on macOS arm64 with Codex `0.164.0` and
OpenCode `2.1.2`, against implementation commit
`43bc73695104e69cfa3c81bae5c81af3abab418e`. Both installed runtime copies matched
the tested build byte-for-byte. The local `npm run check` passed: 508 tests
passed, none failed, one was skipped and 14 remain TODO for disabled automatic
synchronization. The lost-response regression also passed 20 consecutive runs.

| Scenario                            | Evidence established                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary prompts                    | New Codex conversations and two OpenCode conversations remained unregistered                                                                                                                                     |
| Explicit activation                 | Only the selected native sessions subscribed; ordinary resumed prompts retained their saved choice                                                                                                               |
| Shared message                      | Both real models reported the synthetic marker; native admission, hook injection and receipts were checked separately                                                                                            |
| Upstream commit                     | A real Git commit reached both inboxes; Codex reported its patch marker and OpenCode's native context contained the patch; local dirty files were preserved                                                      |
| Normal deduplication                | One persisted Codex hook injection and one OpenCode admission for the first event, including a later hook/poll                                                                                                   |
| Busy OpenCode session               | The next event appeared in the durable native inbox while a model turn was active                                                                                                                                |
| Disable                             | Native disable prompts closed subscriptions; broadcasts targeted zero recipients and ordinary resumed prompts stayed off                                                                                         |
| Native identity                     | Restart resumed the same OpenCode instance; recreating its ID stayed off and explicit re-enrollment created an independent inbox                                                                                 |
| Unread preservation                 | The old instance's unread event remained without a receipt while the new instance received into its own inbox                                                                                                    |
| Reinstallation and offline delivery | Codex plugin removal/reinstallation retained state and recovered after normal hook re-trust; OpenCode uninstall/reinstall preserved configuration and unread state, then recovered into the same native instance |
| Repository isolation                | An enabled session in a separate repository sharing the state root did not receive the source repository's event                                                                                                 |

The [machine-readable summary](evidence/2026-10-27-standardization/summary.json)
links sanitized native traces, runtime file hashes and the two committed
benchmark records. Fixture/source paths are replaced with placeholders; model
reasoning, opaque provider payloads, credentials and client configuration are
not published. The isolated server was stopped, synthetic subscriptions were
closed, and copied credentials were removed after verification.

These are targeted synthetic scenarios, not complete production-work acceptance.
Some identity/restart prompts used `resume: false` to verify native admission
without scheduling another model turn. Hook trust was granted through the normal
Codex interface, including again after plugin reinstallation; no trust-bypass
flag was used. Native Git/host failure coverage is not exhaustive, and these
results do not establish compatibility with every matching peer version.

## Repeat for runtime changes

In disposable repositories with isolated state and client configuration:

1. Install/reinstall the new runtime; verify Codex discovery and normal `/hooks`
   trust, and the OpenCode v2 entry.
2. Send ordinary prompts to two conversations. Confirm neither registers or polls.
3. Explicitly enable one conversation. Verify only it receives marked upstream
   changes and messages; the other conversation remains inactive.
4. Verify busy delivery, idle behavior, no duplicate normal admission, disable
   during an in-flight delivery, and preservation of unread messages.
5. Resume the same conversation and recreate an ID with a different native
   instance. Verify saved activation resumes only the original instance.
6. Check offline delivery, Git/host failures, restart, upgrade/uninstall, and a
   separate repository sharing the state root.

Record client versions, source revision, commands, raw outputs, host admissions,
receipts and model responses separately. A successful queue admission does not
prove the model read every item or completed the requested adaptation.

## Historical evidence

[`acceptance-results.json`](acceptance-results.json) is retained as historical
raw evidence from source snapshots before the two-client/on-demand refactor.
It includes retired clients, old test counts, and old source/build hashes. Its
results do not verify the current source or the current automatic lifecycle.
History remains available in Git; it is not a current support matrix.

Forced termination, power-loss durability, permanent host deduplication, Windows
client lifecycle and completed production agent work are not established by
these targeted runs. See [platform boundaries](platform-matrix.md).
