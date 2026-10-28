# Source releases

GitRelay is currently installed from source. These checks do not publish to npm
or create a GitHub release.

1. Keep changes under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md). Record
   compatibility changes, migration instructions and remaining limitations.
2. Before a release, choose the version and update `package.json`, the root and
   package entries in `package-lock.json`, and `.codex-plugin/plugin.json`
   together. Keep the Codex category and subtitle within the listing limits. Add
   `## [VERSION] - YYYY-MM-DD` notes and keep an empty Unreleased section for
   subsequent work.
3. Run `npm ci --ignore-scripts --omit=optional`, then `npm run check`. Checks
   run sequentially because both tests and packaging rebuild the shared `dist/`.
   Build the Codex plugin with `npm run build:codex-plugin` and complete the
   [native acceptance checklist](acceptance.md) against the intended source.
4. Record the tested commit, client versions, raw results and any skipped checks.
   Run the [benchmark recorder](performance.md#record-a-reproducible-run) for
   performance changes. Historical results do not validate a new runtime.
5. Commit the release metadata, then verify tag readiness without creating a tag:

   ```sh
   GITHUB_REF_TYPE=tag GITHUB_REF_NAME=vVERSION npm run check:release
   ```

6. Only after the release is explicitly requested, tag that reviewed commit as
   `vVERSION` and push the tag. The existing CI runs the same checks on tag pushes
   and rejects inconsistent metadata or missing dated notes. Verify all four
   matrix jobs for that exact tag before announcing a source release.

Ordinary changes do not require a version bump. A green metadata check does not
prove client compatibility, and a green branch build does not validate a later
tag or a published package.
