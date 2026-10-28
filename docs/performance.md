# GitRelay performance benchmarks

These are historical measurements of the named source snapshots. The current
Codex/OpenCode-only, default-off refactor has not been benchmarked on real hosts.
Retired-client results are not current support claims.

## Record a reproducible run

Use the committed benchmark scripts and retain a machine-readable result:

```sh
npm run build
node scripts/record-benchmark.mjs delivery /absolute/new-delivery-result.json
node scripts/record-benchmark.mjs mailbox /absolute/new-mailbox-result.json
```

The recorder supports `delivery`, `mailbox`, `history`, `maintenance` and
`concurrency`. It records the source commit, dirty status, a content fingerprint,
OS/Node/Git versions, workload records and raw stdout/stderr. Existing benchmark
assertions must pass, and the source fingerprint must remain unchanged. Build
immediately before recording and do not run another build or test concurrently.
The output must be a new file; keep results and the exact source snapshot in
durable storage. Temporary paths in the historical sections below are provenance
references, not guaranteed downloadable artifacts.

One local run is not a before/after comparison. For an optimization claim, run
alternating baseline/candidate samples with the same workload and environment,
and state cache conditions, external load and unmeasured boundaries. This
recorder does not recover missing historical harnesses or establish real-host
latency, cold-cache behavior or physical disk I/O.

## Current reproducible CLI baseline: 2026-10-27

Two recorded runs used a clean checkout of implementation commit
`43bc73695104e69cfa3c81bae5c81af3abab418e`, macOS arm64, Node `22.23.2` and
Git `2.54.0`. The recorder verified unchanged source and build fingerprints.
All benchmark delivery, receipt and deduplication assertions passed.

- [CLI delivery record](evidence/2026-10-27-standardization/delivery-benchmark.json):
  one sender/receiver in linked worktrees, warm caches and no daemon. The medians
  were 52.1 ms send, 69.9 ms check and 121.1 ms send-through-check completion.
- [Mailbox record](evidence/2026-10-27-standardization/mailbox-benchmark.json):
  three sessions, 100/1,000/10,000 retained events and a 32-message offline backlog.
  At 10,000 events without a daemon, three-session idle polling measured
  1,660.4 ms and backlog recovery 2,144.5 ms.

These are single local runs with uncontrolled external load. They are not an
old/new comparison, a stable latency guarantee or real-client performance
measurements. The JSON records retain workload details and raw benchmark output;
the executable path is replaced with `<node>`. Historical experiments below
remain separately scoped to their original sources and conditions.

## Per-ref daemon cache ownership (2026-10-27, Asia/Singapore)

This is a historical measurement of the cache fast path; current consumers
synchronize on every consume. See the later always-synchronize measurements.

An isolated local Git fixture compared the prior code with the per-ref daemon
token change, using 20 alternating runs per variant, a fresh prebuilt state
directory per run, warm filesystem caches and an AbortSignal. Median full
`consumeMailbox` time without a daemon was 26.618 ms before and 27.123 ms
after; with a matching synthetic daemon heartbeat it was 18.550 ms before and
18.259 ms after. Separately, a lock-held `synchronizeRef` call measured
15.073 ms before and 14.232 ms after. These small samples do not establish a
performance improvement or cover cold caches, CPU, real daemons, concurrent
consumers, remote filesystems or real-host latency. Script and source hashes:
`/tmp/gitrelay-daemon-token-final.G5KbxiiX/benchmark-v4.mjs`.

## Experimental launcher revision checks (2026-10-27, Asia/Singapore)

A private Codex/OpenCode bootstrap prototype tried to fix a startup/upgrade
race by reading state twice and checking revision markers. On macOS arm64,
20 alternating warm-cache imports of a synthetic no-op runtime with 1,000
markers had medians of 2.00 ms for the existing Codex bootstrap and 61.60 ms
for a prototype that opened every marker. The corresponding OpenCode medians
were 1.89 and 57.52 ms. A second prototype that validated only the selected
latest marker measured 5.50 ms and 4.78 ms respectively. At 1,000 markers its
median maximum RSS was about 42.7 MiB versus 40.2 MiB for the old bootstrap;
these values include the Node process baseline.

The second prototype has different integrity semantics: a damaged older
marker does not stop startup, although the installer still rejects it on a
later install. Neither prototype was adopted; legacy migration, filesystem
races, cold-cache performance, Windows and real-host behavior remain
unverified. The fixture was `/tmp/gitrelay-bootstrap-safe-v2.prfn1qC6/bench-latest.mjs`.

## Path overlap lookup (2026-10-27, Asia/Singapore)

The matcher sorts local paths and looks up possible descendants by prefix,
instead of retaining a separate set of every parent directory. Exact local
paths and candidate ancestors are still checked as before. Construction now
includes a sort; checking an extremely deep candidate still examines its
ancestors and can be expensive. This change does not bound total process
memory or time for arbitrary path data.

In isolated macOS arm64, Node 22.23.2 synthetic runs, three fresh processes per
variant compared the same generated inputs. For 100,000 ordinary paths and
10,000 queries, construction took 48/50/75 ms before and 20/18/19 ms after;
queries took 5/9/9 ms before and 9/8/10 ms after. Both matched 3,337 queries;
post-GC heap was about 26 MiB before and 22 MiB after. A single synthetic
4 MB path with two million directory components took 400/264/280 ms to
construct before and 0/1/0 ms after, with post-GC heap about 113 versus 11 MiB.
The three queries in that extreme case were shallow. These are matcher-only
measurements, not whole-delivery timings or real filesystem workloads.

## Conservative submodule detection (2026-10-27, Asia/Singapore)

The relevance check scans Git's index for gitlinks and treats each as a
potential overlap. Each upstream event can cause another index scan; a
consumer does not reuse the scan across events because the index may change.
The scan streams records, decodes only gitlink paths and bounds each pending
record and all retained gitlink path bytes to 16 MiB each. Those limits are not
a total-memory limit: buffer growth, strings and stream buffers add memory.
An invalid gitlink name or an exceeded limit preserves unread events.

On macOS arm64 with Git 2.54.0 and Node 22.23.2, a synthetic index of 300,000
tracked paths produced 20.1 MB of `ls-files --stage` output. Five warm-cache
private-prototype scans took 87.75–134.11 ms, median 89.91 ms. This is only the
added scan, not an end-to-end delivery benchmark or a real large repository.
In a separate extreme fixture where all 300,000 tracked worktree files were
missing, two alternating batches of eight full `worktreeFiles` calls took
7.410/7.226 seconds before and 7.276/7.102 seconds with an earlier equivalent
prototype. Existing diff work and run-to-run noise dominate this example; it
does not establish a speedup or characterize normal workloads.

The scan kills the direct Git process and closes its pipes on cancellation,
failure or timeout; an uncooperative wrapper's detached descendants may
survive. Windows, remote filesystems, and concurrent index modification have
not been verified for this change.

## Current single-message snapshot (2026-10-27, Asia/Singapore)

