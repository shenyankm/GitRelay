# Source coordination acceptance — 2026-11-07 (UTC+08)

This directory records distinct evidence layers, not a claim of universal host or
platform support. JSON timestamps are UTC. No remote writes were made.

- `checks.json`: final local validation, regression/package test counts and commands.
- `live-github.json`: authenticated read-only GitHub source/open-PR observation,
  actual local Git conflict against the real PR, automatic stdio notification and
  inbox resource update, explicit ACK, and unchanged local refs/index/work.
- `live-forks.json`: authenticated read-only discovery and object import of
  `shenyankm/GitRelay` and its accessible `bfs2021/GitRelay` fork (five branch
  revisions, no open PRs at observation time), using `observeGitHub` against a
  disposable private observer.
- `native-codex.json`: a real authenticated Codex CLI 0.167.0 model turn joined a
  disposable local worktree, consumed an automatic peer-branch conflict, explicitly
  acknowledged the batch and left its subscription. It used polling fallback.

The live fixture was public `koriym/Koriym.Psr4List` PR #15. GitHub metadata,
branch/PR SHAs and object fetches were real; only the receiver's incompatible
working edit was created locally. The script made no GitHub mutations and removed
its disposable local state. The external PR can change/close after this run.

The native host's open-world tool policy rejected model-initiated tracking in an
initial attempt. The successful test explicitly enabled tracking through the
operator before starting the model and configured the MCP state directory in the
server's env. Initial attempts wrote two disposable fixture subscriptions to the
host-filtered default state root; those exact test-owned records were verified
and removed. No user subscriptions were removed. The successful native run used
only isolated temporary state; the recorded JSON excludes private session tokens.

Automated GitHub fixtures also cover pagination, fork discovery, PR base/head
conflict routing, closure refresh and remote branch deletion. Their HTTP metadata
and URL transport are simulated, so they are not counted as live API evidence.
Objects, fetches and merges within those tests use real Git.

Reproduce from a built checkout:

```sh
npm run check
node scripts/acceptance-live.mjs https://github.com/koriym/Koriym.Psr4List
node --experimental-strip-types scripts/acceptance-codex.mjs
```

Live scripts require credentials/network/model access, are not part of offline
`npm test`, and should not be interpreted as a performance benchmark. Transport
push is established by real MCP clients; native model consumption is established
separately. Idle-model wake-up, desktop GUI, Linux hosted CI and Windows are not
accepted by these local results.
