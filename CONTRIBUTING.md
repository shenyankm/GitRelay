# Contributing

Requires Node.js 22.19+ and Git.

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
failover. Test the packaged runtime without source or development dependencies.

Benchmarks run against a built tree. `scripts/benchmark-delivery.mjs` measures the
MCP path; the other focused scripts measure core operations. Do not compare
pre-MCP hook/CLI numbers as if they measured the same protocol. Keep controls and
failed candidates when recording performance evidence.
