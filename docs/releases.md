# Source updates

gitbeacon is a private, source-only Node.js project. npm manages dependencies and
local tasks; there is no npm packing/publishing workflow, package-name SDK export,
global executable shim or install-time build hook.

From the gitbeacon source checkout, validate and run an update:

```sh
npm ci --ignore-scripts
npm run check
node /absolute/path/to/gitbeacon/dist/mcp/main.js --cwd /absolute/path/to/worktree
```

`npm run check` checks formatting and types, builds JavaScript, and runs the core
and MCP regressions including source-runtime smoke tests. Build explicitly with
`npm run build` after changing source; dependency installation does not build it.
Restart the configured MCP server after rebuilding; an already-running process
does not hot-reload updated JavaScript. Rejoin with the saved private session
token to resume the durable inbox. If the checkout moves, update the configured
absolute entry path too.

Review [MCP acceptance](acceptance.md), host evidence and platform gaps separately.

The service still reads its version from the local `package.json`. If the source
version changes, keep both root version/name entries in `package-lock.json`
consistent. Git commits/tags and hosted CI are separate actions and require their
own verification; this project does not validate tags as npm release requests.

Previously published npm versions are historical artifacts and are not altered
by making this checkout private. Existing global installations are not silently
uninstalled. See [breaking upgrades](migration.md) for the new MCP-only state
namespace; no plugin uninstall or state-import implementation is included. Historical
package/tarball evidence remains in the repository without being reinterpreted as
current distribution support.

## Optional Codex plugin updates

See [plugin installation and upgrades](plugin.md). Build with `npm run build:plugin`,
then remove and re-add the local plugin and restart Codex. Review changed hooks
through `/hooks`. Node/source paths and selected environment are captured at build
time, so regenerate after moving the checkout or changing those values. Plugin
removal never removes shared collaboration state. This is source-linked local
distribution, not an npm release or a self-contained runtime package.