One isolated warm-cache run of `node scripts/benchmark-delivery.mjs` on macOS
arm64, Node 22.23.2 and Git 2.54.0 used linked worktrees, no daemon and five
messages. It verified the delivered markers, receipts and an empty subsequent
check. Median CLI startup was 36.8 ms; median send, check and end-to-end times
were 54.8, 76.6 and 132.7 ms. `/usr/bin/time -l` reported median check maximum
RSS of 57,982,976 bytes, 0.05 s user CPU and 0.01 s system CPU for each sample.
Its reported block input/output operations were zero; this does not prove zero
filesystem I/O. Setup was excluded. The tested `dist` JavaScript manifest
SHA-256 was `734c2ad9634ab46d9731ad7473a9c8015cb556917ee0897c79f46fbdbe246048`;
the raw measurements are in the temporary directory
`/private/var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/gitrelay-delivery-measure-izbzw6fj/result.json`.
This single run is a current baseline, not a controlled before/after comparison
or a measurement of model latency, cold caches, Windows or larger backlogs.

## Upstream publication recovery scan (2026-10-27, Asia/Singapore)

The recovery change adds a full validation scan of retained event and trash files under the publication lock on each ref synchronization. It can recover an event published before its ref cursor was saved, even when the ref has subsequently advanced or reset. Its cost grows with retained state and repeated checks across refs.

On macOS arm64, Node `22.23.2`, and Git `2.54.0 (Apple Git-157)`, an isolated temporary repository and state root contained 1,000 unrelated small message events with no recipients. With an unchanged ref, 15 sequential calls to `synchronizeRef` measured under `publish.lock` produced a 16.52 ms median and 18.18 ms maximum before the recovery scan, versus a 110.99 ms median and 170.03 ms maximum after it. Setup was excluded; filesystem caches were warm. The after run overlapped other local tests, while the baseline did not, so the difference is not an isolated statistical estimate. It measures ref synchronization, not end-to-end delivery, CPU, memory, disk I/O, cold-cache behavior, or multiple concurrent refs.

