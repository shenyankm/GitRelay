# Source releases

Versioned source tags and npm publication are separate release gates. Pushing a
branch or tag runs validation; it does not automatically publish to npm or create
a GitHub release.

The npm package is `@sistine29/git-relay`. The Codex plugin ID and CLI command
remain `git-relay`; the package, lockfile and plugin versions must match.

1. Keep changes under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md). Record
   compatibility changes, migration instructions and remaining limitations.
2. Before a release, choose the version and update `package.json`, the root and
   package entries in `package-lock.json`, and `.codex-plugin/plugin.json`
   together. Keep the Codex category and subtitle within the listing limits. Add
   `## [VERSION] - YYYY-MM-DD` notes and keep an empty Unreleased section for
   subsequent work.
3. Run `npm ci --ignore-scripts`, then `npm run check`. Checks
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

7. For an explicitly requested npm release, verify the npm account with
   `npm whoami`, prepare the reviewed tarball with `npm pack`, and inspect its
   files and integrity. Publish that exact artifact only after the main/tag CI
   gates pass:

   ```sh
   npm publish /absolute/path/sistine29-git-relay-VERSION.tgz --access public --tag latest
   npm view @sistine29/git-relay@VERSION version dist.integrity dist-tags --json
   ```

   Check the registry version and integrity against the local artifact, then
   install the registry tarball into a disposable directory and exercise the
   CLI and SDK. npm login or account two-factor authentication may require the
   publisher's interaction. Keep unpublished or failed publication distinct
   from a successful source push.

Ordinary changes do not require a version bump. A green metadata check does not
prove client compatibility, and a green branch build does not validate a later
tag or a published package.
