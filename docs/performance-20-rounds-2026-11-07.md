# MCP performance: 20 rounds, 2026-11-07

Starting point: the uncommitted plugin/context-trim implementation on `d0d72cdc`. Earlier plugin, skills, paging and summary behavior are preserved. This round adds no dependency, tool, durable cache, state format or background process.

**20 candidates evaluated: 7 retained, 13 reverted.** Each measured candidate used independent source-module snapshots against the same disposable local Git/state fixture, one warm-up and six order-balanced A/B samples. Retained candidates received another independent A/B comparison. A single screening result did not qualify as a repeatable improvement.

## Final combination against the starting snapshot

| Workload        |              Before → final |
| --------------- | --------------------------: |
| scan-many       | 774.84 → 363.82 ms (+53.0%) |
| scan-small      | 432.11 → 379.27 ms (+12.2%) |
| compare-wide    |   40.91 → 25.96 ms (+36.6%) |
| worktree-clean  |   36.74 → 23.62 ms (+35.7%) |
| presence-many   |    12.33 → 6.10 ms (+50.5%) |
| presence-shared |    12.58 → 3.64 ms (+71.1%) |
| receive-small   |    63.70 → 63.77 ms (-0.1%) |
| status-small    |    38.13 → 37.90 ms (+0.6%) |
| report-large    |    56.16 → 1.39 ms (+97.5%) |

The multi-session whole scan uses real local Git snapshots, merge diagnosis, report construction and publication: **774.84 → 363.82 ms, 53.0% lower** in this fixture. This is core scan latency, excluding MCP transport and model turns. Report construction is an isolated helper measurement. These reductions must not be added together or presented as a provider latency improvement.

The large-detail control was slower in the first combined comparison (935.34 → 1,028.24 ms, 9.9%). Its mailbox/repository/storage/Git/changes modules are byte-identical between starting and final variants. The follow-up was 496.55 → 493.76 ms (0.6% difference), so no stable paging speedup or regression is established. Both raw comparisons are retained.

## Round ledger

| Round | Candidate                                                                      |         Primary measurement | Decision                    |
| ----: | ------------------------------------------------------------------------------ | --------------------------: | --------------------------- |
|     1 | Avoid replacing an unchanged pending delivery journal                          |    46.50 → 45.50 ms (+2.1%) | Reverted                    |
|     2 | Measure detail UTF-8 length once during record validation                      |  680.41 → 684.57 ms (-0.6%) | Reverted                    |
|     3 | Slice ASCII detail pages without copying the full snapshot to a Buffer         |  641.87 → 600.08 ms (+6.5%) | Reverted after confirmation |
|     4 | Avoid reserializing multi-notification batches already bounded by the consumer |    42.23 → 42.16 ms (+0.2%) | Reverted                    |
|     5 | Reuse validated receipts during the same locked acknowledgement                |    20.31 → 19.64 ms (+3.3%) | Reverted                    |
|     6 | Enrich history events in settled groups of four                                |    71.40 → 68.51 ms (+4.0%) | Reverted                    |
|     7 | Overlap independent Git and mailbox status observations                        |    63.08 → 60.45 ms (+4.2%) | Reverted                    |
|     8 | Read connection presence in settled groups of sixteen                          |    11.10 → 4.98 ms (+55.1%) | Retained                    |
|     9 | Avoid rereading a session already observed online in this call                 |     4.84 → 2.88 ms (+40.5%) | Retained                    |
|    10 | Reuse the non-streaming strict Git path decoder                                |    95.05 → 96.01 ms (-1.0%) | Reverted                    |
|    11 | Avoid allocating parsed event metadata just to filter names                    |    45.35 → 45.54 ms (-0.4%) | Reverted                    |
|    12 | Reduce session read concurrency from 32 to 16                                  |      5.87 → 6.17 ms (-5.1%) | Reverted                    |
|    13 | Reduce event read concurrency from 32 to 16                                    |    48.24 → 49.52 ms (-2.7%) | Reverted                    |
|    14 | Reduce the minimum state-read buffer from 256 to 64 bytes                      |      1.25 → 1.28 ms (-2.6%) | Reverted                    |
|    15 | Split only the exact selected branch/ref row                                   |    85.45 → 84.53 ms (+1.1%) | Reverted                    |
|    16 | Read the two pinned revision diffs concurrently and settle failures            |   44.12 → 32.83 ms (+25.6%) | Retained                    |
|    17 | Use exact/parent path sets instead of a quadratic overlap scan                 |   40.01 → 32.93 ms (+17.7%) | Retained                    |
|    18 | Read snapshot HEAD, symbolic ref and normalization settings concurrently       | 201.79 → 172.31 ms (+14.6%) | Retained                    |
|    19 | Bound coordination reports with binary prefix search                           |    55.53 → 1.35 ms (+97.6%) | Retained                    |
|    20 | Reuse successful pinned commit comparisons within one coordination scan        | 756.38 → 402.95 ms (+46.7%) | Retained                    |

