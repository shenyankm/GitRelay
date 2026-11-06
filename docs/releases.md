# Source releases

The 0.2 line is a breaking MCP release. It removes the former command/hook/plugin
surfaces while preserving the local state engine and explicit migration tools.

1. Update package.json and both root version/name entries in package-lock.json.
2. Keep an Unreleased changelog section and record the breaking migration.
3. Run `npm run check` and verify a clean production tarball installation.
4. Review [MCP acceptance](acceptance.md), native host evidence and platform gaps.
5. When explicitly authorized to release, add dated version notes, create the
   matching vVERSION tag and verify branch/tag CI and the published tarball.

`check:release` validates package/lock consistency and tag/changelog agreement.
The MCP server reads its version from the installed package metadata. No plugin
manifest or generated client installer is part of release validation.

A successful local check does not mean the commit was pushed, CI ran, or npm was
published. Historical evidence is retained in the repository and excluded from
the runtime npm package.
