# Dated evidence

Files in this directory record the dated source snapshots named by their paths.
They may include retired OpenCode or other client integrations, obsolete entry
points, earlier session defaults and old test counts. These are historical
results, not current setup instructions or compatibility guarantees.

- [Source coordination](2026-11-07-coordination/README.md) records automatic
  conflict notification/resource delivery, read-only live GitHub fork/PR checks
  and separate native Codex model consumption with polling fallback.
- [Hidden-problem diagnostics](2026-11-07-hidden-problems/README.md) preserves seven
  failures on the pre-fix implementation, not current unfixed issues.
- [Hidden-fix acceptance](2026-11-07-hidden-fixes/README.md) records the corrected
  scenarios, full regressions and the real PR notification/resource/ACK chain.
- [MCP refactor](2026-11-05-mcp/summary.json) records the 0.2 transport, delivery,
  packaging and host checks independently from earlier hook evidence.
- [MCP usability](2026-11-05-mcp-usability/summary.json) records native tool calls
  and restart/recovery; its Web checks apply only to the since-removed console.
- [Acceptance history](acceptance-history.md) preserves the earlier narrative
  reports and their original raw-evidence links.
- [Legacy acceptance results](../acceptance-results.json) retain the older raw
  report, source/build hashes and fixture outputs at their existing path.
- [Performance guide](../performance.md) explains the recorded benchmarks and
  their measurement limits.

The coordination/hidden-fix runs predate the source-only change; their package
checks do not establish current distribution support. Source version `0.2.0`
alone does not identify which checkout was tested. Consult each record's commit,
source fingerprints, timestamps and limitations.

Raw logs, hashes and measurements are retained without rewriting their results.
For the MCP runtime, use the [current acceptance guide](../acceptance.md),
[platform matrix](../platform-matrix.md) and [integration guide](../integrations.md).
