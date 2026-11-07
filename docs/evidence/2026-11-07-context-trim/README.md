# Context trimming acceptance — 2026-11-07

Implemented the priorities from [the context profile](../2026-11-07-plugin-context/README.md): summary-first status, single-copy code-mode forwarding, then bounded/on-demand message details. Hook reminders and skill discovery metadata were kept intact. No dependency was added.

## Behavior and measurement

- `repository_status` now defaults to `eventsIncluded:false` and an empty events array, while retaining the exact retained-event count and repository/session information. `includeEvents:true` explicitly restores up to 100 detailed events. Summary reads skip receipt enrichment.
- Both skills use `text(result.structuredContent ?? result)`: successful structured data is forwarded once; error envelopes remain visible. The earlier native comparison measured 5,396 → 2,654 estimated tokens for this forwarding change. The current native setup independently verifies that the model follows the guidance; it is not a new matched before/after provider benchmark.
- `receive_messages` uses an 8 KiB structured inline budget. Oversized batches return a small descriptor and a stable delivery ID; `read_message_details` provides sequential UTF-8 JSON text pages with at most 2 KiB of text. Large inbox resources return ID/kind previews. No truncation is presented as a complete accepted message.
- The read cursor survives retries and reconnects. Wrong/private handles, skipped offsets, corrupted snapshots and superseded deliveries fail safely. ACK is rejected until all details have been read; reads themselves never acknowledge. Existing journaled/idempotent ACK behavior remains.

`summary.json` records a matched synthetic fixture with 100 notices: explicit history is the previous behavior, compared with the new default against the same repository state. Token counts use `o200k_base` through a transient `uv --with tiktoken` environment; no tokenizer dependency was added to the project. These are raw compact structured JSON estimates, excluding host framing, not declared gpt-6.1 token counts or representative production traffic.

| Same 100-notice state | UTF-8 bytes | Estimated tokens |
| --- | ---: | ---: |
| Explicit full history | 60,374 | 23,496 |
| Default summary | 1,786 | 757 |

The default summary uses **96.78% fewer estimated tokens** in this fixture.

The final native note was **63,004 bytes**, with a **176-byte** initial descriptor.
The model exposed details in **11 groups**, with no host-truncated detail output,
reported all three markers, acknowledged the full batch and left the session.
The protocol's read cursor and delivered receipt independently confirmed completion.

This adds one MCP tool (17 total) and necessary protocol guidance: full setup and
coordination skill bodies now estimate 502 and 920 tokens, versus 475 and 749 in
the earlier profile. These are on-demand skill bodies; discovery descriptions and
hook reminders remain unchanged. The aim is reducing repeated payload volume,
not minimizing every instruction at the expense of correct delivery.

## Validation

- `npm run check`: **425/425 passed**, including formatting, strict TypeScript, core and actual stdio tests.
- An earlier full run had 424/425 pass because a resource test's explicit scan competed with the shared monitor for `coordination.lock`. The test now retries only that specific busy response (the scan did not start); other errors fail immediately. The full rerun passed. No production generic retry was added.
- The native plugin regression rerun passed ordinary-task/setup/lost-token opt-in boundaries, the MCP-selected non-main ref, automatic real-Git conflict publication, explicit ACK and leave.
- Native context acceptance used authenticated Codex CLI 0.167.0 / gpt-6.1-sol on macOS, isolated Codex configuration, normal TUI hook trust and disposable repositories/state. Setup forwarded structured output. A goal-only request read a large pending note, reported markers, explicitly acknowledged it and ended collaboration.
- Both skills passed Skill Creator's `quick_validate.py`. The rebuilt plugin's tests and final format/type checks were repeated after the final guidance adjustment.
- `node scripts/benchmark-delivery.mjs` passed six small-message send/receive/ACK cycles. Median end-to-end time excluding the first cycle was 195.18 ms; this is a local smoke benchmark, with no matched latency baseline.

The first native context case used a 16,724-byte note and passed, but inspection showed that the model combined several page results into one output. The final skill explicitly limits combined detail output to 8 KiB per code-mode call and returns to the model between groups. The final native case uses a note over 60 KB and requires incremental, non-truncated detail outputs plus markers at the beginning, middle and end. This guards against recreating host truncation through client aggregation.

One attempted larger fixture exceeded the existing 64 KiB message limit and was rejected before delivery. Its replacement remains within that limit and asserts its size; the production limit was preserved.

## Reproduce and limits

```sh
npm run build:plugin
npm run check
# Prepare an authenticated temporary gitbeacon-plugin-codex-* home under OS temp,
# install the plugin there and review hooks in the normal native trust flow.
GITBEACON_TEST_CODEX_HOME="/OS-temp/gitbeacon-plugin-codex-example" \
  node --experimental-strip-types scripts/acceptance-context.mjs
GITBEACON_TEST_CODEX_HOME="/OS-temp/gitbeacon-plugin-codex-example" \
  node --experimental-strip-types scripts/acceptance-codex.mjs --plugin
```

The scripts update registration only in the selected isolated test home and make no remote writes. Delete its test credentials and home afterwards. Saved summaries omit private tokens and raw prompts; source hashes identify the uncommitted checkout on top of the recorded commit.

Clients must support `detailsRequired` and the new detail tool for large batches; an empty notifications array with a delivery ID is a deferred batch, not an empty inbox. Small batches retain the original receive/ACK shape. Complete large-message inspection still costs the full content and additional model/tool turns: pagination limits each response and allows deferral, not total accepted-message input cost. Native usage fields are cumulative across requests, not resident context. Startup metadata and hooks were not re-benchmarked. Desktop GUI, other host/platforms, hosted CI and idle-model wake-up were not tested.
