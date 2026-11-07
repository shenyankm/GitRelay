# MCP acceptance

gitbeacon 0.2 replaces the hook/CLI integration with a local stdio MCP server.

## Required checks

```sh
npm run check
node scripts/benchmark-delivery.mjs
```

The combined check validates formatting, strict TypeScript, private source-project
metadata, the core regression suite and real MCP stdio tests. Source-runtime
checks exercise the built entry from a worktree with spaces, verify CLI help and
version metadata, and reject npm distribution entry points/declaration artifacts.
There is no npm packing, package installation or registry-publication gate.

MCP acceptance covers discovery and input validation, read-only observation,
independent private session handles, receive without acknowledgement,
disconnect/reconnect, explicit/idempotent acceptance, stale/damaged batch
rejection, partial-write retry, monitor ownership and repository isolation.
Protocol discovery checks reject removed Web and legacy migration tools. Resource
regressions cover 2026 listen filters, 2025 subscribe/unsubscribe, connection-bound
access, resource-list changes and the absence of business logging notifications.
Namespace checks preserve old data without importing its identities or inbox.
Safety regressions cover bounded/refilling tool-call budgets, concurrent-call
limits, diagnostic sanitization and same-connection protocol-version retry.
Existing Git/GC/storage race and corruption regressions remain required.

Historical MCP refactor evidence is recorded under
[evidence/2026-11-05-mcp/summary.json](evidence/2026-11-05-mcp/summary.json).
Local SDK acceptance, native Codex MCP discovery/calls, a real model workflow,
desktop GUI behavior and hosted CI are independent evidence layers.

The historical [follow-up usability run](evidence/2026-11-05-mcp-usability/summary.json)
repeated its then-current 433 checks and exercised 21 successful native Codex tool calls,
including host restart, unread recovery, explicit acknowledgement and dirty-work
preservation. Its browser checks describe the since-removed Web console, not the
current runtime. No model turns were run.

## Source coordination acceptance

The source-centered implementation adds real-Git tests for independent and nested
clones, unmerged peer branches, staged/dirty snapshots, structural conflicts,
cleanly mergeable overlap, missing repositories, resolution/deduplication,
corrupt publication cursors, sparse snapshots and observer merge-driver isolation.
GitHub pagination/fork/open-PR/closure fixtures exercise real local fetches and
merge diagnosis; fixture HTTP responses are not counted as live API evidence.

Real independent stdio processes verify automatic detection/push, connection-bound
resource access, online/offline leases, no implicit ACK and unread reconnection.

Additional acceptance is deliberately separate from `npm test`:

```sh
# Read-only live GitHub source/open-PR + actual local conflict → push → ACK
node scripts/acceptance-live.mjs https://github.com/koriym/Koriym.Psr4List
# Real authenticated native Codex model/tool consumption, with explicit ACK
node --experimental-strip-types scripts/acceptance-codex.mjs
```

Both scripts use disposable local state, preserve user Git work, and make no
remote writes. The native model used polling fallback; this does not establish
idle-model wake-up or automatic context injection. Its operator pre-enables
tracking because native open-world tool approvals are independent of MCP input
validation. See [coordination](coordination.md) and
[evidence/2026-11-07-coordination](evidence/2026-11-07-coordination/README.md).

## Adversarial reliability regressions

The seven findings in [hidden-problem evidence](evidence/2026-11-07-hidden-problems/README.md)
are covered by core/MCP regressions for verified-dead lock recovery and races,
eight competing processes, SIGKILL monitor takeover, recursive preference
preservation, corrupt-source isolation, CRLF snapshot semantics, case-folding
file/directory/fast-forward collisions, matching SHA-256 observers and repeated
healthy scans while another source's SSH handshake is stalled.

```sh
node --experimental-strip-types scripts/diagnose-real.mjs --verify-fixes
```

Unlike diagnostic-only mode, `--verify-fixes` exits unsuccessfully if a selected,
applicable scenario does not demonstrate its corrected positive behavior. Saved
original findings remain historical evidence, not current acceptance results.
See [fix acceptance](evidence/2026-11-07-hidden-fixes/README.md).

## Evidence currency

The gitbeacon MCP-only refactor is an incompatible namespace/protocol-surface
change. Earlier GitRelay model, logging-notification and package results are
historical evidence, not a rerun against this checkout.
Use `npm run check` for the current checkout's test inventory; dated test totals
are not a current pass count. The coordination and hidden-fix evidence predates
the source-only change and includes now-retired package checks. Those results
remain valid for their recorded source snapshots, not the current distribution.
The manifest version alone does not identify a tested checkout: record the Git
commit, uncommitted source changes/fingerprints, environment and commands when
saving new evidence. Local regression results, live GitHub API checks, model
consumption and hosted CI must remain separate claims.

## Historical results

The archive preserves pre-MCP benchmarks and hook/native-model traces. They
validate their recorded versions only and do not establish current MCP latency,
model behavior or host compatibility. Historical npm installation/tarball results
are retained as evidence, not as a current distribution or acceptance workflow. See the
[evidence archive](evidence/README.md).
