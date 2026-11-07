# Platform and host matrix

| Surface                         | Scope                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| macOS                           | Local stdio MCP/filesystem/Git regressions on Darwin arm64, Node 22.23.2 and Git 2.54.0                                        |
| Linux                           | CI matrix configured for Node 22.19 and 24; hosted results must be checked separately                                          |
| Windows                         | Not accepted in this refactor; POSIX filename delivery and protected Git synchronization retain their platform guards          |
| Official TypeScript MCP client  | Real stdio discovery, calls, reconnect and acceptance tests                                                                    |
| Codex MCP client                | Dated Codex CLI 0.167.0 run consumed/acknowledged an automatic conflict via polling; not a retest of every later source change |
| Other MCP hosts                 | Standard stdio interface available; individual host/model workflows are not implied by SDK tests                               |
| Web / remote multi-user hosting | Not provided; local filesystem ownership remains the boundary                                                                  |

`.github/workflows/check.yml` configures both Ubuntu and macOS on Node 22.19.0
and 24, with dependency installation and `npm run check`; it does not publish a
package. Configuration is not a hosted pass result.

The official TypeScript SDK serves standard 2025 and 2026 MCP clients over stdio;
this is protocol support, not an old client-plugin compatibility layer. Transport notifications/resources are implemented, but automatic
context injection, idle-model wake-up and desktop GUI behavior are not established.
No native-client lifecycle hooks, plugin installer or old-state migration remain. See [acceptance](acceptance.md) and the
[dated evidence index](evidence/README.md) for measured scope and source snapshots.
