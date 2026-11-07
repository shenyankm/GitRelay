# Source-centered coordination

GitRelay tracks a source's registered local repositories, branches and worktrees,
configured remote branches, and (with GitHub authorization) accessible fork
networks and open PRs. It diagnoses conflicts and routes durable notices to the
participating subscriptions, then pushes notices to their bound MCP connections.
It never treats a notice as authorization to change Git state.

## Enable

After user authorization, invoke:

```json
{ "cwd": "/absolute/path/to/clone", "github": true }
```

with `track_repository`. On a new registration, omitting `github` leaves GitHub
API discovery off. On an existing registration, omission preserves its setting;
pass `github=false` explicitly to turn off its GitHub API discovery. The call
authorizes private fetches of configured remote branches even when `github=false`.
A host may require tool approval.

Register each independent clone that should participate. Local remote paths are
recursively discovered, including clone-of-clone relationships. Upstream/origin
identities normalize SSH/HTTPS spellings; GitHub API discovery resolves forks to
their root source. `source` explicitly overrides source selection when needed.
Existing repository identities and ordinary mailboxes remain separate. Discovery
preserves existing member preferences (including GitHub opt-in and disabled
tracking) and inherits a registered local parent's canonical source identity.

Each independent participant calls `join_session`, saves its private token and
uses an existing full ref (default `refs/heads/main`, or pass e.g.
`refs/heads/master`). Its current worktree snapshots determine conflict relevance;
this analysis is not restricted to the subscription's upstream ref. Joining alone
does not authorize source tracking. Enabling tracking starts a monitor candidate
even before a participant joins; the server connection must remain open.

The shared monitor observes all local branch/remote-tracking refs in registered
repositories, all accessible worktrees, and their staged/working snapshots. The
usual local scan delay is five seconds plus scan time; remote/API inventories
refresh no more frequently than once per minute. Untracked non-ignored files are
included; ignored files are not imported. Configured remote branches are fetched
into a private observer. `github=true` additionally discovers accessible fork
networks and open PR head/base SHAs with paginated metadata requests. Source
groups scan independently: a stalled remote cannot stop other groups or the
monitor's heartbeat/ref loop. A group never overlaps its own in-flight scan.
The initial upstream baseline does not suppress newly diagnosed notices about
conflicts that predate enrollment.

## Results

`coordination_status` returns tracking configuration and the latest source-group
report: inventories, cloud/remote timestamps, coverage errors and per-session
findings. `scan_repository` performs an immediate scan; it does not bypass remote
caching. A concurrent scan returns a busy error. Failed scans expose
`lastScanError` without discarding the last complete report. Always check errors
and timestamps: an old report is not evidence of a current clean state. Corrupt
registrations are retained and quarantined; known unrelated sources continue.
If a corrupt entry's source cannot be established, coverage is explicitly unknown.

| Level      | Meaning                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `conflict` | Native Git reports a merge conflict, or merged paths collide on the receiver's case-insensitive filesystem.         |
| `overlap`  | Paths overlap but Git can merge these snapshots cleanly. Semantic compatibility is not established.                 |
| `unknown`  | History/objects are unavailable, observation failed, the worktree raced, or snapshot/merge support is insufficient. |
| `resolved` | A previously reported condition is no longer present in the latest complete analysis.                               |

A confirmed conflict stays visible even if another observation is incomplete;
errors and unknown findings remain in the same report. PR heads are compared to
local snapshots; a participant on a PR's own head branch also gets its head/base
merge diagnosis. Source-wide observation errors notify participating sessions
rather than silently declaring them unaffected.

Stable reports are deduplicated. Changed reports and resolutions create new
session-scoped message events. Truncated notice previews contain total counts;
the full current report is available through `coordination_status`. Messages
retain private resumable inboxes, explicit ACK, partial-write recovery and GC.

## Active connections

A joined or resumed MCP connection is bound to that participant's inbox URI:

```text
git-relay://inbox/<public-session-key>
```

