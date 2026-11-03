# I/O and size optimization rounds

Requested scope: 50 consecutive, evidence-backed optimization rounds. This log
tracks completed experiments, including rejected candidates; it does not count
repeated tests as additional rounds. Current progress: **18 / 50 evaluated,
14 retained**. Work remains active.

The starting worktree was clean at `f71f6f4`. Saved baseline runtime:
`/tmp/gitrelay-optimization-20261103/baseline-dist`. Evidence and comparison
scripts are in `docs/evidence/2026-11-03-optimization-rounds/` in the source
checkout. That archive is deliberately excluded from npm and plugin packages;
shipped documentation links historical evidence to the source repository.

| Round | Candidate                                                                     | Evidence and decision                                                                                                                                                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Exclude historical evidence from the npm package                              | Retained. Removes 875,946 archive bytes; keeps source/build inputs, runtime, declarations, licenses and user docs, including `acceptance-results.json`. Exact tarball sizes and file-list comparison: `packaging.json`.                                                                                                                     |
| 2     | Exclude the same archive from the Codex plugin                                | Retained. Before other edits, file bytes fell from 1,499,951 to 624,005, with 48 fewer files. Installed hooks still execute from a path containing spaces. Final build totals: `packaging.json`.                                                                                                                                            |
| 3     | Return before heartbeat I/O when the daemon lock is absent or unreadable      | Retained. Twelve alternating warm-cache samples of 200 calls each: missing-lock median 0.0418 → 0.0220 ms per call; live control 0.1068 → 0.1075 ms. Results and assertions: `daemon.json` and `compare-daemon.mjs`.                                                                                                                        |
| 4     | Reuse one bounded buffer during installer digest traversal                    | Retained for allocation savings. For 1,000 files, measured read-buffer allocation falls from 4,097,000 / 4,711,390 bytes to 65,536 bytes for uniform / mixed sizes. Digest equality and mutation/cancellation regressions pass. Timings stay about 82–83 ms; no latency improvement is claimed. See `digest.json` and `compare-digest.mjs`. |
| 5     | Reprint stripped TypeScript using Node's transform mode                       | Rejected. Only about 0.5% fewer bytes across the emitted application JS, excluding vendor and declarations. Insufficient benefit to justify changing every runtime module's representation without additional equivalence acceptance. See `build-output.json` and `compare-build-output.mjs`.                                               |
| 6     | Discover the Git root and common directory concurrently from the original cwd | Rejected by a real-Git counterexample: relative `GIT_DIR` and explicit `GIT_WORK_TREE` select a different common directory from the pinned-root sequence, changing repository identity. See `discovery.json` and `probe-discovery.mjs`.                                                                                                     |
| 7     | Build the event-format conflict map only when a POSIX record name is present  | Retained. 10,000 ordinary events: 212.1 → 201.9 ms. A separate single heap-growth probe before the first file open observed 12.4 → 3.8 MB; this is not peak RSS. POSIX scan control remained about 20 ms for 1,000 events, and duplicate/GC race tests pass. See `mailbox.json`.                                                            |
| 8     | Use a set for existing upstream recipients during repeated publication        | Retained. 5,000 existing recipients: unchanged publication 21.1 → 2.6 ms; extension 56.9 → 4.4 ms. Exact resulting recipient order is asserted. Ten-recipient controls remain about 0.1 / 0.3 ms. See `mailbox.json`.                                                                                                                       |
| 9     | Inspect message file paths in settled batches of at most 32                   | Retained. Full send with 1,000 existing file paths: 26.0 → 21.2 ms; zero-file control 17.7 → 17.8 ms. Directory rejection and input-order errors remain; failure/cancellation drain tests verify no event is published. See `send-files.json`.                                                                                              |
| 10    | Read GC trash records in settled batches of at most four                      | Retained. Dry-run GC for 1,000 trash messages: 48.6 → 26.9 ms, and for 100: 5.3 → 3.3 ms. Empty control unchanged. A corrupt-first-record test keeps the publication lock through all in-flight reads and preserves every file. See `gc.json`.                                                                                              |
| 11    | Read unique GC ref cursors in settled batches of at most 32                   | Retained. Dry-run GC for 1,000 refs: 78.0 → 41.9 ms, and for 100: 6.7 → 4.4 ms. Empty control remains below 0.3 ms. A malformed cursor drains peer reads before unlock, without deleting events. See `gc.json`.                                                                                                                             |
| 12    | Exclude SDK declarations from the private Codex plugin                        | Retained. Removes 11 declaration files / 14,522 bytes. Every remaining plugin file hash stays identical in the isolated comparison. Npm SDK declarations and their consumer compilation remain intact. See `plugin-types.json`.                                                                                                             |
| 13    | Decode each streamed Git index header only once                               | Retained for Node CPU. Real 100,000-entry index: 97.4 → 87.5 ms Node CPU; wall time 280.6 → 279.6 ms is effectively unchanged. Exact filenames/gitlinks and malformed/chunked/cancelled stream regressions pass. See `index-header.json`.                                                                                                   |
| 14    | Ship a prebuilt npm runtime rather than source/build inputs                   | Retained. Compressed tarball 276,468 → 170,723 bytes; unpacked 1,080,580 → 606,040 bytes. Real offline production install passes without build dependencies or ignored scripts. SDK declarations, hooks and vendor license remain. Build/benchmark commands now explicitly require a source checkout. See `npm-runtime.json`.               |
| 15    | Exclude historical acceptance JSON from the Codex plugin                      | Retained. Removes one 41,324-byte archive; every other file hash stays unchanged in the isolated comparison. Source archive remains and shipped docs link to it. See `plugin-archive.json`.                                                                                                                                                 |
| 16    | Replace spread/map with `Array.from` in path matching                         | Rejected and reverted. 100,000-path controls slow from 20.4 → 21.1 ms (case-sensitive) and 24.8 → 26.6 ms (case-folded); Node CPU also increases. No memory gain was measured. See `matcher-array-from.json`.                                                                                                                               |
| 17    | Deduplicate gitlinks in the streamed reader before joining paths              | Rejected and reverted. Real normal/conflicted-index controls show mixed CPU results and no consistent wall-time benefit. The existing downstream set already removes duplicate paths. No memory reduction was established. See `gitlink-set.json`.                                                                                          |
| 18    | Settle four independent publication-state reads concurrently                  | Retained. Existing publication 0.1049 → 0.0846 ms; new publication 0.2323 → 0.2031 ms. Lock held throughout; samples exclude repository discovery and lock acquisition. Conflict-first tests prove earlier errors still win and peer reads finish before unlock. See `publication-io.json`.                                                 |

