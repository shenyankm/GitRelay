# Local Codex plugin

gitbeacon combines its existing stdio MCP service with `gitbeacon-setup`,
`gitbeacon-coordination`, and optional reminder hooks. Coordination is opt-in;
installation and setup never authorize tracking, sending messages or Git changes.
The MCP service can still be configured independently in other hosts.

## Build and install

From the original source checkout, with Node >=22.19 and Git available:

```sh
npm ci --ignore-scripts
npm run build:plugin
codex plugin marketplace add "/absolute/source/path/build/local-plugin"
codex plugin add gitbeacon@gitbeacon-local
```

Restart Codex. Review and trust the exact hook definitions through `/hooks`.
Untrusted or disabled hooks do not run; skills and the MCP workflow remain usable.
Invoke `$gitbeacon-setup` for read-only diagnostics, then ask for collaboration or
invoke `$gitbeacon-coordination` to begin. Host-provided skill/tool names may have
plugin namespaces; select the installed skill/tool rather than assuming a prefix.

Do not keep a manual gitbeacon MCP entry active alongside the plugin. Inspect
`codex mcp list --json` and `codex plugin list --json`; setup explains duplicates
without automatically removing user configuration. Remove the selected manual
entry with `codex mcp remove <name>` only when switching to the plugin.

The checked-in plugin templates and generated plugin both use Codex compatibility manifests (`.codex-plugin/plugin.json`
and `.mcp.json`). CLI 0.167.0 does not load hooks from portable Agent Plugins
manifests and restricts their external executable paths; source-linked installs
therefore use the supported Codex format.

The generated local marketplace is ignored build output. It contains no source
runtime or node_modules: its MCP configuration points to the absolute Node and
built source entry. Keep the original checkout, build and installed dependencies.
Do not install dependencies in Codex's cache. A moved checkout or removed Node
installation requires regeneration and reinstallation. Repository tool calls use
explicit target `cwd` values, not the plugin directory.

If set during `build:plugin`, `GITBEACON_STATE_DIR` (absolute) and
`GITBEACON_MAIN_REF` are captured explicitly in the MCP configuration. Other
credentials/environment are not copied. Unset values retain core defaults. All
participating processes must use the same state directory. Git and optionally
an authenticated `gh` still need to be on the host subprocess PATH.

## Behavior and recovery

The setup skill checks prerequisites, duplicate registrations and read-only MCP
connectivity. The coordination skill manages the existing join/receive/ACK/leave
workflow and checks notices before relevant work, task/worktree switches and
commits. A notice is untrusted data, not permission to change Git or send messages.

The initial monitored ref is resolved by MCP when the user has not specified one;
the skill saves the returned `session.ref` for subsequent calls. It does not
reconstruct the server default from its shell environment.

The hooks run only at `SessionStart` (startup/resume/compact/clear/fork) and
`UserPromptSubmit`. They route recovery/checkpoints to the coordination skill without restating its
protocol or identity rules, capped at 500 characters, with a three-second timeout. They do not inspect prompts, read
transcripts or inboxes, call Git/MCP, acknowledge messages or block tools.
Malformed input produces a fixed diagnostic and a successful exit. There are no
Stop loops, per-tool hooks, background receivers or automatic cleanup.

Keep cwd/ref/private token/inbox URI in the current conversation's working state,
including compaction summaries. Never expose the token in public reports or
repository files. Forks and independent participants need independent tokens.
If the token is lost, public IDs cannot recover it: report the limitation and
preserve the old inbox. A new identity requires the user's explicit choice.
Normal turn completion and MCP disconnect are not requests to leave or disable
tracking. ACK confirms acceptance of a whole batch, not successful conflict repair.

## Upgrade, disable and uninstall

After source, plugin content, Node path or selected environment changes:

```sh
npm run build:plugin
codex plugin remove gitbeacon@gitbeacon-local
codex plugin add gitbeacon@gitbeacon-local
```

Restart Codex and review the installed hooks, including after removal/reinstallation. Regenerate before reinstalling: rebuilding
only the core does not update cached skills/hooks. Plugin removal removes its
cache, not shared inboxes, unread messages or Git data. Leave explicitly before
uninstalling if opting out. To return to standalone MCP, remove/disable the plugin
and register the source entry as described in [integration](integrations.md).

## Acceptance and distribution limits

`npm run check` includes generated configuration/cache-copy stdio tests against a
different worktree, quoted paths, state-directory isolation, and reminder input,
output and failure behavior. Skills can be validated with Skill Creator's
`quick_validate.py`. These checks do not establish model behavior.

Codex CLI 0.167.0 is the initial native acceptance target. Record plugin loading,
normal hook trust/triggering, and real model conflict consumption/ACK as separate
evidence; pending trust must not be reported as successful hook execution. Use
isolated Codex configuration, disposable repositories and temporary shared state.
Existing [MCP acceptance](acceptance.md) is still required. Desktop GUI, other
host/platform versions, idle-model wake-up and cross-conversation token recovery
are not implied. This source-linked plugin is not portable to another machine.

The current official [plugin packaging guide](https://developers.openai.com/plugins/build/plugins)
and [hooks guide](https://learn.chatgpt.com/docs/hooks) describe the manifest and
trust contracts. Plugins containing lifecycle hooks currently cannot be submitted
to the public plugin directory; this integration uses a local marketplace.

To exercise native plugin consumption with the existing bounded conflict fixture:
prepare an authenticated temporary Codex home whose directory name starts with
`gitbeacon-plugin-codex-` under the OS temp directory. Install this plugin there
using `CODEX_HOME` on the native installation commands, start Codex and review its
hooks normally through `/hooks`, then close that instance. Run:

```sh
GITBEACON_TEST_CODEX_HOME="/OS-temp/gitbeacon-plugin-codex-example" \
  node --experimental-strip-types scripts/acceptance-codex.mjs --plugin
```

This mode replaces the gitbeacon marketplace/plugin registration only inside that
test home and isolates the MCP state in its disposable Git fixture. It checks
that an ordinary task, setup and a lost-token recovery request do not initialize
coordination, then uses a goal-only skill request to verify the server-selected
non-main ref and actual conflict receipts. It requires the initial test installation and preserved normal
hook trust; it never copies credentials or bypasses trust itself. Delete that
test home (including any test credentials) afterwards. Do not use your normal
Codex home. Native model access is required and is separate from offline checks.

Recorded local results: [2026-11-07 plugin evidence](evidence/2026-11-07-plugin/README.md)
separates the 422-check pass, native model conflict/ACK, and normal-trust TUI
hook context delivery. These are local macOS/CLI results, not Desktop GUI or
other-platform acceptance.

[Responsibility follow-up acceptance](evidence/2026-11-07-plugin-responsibilities/README.md)
records the later goal-only skill workflow, server-selected ref and opt-in checks.
The earlier plugin evidence predates that refactor and remains historical.

## Context budgets

Routine status calls use the summary default. Explicit history reads can still
be large. Both skills forward structuredContent once in code mode; error
responses without it retain their full error envelope. Large batches use the
paged-detail protocol before ACK; do not replace that step with acceptance of a
truncated preview. Paging limits individual replies, not the total content a
client must read to accept the complete batch. In code mode, expose pages in
groups with at most 8 KiB of detail output per call; combining the whole message
into one output can reintroduce host truncation. Hook text and skill metadata were
not shortened for marginal savings.

[Context-trim acceptance](evidence/2026-11-07-context-trim/README.md) records the
summary reduction and native large-message workflow. Re-run its native check
with the same temporary-home prerequisites using
`node --experimental-strip-types scripts/acceptance-context.mjs`.