The server pushes automatic reports via `notifications/message` and announces
`notifications/resources/updated`. Message notifications use the SDK's logging
compatibility surface, deprecated in the 2026 MCP revision; resource reads are
the non-logging path. The bound resource returns at most eight unacknowledged
automatic notices. Another connection cannot read it merely by knowing its URI.
Manual/file-scoped messages keep the original poll-time relevance rules.

Neither a notification nor a resource read confirms acceptance. Call
`receive_messages`, accept the complete batch, then `acknowledge_messages` with
its exact `deliveryId`, cwd, ref and private token. Notifications do not supersede
pending batches. Reconnection with the same token preserves unread notices.

Presence is separate from durable subscriptions. A connection renews a ten-second
lease, removes its own lease on graceful close, and expires after a crash.
`list_sessions.online` means an unexpired lease owned by a live process, not that
a model is thinking. Independent MCP processes each push only to their own bound
connections. Shared monitor ownership can recover a verifiably dead owner after
SIGKILL without removing live or ambiguous locks; see [maintenance](maintenance.md).

## Safety and coverage boundaries

- Git refs, objects, temporary indexes and synthetic snapshot commits are written
  only in private observer storage. Source HEADs, refs, indexes and working files
  are not synchronized. GitHub APIs are read-only; no PR/branch is created or pushed.
- Observer operations disable global/system Git configuration and hooks; fetched
  repository content is never executed as instructions or project scripts. Only
  whitelisted non-executable source Git settings are forwarded for snapshots;
  configured external filters and private info/attributes are not approximated.
- Actual merge diagnosis needs Git with `merge-tree --write-tree` support
  (Git 2.38+). Missing/unsupported history is unknown, not clean. Dirty sparse
  worktrees, skip-worktree/assume-unchanged indexes and unmerged/unreadable indexes
  are not silently approximated. Uncommitted submodule contents are unknown in
  the parent snapshot; register the child repository separately. Dirty snapshots
  requiring external clean/process filters or private Git info/attributes are
  unknown instead of silently changing normalization semantics.
- Worktree observation is not an atomic filesystem snapshot. Detected races are
  rejected; notices are advisory and actual Git changes still require fresh checks.
- Local coverage includes registered clones and discoverable local remotes, not
  every folder on disk. Separate machines require their own local deployment or
  a reachable Git remote; this is not cross-machine process discovery.
- PR APIs currently target GitHub/GitHub-compatible endpoints, not GitLab or
  Bitbucket. Network/auth/rate-limit failures remain explicit coverage errors.
- Large fork networks cost API calls, Git transfers, comparisons and disk. Report
  state is bounded by the existing 2 MiB JSON limit; exceeding it is an error, not
  permission to drop coverage. Observer Git object compaction is not automated.
- Transport push is implemented and tested. Whether Codex/another host injects a
  notification into a model or wakes an idle turn is host behavior, not a generic
  MCP guarantee. Polling remains a supported fallback.

Disable a local registration with `track_repository({enabled:false})`; other
registered members continue independently. Leave subscriptions explicitly when
finished. Disabling tracking or disconnecting does not delete unread messages.

## Reproduce acceptance

```sh
npm run check
node scripts/acceptance-live.mjs https://github.com/koriym/Koriym.Psr4List
node --experimental-strip-types scripts/acceptance-codex.mjs
node --experimental-strip-types scripts/diagnose-real.mjs --verify-fixes
```

The live script requires authenticated `gh`, network access and an accessible
open PR with a regular changed file. It makes read-only remote calls, creates a
conflicting edit only in a disposable local checkout, and checks automatic MCP
push, resource updates, ACK and preservation of local refs/index/work. A closed
or changed fixture PR can require choosing another small source with an open PR.

The native script requires logged-in Codex and runs a real model turn. Tracking
is explicitly enabled by the operator before the model joins (avoiding host
approval-policy ambiguity); the MCP state directory is passed explicitly through
server env. This acceptance establishes model/tool consumption and explicit ACK,
not idle-model wake-up. No production workspace or remote branch is modified.
