# GitRelay architecture

GitRelay coordinates Codex sessions and manual CLI consumers across worktrees
for one OS user. State lives on the local filesystem; it is not a network service
or a database abstraction. The public package SDK is `src/index.ts`.

## Entry points and command handling

- `src/cli/main.ts` owns process signals, bounded diagnostics, stdout completion,
  command dispatch and exit codes. Output completion remains the delivery boundary.
- `src/cli/args.ts` parses options and rejects explicitly supplied options outside
  the selected command's contract. Parser defaults do not count as explicit input.
- `src/cli/status.ts` owns snapshot polling, optional synchronization, rendering,
  file output and status broadcasts. It uses the CLI's output and cancellation context.
- `src/adapters/hooks.ts` validates native input and maps notifications to Codex
  hook responses. It delegates explicit activation changes to the core lifecycle.

## Session and message transactions

`src/core/session-lifecycle.ts` owns complete enable/disable operations for both
hooks and CLI commands. Enable preserves the existing begin/prepare/register
protocol and failure recovery. Disable records opt-out before closing enrollment.
Adapters do not manage transaction phases or rollback.

`activation.ts` persists choices and pending activation recovery; `sessions.ts`
contains low-level enrollment, missing-worktree lookup and subscription checks.
These lower-level operations remain separate because automatic receiving and
legacy callers need subscription operations without changing explicit choices.

`consumer.ts` registers a receiver, synchronizes its monitored ref and consumes
its independent inbox. `publisher.ts` repairs interrupted publications before
advancing a ref cursor. `mailbox.ts` validates session/event/receipt records,
persists messages and formats delivered notifications. `cleanup.ts` removes only
confirmed events through its deletion journal.

Consumers and join/leave operations acquire the session lock before the
publication lock. GC owns the publication lock and probes session locks without
waiting; a busy receiver keeps its events. `synchronizeRef` and `registerSession`
are internal operations requiring the caller's publication lock. Preserve that
transaction scope when moving code; locking each write independently is insufficient.

## Storage and repository identity

`src/core/store.ts` owns state-root configuration, directory checks, bounded JSON
I/O, atomic file replacement and owned filesystem locks. It does not discover Git
repositories or import repository lifecycle code.

`src/core/repository.ts` owns Git common-directory discovery, persistent repository
identity, initialization, migration readiness and explicit recovery/fresh-state
choices. It depends on storage primitives; storage does not depend on it.
`identity-migration.ts` handles the explicit legacy-data copy protocol.

Storage functions accept only the repository fields they use. In particular,
registering a session needs `root` and `directory`, not a fabricated complete
repository identity.

## Public and internal APIs

New SDK users import `@sistine29/git-relay`. The root exports message consumption/sending,
session listing, formatting, complete enable/disable operations, the history-gap
error and their input/event types. Type declarations are generated from the same
source during the build. See [SDK integration](shared-messages.md#sdk-integration).

The package export map retains the documented legacy consumer, mailbox and
session paths for compatibility. Other subpaths are private; repository layout,
locks and low-level persistence functions are not part of the public SDK.
Relative imports in project tests and benchmark scripts exercise those internals
without making them public package exports.

## Validation

`npm run check` runs formatting, strict type checking, release metadata checks,
the tests and npm packaging. SDK tests use a copied installation without sources,
exercise unread preservation and compile a consumer against the shipped declarations.
Existing interruption, lock contention, output backpressure and native-Git race
regressions remain acceptance gates for refactoring. Local passes do not establish
real Codex discovery/trust, model behavior or hosted CI results.
