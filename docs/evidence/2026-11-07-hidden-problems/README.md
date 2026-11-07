# Real-environment adversarial MCP testing

Historical pre-fix findings. See [post-fix acceptance](../2026-11-07-hidden-fixes/README.md)
for the corrected implementation and current verification.

Tested commit: `b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1`.
Environment: macOS/Darwin arm64, actual case-insensitive filesystem, Node 22.23.2,
Apple Git 2.54.0, official MCP TypeScript client and real stdio server processes.
JSON timestamps are UTC (2026-11-07 locally, UTC+08).

**Seven problems were reproduced. The implementation has not been changed.**
All Git changes, merges, corrupt records, process kills and unavailable-network
conditions were confined to disposable local repositories and state directories.
No production worktree or cloud branch/PR was modified.

## Evidence layers

- `probes.json`: seven targeted adversarial scenarios, all reproduced on the
  tested commit. Real Git and real stdio MCP are used; no MCP responses are mocked.
- `positive-live-github.json`: authenticated read-only GitHub PR #15 from
  `koriym/Koriym.Psr4List`, real conflict → automatic notification → resource
  update → explicit ACK. This positive control still passes.
- `baseline.json`: the existing 447 regression tests and one production-package
  integration test still pass. These green tests do not cover the failures below.

The configuration-overwrite scenario clones the actual public GitHub repository,
then clones that local checkout again; GitHub source resolution is authentic.
The slow-network scenario opens a real localhost SSH connection and deliberately
withholds the server handshake for eight seconds. It is network fault injection,
not an assertion that GitHub itself was slow. The corruption case modifies only
a disposable unrelated repository's tracking JSON. The crash case sends SIGKILL
only to the test-owned MCP process selected as monitor owner.

## P1 — Monitor owner crash prevents automatic takeover

**Probe:** `sigkill-monitor-owner-failover`.

Two independent MCP processes join the same repository. After its initial report
is complete and no publication/group lock is held, the monitor owner is killed
with SIGKILL. A peer then commits a real conflicting change.

Observed after 12.5 seconds:

- the remaining MCP process is alive, but `monitor_status.running` is false;
- its last coordination report has not advanced;
- stderr repeatedly reports `Stale git-relay lock`;
- a manual `scan_repository` still detects the actual conflict.