The digest buffer is lazy and local to one invocation. A single tiny file can
allocate more buffer space than before; the per-call read buffer remains capped
at 64 KiB. Descriptor checks, file/directory witnesses, digest ordering and final
rechecks are unchanged. No dependency, public API, persistent cache or state
format was added.

Validation gates and exact source/build fingerprints are recorded separately in
`validation.json` (rounds 1–6) and `validation-12.json` (rounds 7–12) and `validation-18.json` (rounds 13–18). Targeted
checks cover POSIX format collisions, exact recipient order, input snapshots,
failed/cancelled batch draining, GC preservation, installed plugin hooks and
installed SDK compilation. Timing and memory probes run separately from tests.
The round-12 full gate passed 647 tests with one skipped and zero failures;
`packaging-12.json` records that snapshot; `packaging-18.json` records the latest artifacts.
Round 14 supersedes the broader npm inclusion kept in round 1. Historical
evidence and build inputs remain in the repository, while npm packages contain
prebuilt runtime files and declarations.

Reproduce after saving the named baseline builds and building the candidate.
For rejected candidates, apply the recorded candidate patch first; the working
tree retains the accepted implementations:

```sh
node docs/evidence/2026-11-03-optimization-rounds/compare-daemon.mjs /absolute/baseline/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-digest.mjs /absolute/baseline/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-build-output.mjs
node docs/evidence/2026-11-03-optimization-rounds/probe-discovery.mjs
node --expose-gc docs/evidence/2026-11-03-optimization-rounds/compare-mailbox.mjs /absolute/round-06/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-send-files.mjs /absolute/round-06/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-gc.mjs /absolute/round-09/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-index.mjs /absolute/round-12/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-matcher.mjs /absolute/round-12/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-gitlinks.mjs /absolute/round-15/dist
node docs/evidence/2026-11-03-optimization-rounds/compare-publication-io.mjs /absolute/round-15/dist
node docs/evidence/2026-11-03-optimization-rounds/verify-runtime-package.mjs /absolute/git-relay-0.1.0.tgz
```

These are macOS arm64 / Node 22.23.2 synthetic measurements with warm local
caches and uncontrolled external load. Buffer allocation is not peak RSS;
filesystem byte counts are not physical I/O. Native Codex/model latency,
Windows, cold caches, network filesystems and remote CI were not checked in
this pass. Concurrent GC reads can retain more buffers and parsed records than
serial reads; the four-read bound does not establish a total-memory limit.
The remaining 32 rounds have not been performed or claimed complete.
