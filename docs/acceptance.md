# MCP acceptance

GitRelay 0.2 replaces the hook/CLI integration with a local stdio MCP server.

## Required checks

```sh
npm run check
node scripts/benchmark-delivery.mjs
```

The combined check validates formatting, strict TypeScript, consistent package
metadata, the core regression suite, real MCP stdio tests and npm packaging.
A production installation test installs the tarball without source/dev tooling
and calls its MCP tools from a path containing spaces.

MCP acceptance covers discovery and input validation, read-only observation,
independent private session handles, receive without acknowledgement,
disconnect/reconnect, explicit/idempotent acceptance, stale/damaged batch
rejection, partial-write retry, monitor ownership and repository isolation.
Packaging and discovery checks reject the removed Web surface.
Safety regressions cover bounded/refilling tool-call budgets, concurrent-call
limits, diagnostic sanitization and same-connection protocol-version retry.
Existing Git/GC/storage race and corruption regressions remain required.

Current refactor evidence is recorded under
[evidence/2026-11-05-mcp/summary.json](evidence/2026-11-05-mcp/summary.json).
Local SDK acceptance, native Codex MCP discovery/calls, a real model workflow,
desktop GUI behavior and hosted CI are independent evidence layers.

The [follow-up usability run](evidence/2026-11-05-mcp-usability/summary.json)
repeated all 433 checks and exercised 21 successful native Codex tool calls,
including host restart, unread recovery, explicit acknowledgement and dirty-work
preservation. Its browser checks describe the since-removed Web console, not the
current runtime. No model turns were run.

## Historical results

The archive preserves pre-MCP benchmarks and hook/native-model traces. They
validate the old version only and do not establish the new MCP transport's
latency, model behavior or host compatibility. See the
[evidence archive](evidence/README.md).
