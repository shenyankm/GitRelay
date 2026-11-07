# Documentation index

These guides describe the current source-only stdio MCP service and optional Codex plugin. Start with the
[English README](../README.md) or [中文说明](../README.zh-CN.md) for installation
and the participant workflow.

## Current guides

| Guide                                                  | Use it for                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [Codex plugin](plugin.md)                              | Local source installation, skills, reminder hooks and upgrades                     |
| [MCP integration](integrations.md)                     | Source build, host configuration, environment and connection lifecycle             |
| [Source coordination](coordination.md)                 | Explicit tracking, local/remote/PR coverage, conflict levels and automatic notices |
| [Tools and shared messages](shared-messages.md)        | Tool inputs, private session handles, receiving and explicit acknowledgement       |
| [Architecture](architecture.md)                        | Runtime modules, state, observers, locks and transport boundaries                  |
| [Maintenance](maintenance.md)                          | Monitor ownership, disabling tracking, cleanup and recovery                        |
| [Migration](migration.md)                              | Incompatible MCP-only upgrade, new state namespace and no old-state import         |
| [Source updates](releases.md)                          | Updating and rebuilding a checkout, then restarting the MCP server                 |
| [Acceptance](acceptance.md)                            | Current validation commands and the limits of each evidence layer                  |
| [MCP performance](performance-20-rounds-2026-11-07.md) | Twenty measured candidates, retained changes, controls and validation limits       |
| [Platform and host matrix](platform-matrix.md)         | Configured CI versus locally verified host/platform behavior                       |
| [Contributing](../CONTRIBUTING.md)                     | Development checks and documentation maintenance                                   |
| [Changelog](../CHANGELOG.md)                           | Unreleased changes and earlier versions                                            |

npm is retained for dependencies, builds and tests, not gitbeacon distribution.
The runtime entry is `dist/mcp/main.js`; joining does not implicitly authorize
source tracking, and reading a notification does not acknowledge a message.
See the guides above for the complete workflow and safety boundaries.

## Historical material

- [Dated evidence](evidence/README.md) indexes recorded source snapshots and runs.
- [Pre-MCP performance](performance.md) preserves old CLI/hook measurements.
- [Optimization rounds](optimization-rounds.md) preserves the old experiment log,
  including packaging and integrations that have since been removed.

Historical commands, test counts and “retained” decisions apply to their recorded
revision only. They are not current installation instructions, a current test
count or a promise of compatibility. Use `npm run check` for the current checkout;
check dated evidence separately for live API, native model and hosted CI claims.
