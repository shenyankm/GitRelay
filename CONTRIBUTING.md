# Contributing

Requires Node.js 22.19+ and Git; merge diagnosis needs Git 2.38+.

```sh
npm ci --ignore-scripts
npm run check
```

GitRelay is a local stdio MCP service. Keep stdout protocol-only. Reuse the core
identity, publication, delivery and GC machinery; do not implement another state
store or client-specific hook adapter. Validate inputs and preserve lock ordering,
unread events and recovery journals.

New MCP behavior needs a focused protocol/regression test. For messages, verify
that receiving does not acknowledge and that explicit acceptance survives retry.
For lifecycle changes, verify EOF/cancellation cleanup and shared monitor
failover. Test the built source entry from an unrelated working directory and a
worktree path containing spaces. Keep the project private; npm is for dependency
management and local tasks, not GitRelay package publication.

When commands, tools or lifecycle behavior change, update the English and Chinese
READMEs and the affected guides in the [documentation index](docs/README.md).
Check examples against `package.json`, the MCP schemas in `src/mcp/server.ts` and
`.github/workflows/check.yml`; test counts and host results belong to dated
evidence, not timeless compatibility promises. Preserve historical measurements
and mark obsolete guidance rather than rewriting the recorded results.

Benchmarks run against a built tree. `scripts/benchmark-delivery.mjs` measures the
MCP path; the other focused scripts measure core operations. Do not compare
pre-MCP hook/CLI numbers as if they measured the same protocol. Keep controls and
failed candidates when recording performance evidence.