The local measurement fixture is `/tmp/gitrelay-publication-bench.mts`; while that temporary file remains available, rerun the current implementation from the repository root with `node --experimental-strip-types --test /tmp/gitrelay-publication-bench.mts`. The pre-change source was not retained as a standalone benchmark snapshot, so this command alone cannot reproduce the baseline. See [maintenance](maintenance.md#upstream-publication-recovery-and-upgrades) for recovery and mixed-version limitations. A per-ref journal with one-time legacy scanning would need a verified protocol upgrade and stopped older participants; the current implementation does not implement such an upgrade.

The Git ref lookup, cursor read and event scan now run concurrently under the
publication lock. They all settle before an error is propagated or the lock
is released; errors retain their prior ref, cursor, then event priority. This
also means a failed ref lookup waits for an event scan that was already
started, so a slow filesystem or large backlog can delay reporting that error.
Cancellation likewise waits for in-flight file reads, which cannot be forcibly
cancelled, before releasing the lock.
In two isolated warm-cache experiments on macOS arm64, each alternating 16
unchanged-ref calls per variant on the same temporary repository, the medians
were 12.37/12.38 and 12.55/12.27 ms before/after with no retained events, and
51.65/37.54 and 48.24/35.92 ms with 1,000 unrelated retained messages. Every
call returned the expected commit. An independent repeat measured
16.79/16.94 ms with no events and 64.48/51.06 ms with 1,000 events; the
latter maximum was 112.63/194.05 ms. These samples do not show improved tail
latency. Other local work could affect timings;
this is not a real-agent latency, cold-cache or network-filesystem result.
Injected delayed reads verified that a failed ref preserves its error and
that cancellation leaves the event and cursor unchanged; both keep the lock
until the scan settles. Interruption-recovery tests also passed. The compared
private source copies and fixture are under
`/var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/gitrelay-perf-parallel-5fly28l5/`,
which the operating system may remove.

### Bounded scan experiments

In an isolated snapshot on the same macOS arm64, Node and Git versions, increasing event-read batches from 32 to 64, 128 or 256 showed no reliable gain. For 1,000 small events, three alternating runs per batch each measured 15 unchanged-ref synchronizations; median ranges were 46.97–64.59 ms (32), 46.50–52.87 ms (64), 48.10–63.78 ms (128), and 48.31–52.78 ms (256). Removing event sorting in a separate experiment likewise showed no stable improvement at 1,000 or 10,000 events. Neither change was adopted.

A separate synthetic test compared serial trash reads with 32 concurrent reads, alternating the variants 16 times per size in a temporary repository with warm caches. Median synchronization times in milliseconds were:

| Small trash records |     0 |     1 |    10 |   100 | 1,000 |
| ------------------: | ----: | ----: | ----: | ----: | ----: |
|              Serial | 16.62 | 14.16 | 14.62 | 22.20 | 87.58 |
|       32 concurrent | 16.71 | 14.14 | 14.39 | 18.21 | 47.53 |

The experiment showed little difference at 0–10 records and a larger benefit with accumulated trash. It does not establish how often such backlogs occur in actual use; 32 concurrent 2 MiB state reads could also require roughly 64 MiB of buffers before overhead, compared with one at a time. Tests checked first-error ordering for two corrupt files, preservation of their bytes and the cursor, and cancellation before the scan. Cancellation during reads and the lock remaining held until an entire concurrent batch settles were not fault-injected. The concurrent implementation was not adopted.

Another isolated dry-run GC experiment compared its existing linear search for
trash entries with lookup in the already-built trash ID set. With 10,000 small
trash records and 1,000 event records, alternating three runs of each variant
gave 678.70–712.31 ms for the existing code and 671.74–706.56 ms for the
candidate. Each run checked the number of eligible and retained records. The
overlapping timings and unusually large synthetic trash backlog do not establish
a meaningful practical benefit, so the candidate was not adopted. The source
snapshots, fixture and results are under the temporary directory reported by
`/tmp/gitrelay-trash-gc-bench.py`; they may be removed by the operating system.

These are local synthetic measurements, not real-client acceptance or CI results. Temporary evidence, while retained on the measurement machine: `/tmp/gitrelay-scan-matrix.py`, `/tmp/gitrelay-scan-nosort.py`, and `/tmp/gitrelay-read-variants.OYOuva/trash-sized.mts`. The fixtures use absolute paths to their isolated snapshots and need those snapshots to rerun.

## Reproduce

```sh
npm run benchmark
```

The script creates and removes a temporary Git repository, three receiver worktrees, and an isolated state directory. It does not read user messages, install services, or call models. Requires local Git and Node.js 22.19+. Benchmarks are excluded from CI because shared-runner load can distort results.

Fixed scenario:

- Retain 100, 1,000, or 10,000 broadcasts, each with three recipients and valid individual receipts.
- Exclude event/receipt preparation from timing. Measure sequentially in one process with warm OS file caches.
- Empty polling: check all three sessions sequentially, repeat three times, report the median.
- Offline recovery: revoke one recipient's last 32 receipts, then measure four consumption/persistent-acknowledgement batches. This is not recovery of all 10,000 messages from scratch.
- Daemon comparisons use real `runDaemon`, wait for initial monitoring/cleanup, and assert it remains alive. Acknowledged events remain within seven-day retention, so enabling the daemon does not shrink the dataset.
- Assert no empty-poll delivery, exactly 32 unique recovery IDs, no repeat delivery, and persistence of all successful receipts. Stop the daemon and restore environment variables afterward.

## Initial local results

2026-10-25 UTC, macOS arm64, Node `22.23.2`, Git `2.54.0 (Apple Git-157)`. Values are rounded milliseconds.

| Retained events | Daemon | Median empty poll, 3 sessions | Recover 32, 1 session |
| --------------: | :----: | ----------------------------: | --------------------: |
|             100 |  Off   |                           224 |                   518 |
|             100 |   On   |                           332 |                   418 |
|           1,000 |  Off   |                         1,156 |                   588 |
|           1,000 |   On   |                           401 |                   466 |
|          10,000 |  Off   |                         4,398 |                 4,620 |
|          10,000 |   On   |                         4,212 |                 7,314 |

The preceding run on the same machine measured 4,178 / 4,116 ms for 10,000-event empty polling and 4,534 / 4,525 ms for recovery. Background load and disk caches cause variation. Recovery is a single measurement, not evidence that the daemon is always faster.

## Before and after optimization

Same machine, runtime, script, and dataset sizes; no benchmark change or reduction in retained events. Values are milliseconds to one decimal place.

| Retained events | Daemon | Empty poll before | Empty poll after | Recover 32 before | Recover 32 after |
| --------------: | :----: | ----------------: | ---------------: | ----------------: | ---------------: |
|             100 |  Off   |             137.8 |            119.1 |             173.7 |            164.4 |
|             100 |   On   |              82.9 |             60.5 |             108.0 |            119.7 |
|           1,000 |  Off   |             465.4 |            255.4 |             522.2 |            284.4 |
|           1,000 |   On   |             419.3 |            116.3 |             463.9 |            178.0 |
|          10,000 |  Off   |           4,065.2 |            846.8 |           4,443.4 |          1,026.0 |
|          10,000 |   On   |           4,086.0 |            767.6 |           4,374.2 |            984.2 |

A repeat after optimization measured 774.1 / 865.2 ms for 10,000-event empty polling (daemon off/on) and 1,139.8 / 1,079.3 ms for recovery. Both runs passed deduplication, receipt, unread-recovery, and daemon-liveness assertions. Empty polling improved about 79–81%, recovery about 74–78%; smaller recovery cases varied, so not every scenario is claimed faster.

Only the read path changed:

- Under the session lock, enumerate receipt filenames, then read and validate matching receipts before skipping event bodies. File existence alone is not acknowledgement. No receipt cache, new state format, or migration was added.
- Read at most 32 entries concurrently per batch and await the entire batch before returning or throwing. Sort only unacknowledged events by timestamp and ID; the eight-event delivery limit remains.
- GC does not apply session filtering and still validates all retained events before deletion. Acknowledged event-body corruption is no longer detected by that session's polling, but unacknowledged consumers and GC still report it.
- At the time of optimization, `npm run typecheck`, `npm test` (61/61), and `npm pack --dry-run` passed. Regressions cover ordering across read batches, corrupt-receipt rejection, redelivery after receipt deletion, independent recipients, and GC validation. These are historical results, not rerun by translating this document.

## Small-file read overhead (2026-10-27, Asia/Singapore)

At this measurement, `readJson` used the standard library's callback-backed `fs.readFile`, adapted once with `util.promisify`. The later bounded state-file reader described below replaced it. Every receipt was still read and validated on every scan; there was no cache or state-format change.

Measured against commit `c8e732c` on macOS arm64, Node `22.23.2`, Git `2.54.0 (Apple Git-157)`, using the unchanged benchmark above. Values are milliseconds; before and after are separate runs with the same dataset sizes.

| Retained events | Daemon | Empty poll before | Empty poll after | Recover 32 before | Recover 32 after |
| --------------: | :----: | ----------------: | ---------------: | ----------------: | ---------------: |
|             100 |  Off   |             132.5 |            111.4 |             162.5 |            155.5 |
|             100 |   On   |              75.7 |             63.8 |              95.7 |            100.9 |
|           1,000 |  Off   |             159.5 |            200.9 |             240.2 |            277.3 |
|           1,000 |   On   |             114.1 |            105.3 |             187.1 |            144.7 |
|          10,000 |  Off   |             784.3 |            672.1 |           1,078.3 |            891.9 |
|          10,000 |   On   |             776.7 |            674.8 |             913.2 |            768.5 |

A second optimized run measured 630.4 / 713.5 ms for 10,000-event empty polling (daemon off/on), and 813.6 / 923.2 ms for recovery. Relative to the baseline run, large-backlog empty polling took about 8–20% less time across these runs. Recovery and smaller cases varied; this is not evidence of a speedup in every scenario or runtime. All three benchmark runs passed their delivery, deduplication, receipt-persistence, and daemon-liveness assertions.

The storage regression test additionally checks UTF-8 content, the exact size boundary, oversized files, missing files, malformed JSON, and propagation of non-ENOENT errors. `npm run typecheck` and all 121 tests in `npm test` passed for this change.

## Bounded history reads (2026-10-27, Asia/Singapore)

Reproduce the separate upstream-history benchmark:

```sh
npm run build
node scripts/benchmark-history.mjs
```

It creates an isolated temporary repository and receiver worktree, retains 10, 100, then 500 first-parent commits, and measures the median of three `inspectChange` calls at each size. Most commits affect an unrelated file; two edit and then restore a file with local receiver changes. Setup is excluded. Assertions check the complete ordered commit list, overlapping filename, detection of the reverted intermediate edit, and patch order. The repository is removed afterward.

The comparison uses the same local runtime as the small-file benchmark. The baseline already includes that optimization; only the history-reading change differs.

| Commits | Serial reads, ms | Four concurrent reads, ms | Less elapsed time |
| ------: | ---------------: | ------------------------: | ----------------: |
|      10 |            182.2 |                     105.7 |               42% |
|     100 |            903.7 |                     423.9 |               53% |
|     500 |          4,008.9 |                   1,230.2 |               69% |

A repeat optimized run measured 109.6, 341.7, and 1,281.1 ms respectively and passed all assertions. The 500-commit case took about 68–69% less time across the two optimized runs relative to the baseline.

`inspectChange` reads changed filenames in batches of at most four Git processes. Results stay in first-parent order, and the entire batch settles before an error propagates out of the consumer lock. Existing cancellation signals reach every Git call. Patch generation and snapshot comparisons retain their existing behavior. The regression test spans three batches, including an empty commit, unrelated commits, and an edit followed by a later revert. `npm run typecheck` and all 122 tests in `npm test` passed.

This reduces waiting time, not the number of Git subprocesses. The limit is per inspection, not global across sessions. It can increase peak CPU and memory use; these results do not establish gains on low-core systems, under simultaneous session load, or when many commits require large patches. The mailbox benchmark above measures a different workload.

## Concurrent worktree reads (2026-10-27, Asia/Singapore)

```sh
npm run build
node scripts/benchmark-worktree.mjs
```

The benchmark creates and removes an isolated repository, excludes setup and one warm-up from timing, and measures 20 calls to `worktreeFiles`. Each call asserts the union of committed, staged, unstaged, untracked, and ignored paths, including staged and unstaged edits that cancel in a net diff.

Against `8d2ceae`, on macOS arm64 with Node `22.23.2` and Git `2.54.0 (Apple Git-157)`, the serial baseline median was 41.1 ms. Three optimized runs measured 26.4, 28.3, and 22.5 ms (31–45% less elapsed time). These are small-repository, warm-cache measurements, not end-to-end mailbox speedups.

The four independent reads after HEAD and merge-base resolution now run concurrently. Results are combined in the original order, and all child processes settle before an error leaves the caller's lock. Cancellation still reaches each Git process. No Git command, file category, state format, or receipt validation was removed. `npm run typecheck` and all 122 tests passed; the new benchmark also passed its assertions in all four runs.

The unchanged history benchmark also passed on retry (10/100/500 commits: 85.8/360.9/1,223.1 ms); the first standalone rerun failed during temporary-directory cleanup with `ENOTEMPTY`, so it is not counted as successful validation. Its leftover benchmark directory was removed. History timings do not show a consistent gain across sizes.

The change increases peak concurrency to four Git processes per worktree scan without reducing total process count. Many simultaneous sessions and low-core systems remain unmeasured. Long-history batch reads were investigated but not adopted in this pass: preserving commit/file framing and existing output-size behavior requires additional validation.

## Batched first-parent history (2026-10-27, Asia/Singapore)

The next pass replaces one filename-reading Git process per commit with one `git log --no-walk=unsorted --diff-merges=first-parent` call per batch of up to 32 commits. For 500 commits, that stage uses 16 processes instead of 500. This does not change the ordered commit list, intermediate-edit detection, or patch previews. Snapshot comparisons after rewrites or second-parent advances still use the original explicit before/after diff.

Reproduce with `npm run build` followed by `node scripts/benchmark-history.mjs`. The script now disables automatic Git maintenance in its temporary repository and retries transient directory-removal failures up to three times. A repeat previously failed with `ENOTEMPTY` during cleanup; it is excluded from the comparison below. Disabling housekeeping isolates the measurement from background Git work; it does not establish the cause of that failure.

Both sides below use this same updated fixture and the concurrent worktree reads from the preceding section. The baseline restores only the previous four-at-a-time, per-commit history implementation. Same macOS arm64, Node `22.23.2`, Git `2.54.0 (Apple Git-157)`; times are median milliseconds from three inspections at each size.

| Commits | Per-commit baseline | Batched run 1 | Batched run 2 |
| ------: | ------------------: | ------------: | ------------: |
|      10 |                86.3 |          84.4 |          70.2 |
|     100 |               294.6 |         102.2 |         102.0 |
|     500 |             1,405.3 |         251.3 |         251.2 |

The 500-commit scenario took about 82% less elapsed time in both runs. All three runs completed their ordering, overlap, reverted-edit, and patch assertions and cleaned up successfully. These results concern filename inspection in a small repository, not arbitrary large patches or cold caches.

NUL-framed output is checked for complete records and exact commit order. Regressions cover 67 commits with empty commits at batch boundaries, merges, newline and hash-shaped filenames, user log/color settings, malformed output, and the existing rewrite/second-parent cases. If a combined result exceeds the existing 16 MiB subprocess buffer, that batch falls back to individual diffs, at most four concurrently, so separately readable commits remain readable without serializing the former parallel path. Other failures and cancellations propagate; no partial result is acknowledged. The failed combined attempt adds overhead for exceptionally large filename lists; the original per-commit limit is retained. Initial validation passed `npm run typecheck` and all 124 tests in `npm test`; see the final audit below for the current suite.

## Session discovery and GC metadata (2026-10-27, Asia/Singapore)

```sh
npm run build
node scripts/benchmark-maintenance.mjs
```

This isolated fixture stores 100 then 1,000 valid session records and the same number of retained message events, each with three recipients and valid receipts. Setup is excluded; each measurement is the median of three calls with warm filesystem caches. It measures registry size, not 1,000 simultaneously running clients. GC uses `apply: true` with the default retention period and must retain every event. Untimed assertions subsequently remove one receipt, verify that only that unread event survives zero-retention collection, restore the receipt, and verify complete event/receipt/journal cleanup.

Same macOS arm64, Node `22.23.2`, Git `2.54.0 (Apple Git-157)` as above. All three runs used the identical script and completed successfully. Values are milliseconds.

| Sessions / events | Operation         | Before | After 1 | After 2 |
| ----------------: | ----------------- | -----: | ------: | ------: |
|               100 | Session discovery |    5.4 |     1.9 |     1.7 |
|               100 | Retained-event GC |   82.8 |    67.1 |    62.4 |
|             1,000 | Session discovery |   98.8 |    20.8 |    19.0 |
|             1,000 | Retained-event GC |  813.8 |   646.7 |   629.6 |

Session discovery reads at most 32 records concurrently, preserves directory order, validates each record, and settles the whole batch before propagating an error. At 1,000 sessions this reduced elapsed time by about 79–81%.

In this historical measurement, GC reused successfully validated migration status only inside one invocation holding `publish.lock`, which also protected the relay's session metadata writes. There was no cache across GC calls. Each receipt was read and validated independently while its recipient lock was held; retention calculation and journaled deletion were unchanged. For 1,000 events, repeated session metadata reads fell from 3,000 to three, and measured GC time fell about 21–23%. This did not remove its per-event lock cost or establish throughput under competing consumers. The current GC uses a sequential recipient-lock barrier under `publish.lock`; see [maintenance](maintenance.md#concurrency-and-interrupted-cleanup). Regressions cover multiple session-read batches, corrupt session records, migration changes between collections, missing session records, and an unread event after another event from the same session was collected. `npm run typecheck` and all 126 tests passed.

## Concurrent CLI consumers (2026-10-27, Asia/Singapore)

```sh
npm run build
node scripts/benchmark-concurrency.mjs
```

This benchmark runs 1, 4, then 8 independent CLI processes with separate session identities in one worktree. Each scenario retains 1,000 broadcasts acknowledged by every session. Each round starts all `check` processes together and times completion of the entire group, including Node startup and IPC. Setup is excluded; filesystem caches are warm. The optional daemon uses its actual polling/cleanup implementation in the parent process, and each scenario verifies its liveness. The script uses only an isolated temporary repository/state root.

Same local macOS/Node/Git versions as above. Median group completion time over three idle rounds, milliseconds. The final validation run additionally exercised the untimed zero-retention deletion race described below.

| CLI processes | Daemon | Run 1 | Run 2 | Validation run |
| ------------: | :----: | ----: | ----: | -------------: |
|             1 |  Off   |  96.8 |  80.4 |           91.5 |
|             1 |   On   |  89.1 |  78.8 |           80.5 |
|             4 |  Off   | 204.4 | 178.1 |          197.3 |
|             4 |   On   | 121.2 | 124.2 |          132.6 |
|             8 |  Off   | 308.6 | 315.1 |          330.2 |
|             8 |   On   | 189.0 | 180.6 |          203.3 |

Every process then recovers eight revoked receipts, with assertions for exact event IDs, no duplicate delivery on the next poll, and persisted successful receipts. Eight-process recovery took 308–321 ms without the daemon and 201–240 ms with it. These are concurrent group completion times, not per-process averages.

A separate simultaneous retained-event GC plus poll round took 169–998 ms across these runs. Depending on scheduling, GC skipped 0–998 events because a consumer held a recipient lock. All events were preserved, and all CLI calls completed without lock-timeout errors. This variation reflects the existing safety/fairness behavior and does not support a stable GC speedup claim.

The script also exercises zero-retention deletion racing with eight-message recovery per consumer. Its initial assertion incorrectly required delivery in the first poll even when GC held the session lock. The corrected assertion permits a skipped first poll, requires the exact missing IDs on the following uncontended poll, then requires no duplicate delivery. In the successful validation run, 1/1, 2/4, and 6/8 consumers skipped their first poll and all recovered afterward. A final uncontended collection removed all acknowledged events, receipts, and journal entries. No production lock behavior was changed.

The measured 1–8-process scenarios give no reason to relax receipt validation or recipient/publication locks. They do not establish behavior for hundreds of concurrent clients, slow disks, other operating systems, or cold caches. Registry-size measurements in the preceding section remain distinct from this process-concurrency test.

## Large ignored file trees (2026-10-27, Asia/Singapore)

`scripts/benchmark-worktree.mjs` now additionally creates 1,000, 10,000, then 100,000 ignored files across directories of 100 files each. After one warm-up, it measures five worktree scans plus matcher construction, asserting the complete filename set, a matching file, file/directory prefix overlap, and rejection of a nonexistent sibling. Setup and assertions are excluded from timing; temporary files are removed afterward.

On the same local runtime, medians were 49.1, 46.9, and 133.9 ms respectively. The smaller cases vary with process startup and scheduling. This does not justify replacing exact filename relevance with coarse directory matches or dropping ignored files. The test covers warm caches and short filenames, not arbitrary repository sizes or network storage.

## Successful atomic writes (2026-10-27, Asia/Singapore)

At this measurement, `writeJson` removed temporary files only on failure, eliminating one redundant removal attempt after a successful `rename`. Later ownership checks changed failure handling: an incomplete or unverified temporary file is now preserved for inspection rather than always removed. The historical regression tests checked replacement contents, private file permissions, old-value preservation on serialization failure, obstructing directories and missing-parent errors. `npm run typecheck` and all 128 tests passed for that snapshot.

With the preceding pi optimization already present, two subsequent native-history runs measured 210.1/217.4 ms at 1,000 entries and 304.4/228.8 ms at 10,000 entries; all assertions passed and each recovery still traversed the branch once. These variable end-to-end timings do not establish an additional consistent speedup for the write change. The verified reduction is one unnecessary filesystem operation per successful write.

## Historical auto-sync operation checks (2026-10-27, Asia/Singapore)

These measurements predate the temporary shutdown of automatic synchronization. The benchmark below expects the old successful sync and cannot pass while synchronization is blocked. Current code performs none of these operation-marker checks; the old tests are retained as TODO pending a safe implementation.

```sh
npm run build
node scripts/benchmark-sync.mjs
```

The benchmark uses an isolated linked worktree and local-file remote. It times seven already-up-to-date `syncBranch` calls after one warm-up, verifies the result, HEAD, file content, and clean worktree after every call, and removes its temporary state. The median fell from 188.6 ms to 140.1 and 139.8 ms in two optimized runs, about 26% less time. This excludes network latency and does not imply a comparable percentage for Internet fetches.

At that measurement, Git operation-marker checks ran in batches of at most four. All seven markers used Git's per-worktree path resolution and were considered in the original order. Each batch settled before an error or blocked result released the writer lock. Tests covered the seven markers, dirty worktrees, ignored files, divergence, missing upstreams, and failed fetches for that historical implementation.

## CLI delivery baseline (2026-10-27, Asia/Singapore)

```sh
npm run build
node scripts/benchmark-delivery.mjs
```

This script requires Node.js 22.19+ and Git. It creates and removes a temporary repository, a linked receiver worktree and an isolated state directory; it disables system and user Git configuration and Git hooks for the fixture. One receiver registers before a sender publishes five distinct unfiltered messages. Each `check` starts after `send` returns, and the script verifies each message, its `delivered` receipt, and an empty follow-up check. One warm-up and setup are excluded from startup timing. The measurement includes CLI process startup and local Git work; it does not include a real coding agent, model response, or a polling interval.

On macOS arm64, Node `22.23.2`, Git `2.54.0 (Apple Git-157)`, the five-sample median for `--help` startup was 101.0 ms; `send` was 87.4 ms; the receiver `check` after the send returned was 102.7 ms; and send start through check completion was 187.4 ms. A check completes after its output and receipt are written. A preceding exploratory run under different Git configuration handling reported 36.2, 63.4, 89.4 and 151.3 ms respectively. Other tests and reviews were running concurrently, so this variation does not establish a performance change or bottleneck.

On macOS the script invokes `/usr/bin/time -l` for each check and reports its raw output; otherwise resource fields are unavailable. In the recorded run, check CPU time was 0.05–0.09 seconds user and 0.02–0.04 seconds system, with maximum resident size 54.7–55.2 MB. The tool reported zero block input and output operations, which does not provide a meaningful count of filesystem bytes or prove an absence of I/O. The separate measurement below adds per-process I/O counters; full process-tree I/O and real-host delivery latency remain unmeasured. These are baseline measurements, not a before-and-after optimization comparison.

## macOS per-process I/O baseline (2026-10-27, Asia/Singapore)

```sh
npm run build
node scripts/benchmark-darwin-io.mjs
```

This macOS-only benchmark requires `clang`, Node.js 22.19+ and Git. It compiles a temporary helper, creates an isolated repository, linked worktree and state directory, and removes them afterward. The helper waits for the CLI process to exit without reaping it, reads the kernel's `proc_pid_rusage` v4 counters, then reaps it. A 1 MiB write plus `fsync` positive control must show at least 1 MiB of logical writes and a nonzero disk-write count. Five messages are sent and received, with each event, receipt and a final empty check asserted; setup and one startup warm-up are excluded. End-to-end timing starts before `send` and ends when `check` exits, before inspecting receipts. The script fingerprints compiled JavaScript before and after the measurement and rejects a difference; it cannot detect a change that was later reverted.

On macOS arm64, Node `22.23.2` and Git `2.54.0 (Apple Git-157)`, the five-sample medians were:

| CLI operation | Wall time | User / system CPU | Peak physical footprint | Disk read / write accounting | Logical writes |
| ------------- | --------: | ----------------: | ----------------------: | ---------------------------: | -------------: |
| `--help`      |  33.63 ms |   28.56 / 5.66 ms |            16,943,168 B |                      0 / 0 B |            0 B |
| `send`        |  55.47 ms |   32.70 / 8.26 ms |            18,352,696 B |                 0 / 12,288 B |      172,032 B |
| `check`       |  75.92 ms |  36.10 / 10.73 ms |            18,762,320 B |                 0 / 24,576 B |      303,104 B |

Median send start through check completion was 136.32 ms. The positive control reported 1,048,576 bytes of disk writes and 1,089,536 logical write bytes. The compiled JavaScript fingerprint was `f4ea0fad0941157cdb39f271969e076bccfa5ef91bc221894038b2f6d7dd41e5`. Individual samples, including variable logical-write accounting, are emitted as JSON. Other work was running concurrently; these are not a controlled before/after comparison and do not identify a specific optimization.

The counters describe only the direct Node process, not the Git subprocesses it starts or the complete filesystem workload. Kernel caching, asynchronous writes and accounting availability affect the disk counters: a zero does not mean no files were read or written, and logical writes are not equivalent to device writes. Peak physical footprint and CPU use the process's `proc_pid_rusage` counters; physical footprint is not RSS. The benchmark does not exercise a coding agent or its polling interval, cold cache, another operating system, or a physical-disk throughput measurement. No production behavior was changed based on these measurements.

## Conclusions and limits

- The daemon centralizes Git-ref monitoring but does not eliminate per-session directory/receipt scans. The latest local runs measured roughly 0.63–0.71 seconds for three-session empty polling at 10,000 events. It remains linear and does not establish support for unlimited backlog or large session counts.
- Inspect `sessions` and a `gc` preview, then safely collect acknowledged events. Do not delete unread messages or expire offline sessions for speed. Without the optional daemon, maintenance is explicit.
- No database, queue service, or event index was introduced. Consider an index compatible with receipt/GC semantics only if scans remain a measured bottleneck, without dropping unread events or skipping receipt validation.
- The broadcast-storage benchmark measures a different workload from the separate history, concurrency, native-history, and file-tree benchmarks. Those cover up to 500 commits, eight CLI processes, 10,000 native history entries, and 100,000 ignored files respectively; cold caches, network storage, and other operating systems remain unmeasured.

## Final audit (2026-10-27, Asia/Singapore)

The completed audit uses the original stopping criterion: pursue reproducible gains in reasonable project workloads while preserving correctness, and stop when no further demonstrated gain justifies added complexity. It does not claim a mathematical optimum for every machine or input.

| Area                         | Final evidence                                                                                                                                                                                                             | Remaining cost / decision                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox polling and recovery | All 100/1,000/10,000-event assertions passed. At 10,000 events, three-session empty polling measured 650.3/600.5 ms and 32-message recovery 832.1/765.2 ms, daemon off/on.                                                 | Directory and receipt validation remains linear. Skipping validation or introducing a persistent index would change the integrity/design tradeoff; not justified by these runs. |
| Upstream history             | Ordered commits, intermediate reverts, merges, unusual names, snapshots, malformed output and oversized combined output are covered. Final 500-commit median: 237.4 ms.                                                    | Batched Git reads retain the existing per-commit size boundary; the overflow path preserves four-process concurrency and waits for all children.                                |
| Worktree relevance           | Exact filename and prefix assertions passed through 100,000 ignored files; final large-tree median 124.7 ms.                                                                                                               | Exact file relevance is retained rather than broadening matches or omitting ignored paths.                                                                                      |
| Session discovery and GC     | Final 1,000-record scan 16.7 ms; 1,000-event retained GC 593.7 ms. Corruption, migration refresh, unread preservation and journal cleanup assertions passed.                                                               | Session validation is reused only under the publication lock. Receipts and recipient locks remain independent per event.                                                        |
| Concurrent processes         | Independent CLI groups through eight processes passed empty polling, recovery, deduplication, receipt persistence and concurrent deletion/retry assertions. Final eight-process idle median 321.1/175.5 ms, daemon off/on. | Busy consumers may skip a poll and recover later. Lock backoff/ownership checks are retained.                                                                                   |
| Pi native history            | Final 10,000-entry/1,000-receipt recovery median 205.8 ms; one native branch traversal per scan. Actual SDK tests cover append during a scan and branch rewind.                                                            | Cache lifetime is one check and invalidation uses both leaf and session IDs. No live-host latency claim.                                                                        |
| Auto-sync                    | All seven operation markers, dirty/ignored work, divergence and fetch failures are covered; local-remote medians 140.1/139.8 ms.                                                                                           | Fresh status and HEAD checks around fetch/merge remain; network latency is outside this local comparison.                                                                       |

The final source review also checked hook input limits, pi/OpenCode polling overlap guards, daemon liveness/fallback, Git subprocess time/output limits, and state/lock failure cleanup. No dependency, public API signature, persistent state format, retention rule, acknowledgement requirement, or opt-in sync behavior changed. Network/host-bound calls and integrity checks were not replaced with stale caches.

Final `npm run typecheck` and `npm test` passed all 129 tests after the overflow fallback review. The mailbox, history, worktree, maintenance, concurrency, native-history and local-sync benchmarks all completed their self-checks. Timing suites ran sequentially, separate from unit tests. The remaining unmeasured environments above are explicit limits, not claimed results. No further local optimization is currently supported by the collected evidence without changing the stated tradeoffs.

`npm pack --dry-run --json` succeeded with 70 package files. The manifest contains all seven benchmark scripts and the performance guide; all six changed compiled modules were compared with the current TypeScript build output and matched exactly. No dependency, Git directory, or benchmark state directory was included.

## Bounded state-file reads (2026-10-27, Asia/Singapore)

The state reader opens the path nonblocking, verifies that the opened descriptor is a regular file, and enforces the 2 MiB limit against the bytes actually read. A missing path remains missing, while a dangling symlink and non-regular file are errors. Invalid UTF-8 is rejected rather than silently replaced and acknowledged. This prevents a FIFO or a file that grows after inspection from hanging a scan or bypassing the read limit; it also means the earlier callback-backed `readFile` optimization described above no longer describes the current reader. The measurements below predate the strict UTF-8 check.

Two alternating runs of `scripts/benchmark.mjs` compared identical isolated builds with only the compiled state reader changed. The macOS arm64 host used Node `22.23.2`, Git `2.54.0`, three sessions, retained events and warm filesystem caches; other tasks were running concurrently. Values are milliseconds, and each range contains two runs:

| Events / daemon | Three-session empty poll before |       After | Recover 32 before |           After |
| --------------- | ------------------------------: | ----------: | ----------------: | --------------: |
| 100 / off       |                      89.1–234.3 |  99.2–106.2 |       125.8–313.6 |     154.4–255.7 |
| 100 / on        |                      48.0–126.9 |   55.8–63.9 |        71.2–129.1 |       80.0–85.0 |
| 1,000 / off     |                     146.8–202.8 | 171.4–194.1 |       202.3–249.9 |     308.9–385.1 |
| 1,000 / on      |                      92.8–102.8 | 113.6–124.1 |       129.6–153.0 |     153.8–163.2 |
| 10,000 / off    |                     636.2–779.3 | 882.7–963.8 |   1,141.3–1,269.9 | 1,105.1–1,179.2 |
| 10,000 / on     |                   739.3–1,208.4 | 876.1–948.2 |     859.8–1,093.9 | 1,185.2–1,238.4 |

All benchmark self-checks passed for delivery, deduplication, receipts and daemon liveness. Some cases show additional elapsed time, especially the 10,000-event empty poll without the daemon, but load and cache variation prevent a stable percentage claim. A separate 2,000-file callback prototype did not show a consistent gain sufficient to justify substantially more error-handling code; the bounded reader remains in use. These measurements do not cover Windows, cold caches, network filesystems or complete agent/model latency. An external process can still replace a path after the descriptor has opened; the current read then observes the already-open file, not an atomic snapshot of later path changes.

### Strict UTF-8 validation

The mailbox benchmark was repeated in two isolated builds differing only in strict versus replacement UTF-8 decoding, in old/strict/strict/old order on the same macOS arm64 host with Node `22.23.2` and Git `2.54.0`. Four runs passed their delivery, receipt and deduplication self-checks. For 10,000 retained events without the daemon, three-session empty polling ranged from 845.5–970.3 ms with replacement decoding and 853.0–906.9 ms with strict decoding; recovery of 32 messages ranged from 1,092.5–1,124.1 ms and 1,102.1–1,279.1 ms respectively. Other tasks ran concurrently and caches were warm; two runs per variant do not establish a stable performance difference. Output and build fingerprints: `/tmp/gitrelay-utf8-bench.lKAFpq/`.

### Repository identity change

Two isolated source snapshots, before and after the identity change, ran `scripts/benchmark-delivery.mjs` in old/new/new/old/old/new order on macOS arm64, Node `22.23.2`, Git `2.54.0`, with warm caches and no daemon. All six runs passed the marked-message, receipt and deduplication checks. Across the three runs per snapshot, median startup ranged from 35.6–38.7 ms before and 33.5–37.7 ms after; send from 56.8–60.3 to 59.4–61.3 ms; check from 75.7–82.9 to 79.5–87.0 ms; and send start through check completion from 132.5–144.8 to 139.0–147.3 ms. Median maximum RSS over 15 checks was 55,590,912 and 55,771,136 bytes. The two snapshots also differ in other code, and concurrent load and three runs per variant prevent attributing a stable change to identity alone. `/usr/bin/time -l` reported zero block I/O, which does not prove that no disk I/O occurred. Outputs and source fingerprints: `/tmp/gitrelay-identity-bench.1sKYpt/`.

The CLI delivery benchmark was repeated after the later `writeJson` ownership and receipt-commit changes, again in old/new/new/old/old/new order. All six runs passed delivery, receipt and deduplication checks. Three-run median ranges were 51.5–58.7 ms before and 59.7–63.5 ms after for send, 69.4–80.2 and 79.5–90.8 ms for check, and 121.4–141.4 and 139.6–156.2 ms from send start through check completion. Both snapshots include other code differences; warm caches, concurrent load and three runs per side do not establish a stable percentage or isolate the cause. Evidence: `/tmp/gitrelay-writejson-benchmark.py` and `$TMPDIR/gitrelay-writejson-bench-bw8r1883/summary.json`.

### Legacy delivery-proof guard

This is a historical snapshot of the proof guard alone, not a measurement of the current complete code. An isolated comparison of the pi native-history benchmark changed only the consumer proof guard, alternating old/new/new/old/old/new. All six runs passed their checks for 1,000 recovered receipts and no repeat delivery. Three-run median ranges for 1,000 history entries were 312.9–404.3 ms before and 312.0–375.1 ms after; for 10,000 entries they were 299.9–318.8 ms and 306.3–356.0 ms. Warm caches, concurrent load and three runs per side do not establish a stable percentage. The measured snapshot predates the additional synchronous confirmation-callback validation. Evidence: `/tmp/gitrelay-pi-guard-bench.ud28iO/summary.json`.

### Installer digest stability checks

An isolated macOS arm64, Node `22.23.2` test compared the initial nonblocking streaming digest with the later version that rechecks file and directory witnesses after traversal. For 1,000 small files, two warm-cache runs measured 92.9–93.0 ms before and 95.0–96.4 ms after; for 10,000 files, 824.7–876.1 ms and 848.5–850.2 ms. Digests matched. Whole-process peak RSS from `process.resourceUsage().maxRSS` was 79,456–79,568 and 78,416–78,432 KiB for 1,000 files, and 85,872–86,048 and 98,576–98,720 KiB for 10,000. The baseline lacked the final recheck and also used a larger buffer for small files; it was not the earlier `readFile` implementation. Two runs and uncontrolled external load do not establish a stable percentage. Evidence: `/tmp/gitrelay-digest-recheck-bench/results-optimized.json`.

The final recheck detects changes to already-read entries during traversal, but is not a filesystem snapshot: a non-cooperating process can modify an entry after that entry is rechecked. Its witness storage grows with the number of files and directories. Windows, network filesystems and cold-cache behavior were not measured.

### Auto-sync operation preflight

A local bare-remote comparison on macOS, Node `22.23.2` and Git `2.54.0`
measured up-to-date synchronization with warm caches. Identical isolated source
snapshots differed only in the seven operation-path checks added before fetch;
three alternating groups per variant each averaged five calls. The group means
were 134.27, 129.74 and 132.58 ms before, versus 150.45, 143.80 and 152.04 ms
after. Their medians were 132.58 and 150.45 ms, an observed 17.87 ms increase.
The small sample and concurrent load do not establish a stable percentage;
network, cold-cache and Windows performance were not measured. Each run checked
that the branch, remote-tracking ref and clean worktree were unchanged. The
preflight rejects undecodable operation paths before fetch can update a remote
tracking ref; a second check after fetch blocks merge if an operation starts
in the meantime. Evidence and the reproducible local harness are in
`/var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/gitrelay-sync-preflight-bench-k3a5dn7c/bench.mjs`.

## Manual synchronization and daemon cache retention (2026-10-27, Asia/Singapore)

A private candidate preserves a valid daemon token and its **original**
`checkedAt` when a manual synchronization finds the same ref and event ID,
with no pending publication to recover. It does not extend that observation's
age; changes, missing fields and recovered publications clear the marker. The
candidate was not merged. Without a separate failure-epoch mechanism, retaining
an older observation after a later daemon failure can delay seeing a subsequent
ref change relative to the current behavior that clears the token.

An isolated macOS real-Git fixture used a synthetic live heartbeat, 500 small
retained events, and 12 alternating warm-cache runs per variant. A manual
synchronization preceded a second consumer. After each synchronization the
fixture state was copied while excluding the retained publish lock; this is
not original-location lock recovery or a real daemon test. Against the shared
source containing the check-start timestamp change, full consumer time had
medians of 61.762 ms before and 35.416 ms in the private candidate. The Node
process's user/system CPU medians were 21.542/50.044 ms and 10.329/21.462 ms;
they include Node worker threads but exclude Git subprocess CPU. Git ref
queries occurred in 12/12 baseline calls and 0/12 candidate calls. The
`resourceUsage` filesystem read/write block counters both had medians of zero;
these warm-cache counters do not measure total bytes or disk bandwidth.

A separate private combination with an unmerged daemon generation prototype
used the same workload: median consumer time was 69.401 versus 36.527 ms,
Node user/system CPU was 25.968/55.222 versus 12.192/25.729 ms, and extra
ref queries were 12 versus zero. Two simulated-heartbeat tests verified the
candidate preserves the exact prior generation and timestamp, and that a new
generation falls back to direct synchronization. These checks do not validate a
real daemon, concurrent publication locks, multi-ref scheduling, cold cache,
Windows, power loss or end-to-end client behavior. The generation prototype
used in this comparison predates a separate check-start timestamp fix.

Evidence: `/tmp/gitrelay-ref-preserve.uqMhXX3k/` and
`/tmp/gitrelay-combined-gen.P6tqcXE2/`; both retain their test data. No real
daemon, GC, installer or client was started. The probes were invoked with an
empty environment, isolated HOME/TMPDIR, disabled Git system/global config,
and a preload that disables Node `rm` and `unlink`:

```sh
env -i PATH=/usr/bin:/bin HOME=/tmp/gitrelay-ref-preserve.uqMhXX3k \
  TMPDIR=/tmp/gitrelay-ref-preserve.uqMhXX3k GIT_CONFIG_GLOBAL=/dev/null \
  GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  <home>/.nvm/versions/node/v22.23.2/bin/node \
  --import /tmp/gitrelay-ref-preserve.uqMhXX3k/no-delete.mjs \
  --disable-warning=ExperimentalWarning --experimental-strip-types \
  /tmp/gitrelay-ref-preserve.uqMhXX3k/probe.mjs
```

## Daemon cache recovery tradeoff (2026-10-27, Asia/Singapore)

A private source copy replaced the consumer's fresh-daemon cache branch with
a full `synchronizeRef` on every consume. Six alternating runs per variant used
one isolated real Git repository, one registered session, a matching synthetic
daemon heartbeat, zero, 500 or 2,000 retained message events with no
recipients, and warm local filesystem caches. Each timing used a separate copy
of the state; setup and module imports were excluded.

| Retained events | Existing median | Always-sync median | Approximate reciprocal throughput |
| --------------- | --------------: | -----------------: | --------------------------------: |
| 0               |       15.213 ms |          29.779 ms |               65.7 → 33.6 calls/s |
| 500             |       26.508 ms |          40.062 ms |               37.7 → 25.0 calls/s |
| 2,000           |       62.845 ms |         106.291 ms |                15.9 → 9.4 calls/s |

Median Node process user CPU for the three sizes was 1.618/15.116/44.210 ms
before and 2.671/26.148/81.671 ms after; system CPU was
1.777/21.057/103.770 ms before and 2.552/44.478/195.128 ms after. These
figures omit Git child-process CPU, and threadpool CPU can exceed elapsed time.
The reciprocal is calculated from median single-call latency, not measured
concurrent throughput. The small warm-cache sample does not establish tail
latency, cold-cache I/O, lock contention, realistic event distributions or
real-client performance.

Always synchronizing also makes message consumption depend on a current
successful Git ref query even when a prior daemon hint is fresh; temporary Git
unavailability can therefore delay otherwise unrelated agent messages. That
private copy was not merged; the later consumer change uses the same approach.
Tests retained state and intercepted only Node
`fs.promises.rm` and `unlink`; locks and temporary files remain, and Git's own
filesystem operations were not intercepted. No real daemon, GC or client ran.
Evidence: `/tmp/gitrelay-cache-compare.9P3gxJwW/bench.mjs` and
`/tmp/gitrelay-cache-compare.9P3gxJwW/README.md`. See
[acceptance](acceptance.md#historical-evidence)
for the recovery scenario.

## Watch stderr queue (2026-10-27, Asia/Singapore)

On macOS with Node `22.23.2`, an isolated real Git repository and synthetic Git
wrapper produced a 2,000,000-byte error every 50 ms while `status --watch` ran
for approximately three seconds with stderr unread. Instrumenting Node's
`stderr.writableLength` observed a maximum queue of 72,000,036 bytes before the
change and 65,920 bytes with bounded diagnostics and backpressure handling. Both
processes exited 0 on SIGTERM. Evidence is retained at
`$TMPDIR/gitrelay-watch-queue-mm090zir/`.

This is a synthetic local queue measurement, not a reliable RSS, CPU, disk I/O,
startup or real-client latency benchmark. The candidate intentionally drops
subsequent diagnostics while the pipe is blocked, including broadcast warnings;
the measurement does not establish behavior for synchronous blocked terminals
or other operating systems.

## Always-synchronize consumer measurement (2026-10-27, Asia/Singapore)

Four alternating warm-local runs per variant compared the current consumer
change with the preceding daemon-hint fast path on one real Git repository,
one registered session, a synthetic matching daemon heartbeat and separate
copies of the same state. Setup and module loading were excluded. With zero
and 500 retained message events without recipients, the old median was
18.655 and 30.455 ms; always synchronizing measured 34.506 and 46.758 ms.
Median Node user/system CPU was 1.808/2.228 and 10.370/25.346 ms before,
and 2.829/3.077 and 28.546/58.224 ms after. Git child CPU is excluded;
threadpool CPU can exceed elapsed time. This is a small sequential warm-cache
sample, not concurrent throughput, lock contention, cold-cache I/O, Windows
or end-to-end agent latency. It establishes a cost in this workload, not a
general performance percentage. The daemon continues monitoring independently,
so active clients may duplicate its Git and event scans.

The separate lock-held inbox-snapshot experiment measured 35.117/50.478 ms
for zero/500 events and was not merged; an injected boundary interleaving alone
did not establish an invalid delivery. All fixture states were retained and
Node deletion was intercepted; Git's own filesystem operations were not. No
real daemon, GC, installer or coding-agent client ran. Source, harness and
fixtures: `/var/folders/1b/b19xbzjx7xqc4kl0k9x_y4y80000gp/T/gitrelay-lock-snapshot-vsf_us8t/`.

## Four-at-a-time trash recovery scans (2026-10-27, Asia/Singapore)

The publication recovery scan now reads at most four trash entries at once and
waits for the whole batch before leaving the publication lock. In an isolated
real-Git repository, 12 alternating unchanged-ref calls per variant scanned
synthetic small message records, with no events, sessions or daemon. Warm-cache
median synchronization times for 0, 10, 100 and 1,000 trash records were
11.68/12.90/18.17/69.94 ms serial and 11.79/12.55/15.40/40.72 ms in four-entry
batches. For 1,000 records, Node user/system CPU medians were 24.12/37.19 ms and
18.98/48.56 ms; Git child CPU is excluded. Each call checked the resulting
commit. Results and the two source snapshots are retained at
`/tmp/gitrelay-trash-batch.flVjiFwY/results-final.json`. This small sequential
warm-cache test does not characterize real trash distributions, physical disk
I/O, concurrent consumers, cold or network filesystems, Windows or agent latency.

For a separate near-limit memory probe, four valid 1,742,272-byte trash files
were read in three alternating fresh processes per variant. Whole-process peak
RSS was 108,784/118,912/111,056 KiB serial and 119,200/120,320/118,960 KiB
with batches; the process RSS before synchronization was approximately
84–86 MiB. Setup was excluded and caches were warm. The samples do not
establish a stable memory difference or worst case: parsing, buffers and event
objects can coexist, and four 2 MiB records can consume substantially more
than their file sizes. The batch starts only after the event scan has settled.
