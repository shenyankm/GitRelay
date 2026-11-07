# Seven hidden-problem fixes: acceptance

This is post-fix evidence for the seven findings recorded in
[the original diagnostic report](../2026-11-07-hidden-problems/README.md).
The original reports/JSON are retained as historical evidence. The base commit
is `b5cda33`; these fixes were tested in the working tree, without committing or
pushing. `checks.json` fingerprints the tested source files.

## Corrected behavior

| Original problem | Fix and acceptance boundary |
| --- | --- |
| SIGKILL stopped monitor takeover | New MCP/monitor ownership records are atomically published. Verified-dead recovery is serialized with unique bakery tickets, including recovery after the recoverer itself is killed. Live, replaced, corrupt and ambiguous owners remain protected. |
| Child enrollment disabled the parent's GitHub tracking | Existing source/GitHub/disabled preferences remain byte-for-byte unchanged; the child inherits the known source identity without changing parent opt-in. |
| Corrupt registration blocked unrelated sources | Each bad record is quarantined and retained. Known unrelated sources continue; same/unknown ancestry remains an explicit coverage gap instead of a false clean result. |
| CRLF snapshots invented conflicts | Only safe source normalization settings enter private snapshot commands. The real CRLF clone merges the independent upstream edit cleanly, without a false shared-file conflict or changes to its original index/config. Unsupported filtered/private-attribute snapshots fail as unknown. |
| Case-insensitive path collisions were missed | The merged tree is checked against the receiver's folding rules, including directory prefixes and fast-forward updates. Physical folding can be detected even when `core.ignorecase` is wrong. |
| Slow remote blocked healthy sources | Groups execute independently; the daemon does not await remote scans in its ref/heartbeat loop. A healthy source produces repeated fresh conflict reports while another SSH handshake remains stalled. |
| SHA-256 repositories could not be observed | Observer format matches the source. A separate `observer-sha256.git` preserves an existing SHA-1 store; caches distinguish object formats. |

## Recorded evidence

- `checks.json`: full formatting/type/release/regression/production-package checks.
- `verify-fixes.json`: strict positive verification of all seven original real
  scenarios, using actual Git, stdio processes, GitHub clone/API, filesystem case
  folding, SIGKILL and a real stalled localhost SSH handshake.
- `live-github.json`: real public PR conflict → automatic MCP notification →
  resource update → explicit ACK, with user refs/index/work preserved.

No cloud branch or PR is created or changed. Every fault, merge, index/config
inspection and process kill is confined to disposable test-owned state. The
verification JSON's `implementationModified` field distinguishes this tested
working tree from the historical unmodified base commit.

## Regression coverage

- `tests/core/lock-recovery.test.ts`: verified-dead/live/ownerless owners,
  eight-process mutual exclusion, complete public ownership, corrupt/live
  recovery tickets, killed recovery participant and replacement races.
- `tests/core/coordination-hardening.test.ts`: preferences, corrupt-source
  quarantine/coverage gaps, CRLF semantics, case-folded file/directory and
  fast-forward trees, and SHA-256 compatibility with legacy-store preservation.
- `tests/mcp/monitor-recovery.test.ts`: actual monitor SIGKILL failover/push and
  multiple healthy updates during an unrelated stalled SSH connection.
- `tests/core/conflicts.test.ts`: observer driver isolation, unsupported
  normalization cases and actual filesystem calibration.

The old daemon busy-lock fixture now observes atomic hard-link publication
instead of `open("wx")`; its retry/isolation assertions are unchanged. Generic
legacy lock callers retain the old explicit-recovery default.

## Reproduce

```sh
npm run check
node --experimental-strip-types scripts/diagnose-real.mjs --verify-fixes
node scripts/acceptance-live.mjs https://github.com/koriym/Koriym.Psr4List
```

Strict verification returns failure if an applicable scenario lacks its corrected
positive behavior; merely failing to reproduce the old symptom is insufficient.
Filesystem/SHA-256 skips remain separately visible rather than counted as passed.

Not established by these results: Windows/Linux hosted acceptance, desktop GUI,
idle-model wake-up, power-failure durability, large-fork throughput or safe
execution of arbitrary custom Git filters. Recovery intentionally does not
remove unverifiable legacy ownerless/corrupt locks or use age to steal live/PID-
reused ownership. External filters and private attributes remain explicit unknown
snapshot cases rather than being executed in the observer.