Round 3 initially showed a 6.5% ASCII paging improvement; confirmation was 1.6% slower, so its code was removed. Round 9 initially had a small-control regression of 0.06 ms; its independent repeat improved that control. Absolute and percentage results are both preserved.

Round 6 initially had a patch-generation syntax error. Initial rounds 16/18 accidentally awaited individual expressions before the intended concurrent group. Their generated patches were corrected and measured again; the mistaken attempts are archived separately and do not establish concurrency gains. A later retry of round 16 omitted an existing path-set block, and round 18 had another extraction error; both were reverted before corrected measurements. All 20 final entries have successful, matching-output measurements.

## Retained behavior and correctness boundaries

- Online presence reads settle groups of at most 16 files. Session IDs already observed online are deduplicated within that call. Every new call still checks current session state; no lease or closure persists in a process cache.
- Pinned target/incoming diffs run concurrently and settle before propagating the original ordered failure. Worktree HEAD/ref/normalization reads follow the same pattern; no mutator is launched early.
- Exact and ancestor-path sets replace the quadratic pairwise overlap scan, preserving whole path-segment boundaries.
- Oversized coordination reports find the largest fitting prefix by binary search. Finding order, totals, status, Unicode byte limits and untrusted-data wrapper remain intact.
- Successful commit-pair comparisons are reused only within one scan, keyed by both pinned commits and receiver case-folding behavior. Cached issues are rebound to the current target/incoming metadata. Unknown results are retried, and a subsequent scan builds a fresh cache.

The regression tests cover bounded presence reads, shared-session deduplication, fresh closure observations, draining failures, receiver identity rebinding and snapshot refresh across scans. Existing Unicode paging/ACK, malformed storage, Git cancellation, observer isolation, structural collisions and race tests remain required.

## Reproduce

Use a disposable checkout containing the starting source snapshot and these benchmark scripts. The experiment runner intentionally edits that checkout; preserve other work before invoking it. Source snapshots must be saved before optimization because `main` alone omits the earlier uncommitted plugin work. The evidence's `retained.patch` describes only this round: reverse it in a disposable copy of the final source to reconstruct the measured starting source.

```sh
npm ci --ignore-scripts
GITBEACON_PERF_SCRATCH="/absolute/disposable/snapshots" \
  node scripts/performance-twenty.mjs /absolute/output/evidence
# Compare saved source snapshots directly, without editing the checkout:
node --experimental-strip-types scripts/benchmark-performance.mjs \
  /absolute/before /absolute/after scan-many
npm run check
node scripts/benchmark-delivery.mjs
```

The runner records/restores rejected source patches and confirms candidates before retaining them. Thresholds: at least 5% primary median latency reduction; controls must not regress both over 10% and over 1 ms; Node CPU must not regress both over 20% and over 2 ms. Recorded decisions remain specific to their measured environment. The standalone confirmation and combined comparisons are in the evidence directory.

## Validation

`npm run check` passed **428/428 tests** with no skips or failures. The three new regressions passed independently; the plugin rebuilt successfully. The actual stdio delivery smoke test completed six send/receive/ACK cycles (131.69 ms median excluding the first), without a matched transport-latency baseline. Additional Unicode/escaped report and empty/resolved controls matched the starting implementation exactly. Formatting, types, source fingerprints and the combined reverse patch were verified.

## Evidence and limits

[Raw evidence](evidence/2026-11-07-performance-20/README.md) retains every accepted and rejected candidate patch, all sample timings/output hashes, source fingerprints and discarded experiment errors. The report helper is exported only inside disposable benchmark snapshots, never in the production API. Fixture setup/reset, module loading and output hashing are excluded from timed regions. Outputs must match exactly across variants after normalization of documented timestamps and rotating delivery handles.

Warm local caches and background load are uncontrolled. Variants are separate module trees in one process, not isolated OS resource sandboxes; Node CPU omits Git children and process peak RSS is shared, so no memory savings are claimed. No cold-cache, network-filesystem, Windows, hosted CI, Desktop GUI or provider/model latency validation was performed this round. The previous native plugin acceptance remains historical evidence for its recorded source.
