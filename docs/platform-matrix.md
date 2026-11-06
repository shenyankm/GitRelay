# Platform and host matrix

| Surface                         | Scope                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                           | Local stdio MCP and filesystem/Git regression acceptance in this checkout                                                                            |
| Linux                           | CI matrix configured for Node 22.19 and 24; hosted results must be checked separately                                                                |
| Windows                         | Not accepted in this refactor; POSIX filename delivery and protected Git synchronization retain their platform guards                                |
| Official TypeScript MCP client  | Real stdio discovery, calls, reconnect and acceptance tests                                                                                          |
| Codex MCP client                | Codex CLI 0.167.0: real authenticated model consumed/acknowledged an automatic conflict via polling; idle-model wake-up and desktop GUI not accepted |
| Other MCP hosts                 | Standard stdio interface available; individual host/model workflows are not implied by SDK tests                                                     |
| Web / remote multi-user hosting | Not provided; local filesystem ownership remains the boundary                                                                                        |

The server uses the official TypeScript SDK's stdio entry with legacy-client
compatibility. No Codex lifecycle hooks, automatic context injection or idle
model wake-up remain. See [acceptance](acceptance.md) for measured evidence.
