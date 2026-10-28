# Contributing to GitRelay

Bug reports, documentation fixes, tests, and focused pull requests are welcome.
For a larger feature or a change to delivery or state semantics, open an issue
first so the scope can be discussed.

## Development setup

Use Node.js 22.19.0 or newer, npm, and Git. GitHub branch queries also require
an authenticated GitHub CLI (`gh`); ordinary development does not.

Fork the repository, clone your fork, and create a branch for your change:

```sh
git clone https://github.com/YOUR-USERNAME/GitRelay.git
cd GitRelay
git switch -c fix/your-change
npm ci --ignore-scripts --omit=optional
npm run build
```

The build generates `dist/` using Node's built-in TypeScript stripping. Edit
source files rather than generated output. Do not commit `dist/`,
`node_modules/`, or `.codex/plugin-build/`.

## Making a change

- Keep the change focused and reuse existing helpers. The runtime uses Node's
  standard library and local Git; avoid adding runtime dependencies.
- Shared Git, state, and delivery logic lives in `src/core/`; Codex/OpenCode integration
  belongs in `src/adapters/`, and CLI behavior in `src/cli/`.
- Add a regression test for a bug fix. Tests live in `tests/core/`,
  `tests/adapters/`, and `tests/cli/`; reuse the temporary repositories and
  isolated state directories in `tests/helpers.ts`.
- Preserve unread events, independent receiver receipts, compatibility aliases,
  and existing user configuration. Document any migration or behavior change.
- Keep code, comments, and documentation in English. `README.zh-CN.md` is the
  Chinese entry point; update both READMEs when shared user instructions change.
- Never include credentials, private messages, or personal client configuration
  in fixtures, logs, or reports. `npm run check` scans `docs/` for common
  credential patterns.

## Validation

Run the same checks as CI before opening a pull request:

```sh
npm run check
```

`npm run format` applies the pinned formatter. Type checking also rejects unused
locals and parameters. Generated output, vendored sources and historical raw
acceptance evidence are excluded from formatting.

`check` runs formatting, type checking, release metadata, tests, a docs
credential scan, and packaging sequentially. Do not run builds, tests or
packaging concurrently in one checkout: they replace the same `dist/`. For a
focused iteration:

```sh
npm run build
node --experimental-strip-types --test tests/cli/package.test.ts
```

CI checks Linux and macOS on Node.js 22.19.0 and 24. For performance changes, run
the [benchmark recorder](docs/performance.md#record-a-reproducible-run) and report
the workload and environment. For Codex plugin
packaging changes, run `npm run build:codex-plugin`.

Use disposable repositories and isolated state for manual integration checks.
Report local tests, real-client acceptance, and CI results separately. Include
the client version and tested source revision for host-specific behavior;
passing unit tests alone does not establish delivery into a real agent session.
See the [integration guide](docs/integrations.md),
[acceptance records](docs/acceptance.md), and
[performance notes](docs/performance.md) for scope and known limitations.

## Issues and pull requests

For a bug report, include the OS, Node.js/Git versions, relevant agent version,
GitRelay revision, reproduction steps, expected behavior, and actual behavior.
Redact sensitive paths and content from logs.

In a pull request, explain the problem, the resulting behavior, and validation
commands with their results. State any checks you could not run. Use a concise
English commit subject following the existing Conventional Commits style, such
as `fix(cli): Preserve unread messages on exit`.

See [source releases](docs/releases.md) for version/tag consistency and the
release acceptance checklist. A normal contribution does not publish a release.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE). Retain existing third-party copyright and
license notices, including [`vendor/smol-toml/LICENSE`](vendor/smol-toml/LICENSE).