Root cause: [store.ts:245–254](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/store.ts#L245) rejects a lock whose
PID has disappeared, while [monitor.ts](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/monitor.ts) retries
without a stale-owner recovery path. Graceful shutdown releases locks and passes
existing failover tests; abnormal host/server termination does not.

Impact: unattended automatic notifications can remain stopped until operator
recovery. A fix must preserve ownership/race guarantees, not blindly unlink locks
based on age or PID alone.

## P1 — Registering a local clone disables the original GitHub tracking setting

**Probe:** `recursive-registration-disables-existing-github-observation`.

1. Clone the actual public repository and enable its tracking with `github=true`.
2. Clone that checkout locally.
3. Call the real MCP `track_repository({github:false})` on the child clone.

Observed: the original checkout's `github` setting changes from true to false,
although the tool was invoked for the child. Both remain in the same source group.

Root cause: recursive registration calls
`trackRepository(tree.path, {source, github:false}, ...)` unconditionally at
[coordination.ts:162](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/coordination.ts#L162), overwriting an
existing participant's explicit settings. If no other member retains `github=true`,
fork/PR API observation stops for the entire group.

Impact: an ordinary local enrollment can silently remove previously authorized
cloud coverage. Discovery should not overwrite existing member preferences.

## P1 — One corrupt tracking record blocks unrelated source scans

**Probe:** `one-corrupt-tracking-file-blocks-unrelated-source`.

A healthy source first produces a clean report. An independent source's tracking
JSON is truncated. A real conflicting edit is then made in the healthy source,
and its explicitly scoped `scan_repository` is requested.

Observed:

- the healthy scan fails because of the unrelated corrupt record;
- the healthy source's report remains its old clean report;
- its `coordination_status` has no `lastScanError`;
- restoring the unrelated bytes immediately allows the healthy scan to detect
  the real conflict.

Root cause: [coordination.ts:187](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/coordination.ts#L187) parses
all tracking files before the source filter and per-group error handling at
[coordination.ts:410](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/coordination.ts#L410). Failures during
this enumeration also bypass the per-group error journal. The background scanner
uses the same entry point.

Impact: one damaged/unsupported record breaks source isolation and can leave
apparently clean historical status without a recorded current scan failure.

## P1 — CRLF normalization creates a false confirmed conflict

**Probe:** `crlf-false-conflict`.

The receiver is a real local clone created with `core.autocrlf=true`, so Git
materializes and indexes its CRLF working files normally. Only `other.txt` is
modified locally; a peer changes `shared.txt`.

Observed:

- source Git reports only `other.txt` as locally modified;
- MCP reports a confirmed conflict in `shared.txt`;
- native Git merges the peer change successfully;
- the unfinished local `other.txt` is preserved.

Root cause: snapshotting runs against the observer Git directory at
[conflicts.ts:190](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/conflicts.ts#L190), whose config does not
carry the source's normalization settings. `git add --all` consequently hashes
unchanged CRLF files as different content, manufacturing changes that the source
repository does not have.

Impact: a supported and common Git configuration produces false conflict reports.
A fix needs safe normalization semantics, not wholesale re-enabling untrusted
Git filters/global merge drivers.

## P1 — Case-insensitive path collisions are reported as no findings

**Probe:** `case-insensitive-filesystem-collision`.

The actual test volume is case-insensitive and source Git has
`core.ignorecase=true`. One branch adds `Model.ts`; another adds `model.ts`.

Observed:

- MCP returns zero findings and zero coverage errors;
- native Git's control merge succeeds and indexes both spellings;
- both working paths resolve to the same inode and contain the uppercase
  branch's contents, so the lowercase implementation is not independently
  materialized.

Root cause: path overlap at
[conflicts.ts:118](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/conflicts.ts#L118) uses case-sensitive
comparison, and clean `merge-tree` output is treated as sufficient. A Git tree
can represent both paths even though the receiver's filesystem cannot.

Impact: the collision is missed on the tested macOS platform. The test's native
control merge demonstrates the overwrite/collision; the MCP itself did not write
or merge the production working tree. Receiver-side path representability needs
a separate check from Git's abstract merge result.

## P2 — One stalled remote blocks unrelated source monitoring

**Probe:** `slow-remote-blocks-healthy-source-monitoring`.

The first source's actual SSH transport reaches a test-owned TCP endpoint that
withholds its handshake. A second, unrelated source already contains a real local
conflict.

Observed over eight seconds of held connection:

- the daemon heartbeat continues to say it is running;
- the healthy source still has no coordination report;
- releasing the unrelated SSH connection immediately allows the healthy source
  to be analyzed and its conflict detected.

Root cause: source groups are awaited serially at
[coordination.ts:417–419](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/coordination.ts#L417), and the daemon
awaits the entire scan before its next loop at
[daemon.ts:239](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/daemon.ts#L239). Network operations occur inside
the same scan path before local findings are published.

Impact: remote delays consume the monitoring budget of otherwise healthy local
repositories. This is an isolation/latency failure, not evidence of data loss or
a measured large-network throughput limit.

## P2 — SHA-256 repositories cannot be imported into the observer

**Probe:** `sha256-git-repository-observer-algorithm`.

A real `git init --object-format=sha256` repository has two branches making
conflicting changes. Its source object IDs are 64 characters long.

Observed: scanning reports
`fatal: mismatched algorithms: client sha1; server sha256` and cannot diagnose the
conflict. It remains unknown rather than incorrectly reporting clean.

Root cause: [conflicts.ts:63](https://github.com/shenyankm/GitRelay/blob/b5cda33b2ae12fb2ca1cb4938c7f569a799e0ff1/src/core/conflicts.ts#L63) initializes the
observer with the default SHA-1 format, without matching the source's object
format. Existing core handling of 64-character object IDs does not make the new
observer compatible with SHA-256 Git storage.

## Reproduce

From the tested checkout, with dependencies installed:

```sh
npm run build
node --experimental-strip-types scripts/diagnose-real.mjs
# One scenario:
node --experimental-strip-types scripts/diagnose-real.mjs crlf-false-conflict
# Positive controls:
npm test
node scripts/acceptance-live.mjs
```

The diagnostic script emits observations. A zero exit code means the diagnostic
ran without a harness error, **not** that the product passed the scenarios. Check
`results[].reproduced`. An unexpected probe failure is recorded as `probeError`.
The case-folding scenario skips on a case-sensitive volume; SHA-256 skips if the
installed Git lacks that object format. The GitHub case requires network access;
other fault scenarios do not simulate GitHub metadata.

Recommended fix order: crash recovery, preference preservation and corrupt-source
isolation first; then snapshot normalization and filesystem collisions; then
network scheduling and object-format compatibility. Keep these as negative
regressions rather than weakening the assertions to preserve green status.

Not tested here: native model idle wake-up, desktop GUI, Windows/Linux execution,
large-fork performance, or destructive cloud-side operations. No fixes, commits
or pushes were performed as part of this diagnostic request.
