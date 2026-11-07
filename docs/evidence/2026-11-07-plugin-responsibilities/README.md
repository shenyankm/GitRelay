# Plugin responsibility follow-up — 2026-11-07

The implementation now has one owner for each behavior:

- MCP resolves the initial default ref; the skill retains the returned session ref.
- Skills own participation, recovery and work checkpoints. Hooks only route an
  already-enabled conversation to the coordination skill.
- The source manifest/event configuration uses the delivered Codex format.
  Building binds version, executable/source paths and selected environment.

`npm run check` passed all 422 tests, formatting and strict TypeScript. The focused
plugin regression additionally checks a non-main server default through real
stdio join/resume/leave and compares generated metadata with the native template.
Both skills passed Skill Creator validation.

`native-skills.json` records four real Codex CLI 0.167.0 model turns in isolated
configuration and disposable Git worktrees. Ordinary branch lookup, setup, and
lost-private-token recovery initialized no collaboration state. Setup and recovery
read the actual installed skills. A goal-only coordination request adopted the
server's `refs/heads/feature/a`, received a peer conflict in `shared.txt`, explicitly
acknowledged it and left. That prompt did not prescribe MCP calls or ACK steps.
The remote catalog was unreachable during setup; local plugin/MCP diagnosis still
succeeded. The initial preflight attempt timed out because its subprocess stdin
was left open; the script was corrected and all four turns then passed.

Hooks were reviewed through the normal native trust flow, without bypass.
The test home and temporary credentials were removed afterwards; normal user
configuration and repositories were not modified. No remote writes were made.
These cases do not establish broad skill quality, Desktop GUI/other-platform
support, idle-model wake-up or cross-conversation token recovery.
