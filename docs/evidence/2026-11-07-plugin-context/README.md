# Plugin context measurements — 2026-11-07

Current uncommitted gitbeacon plugin, Codex CLI 0.167.0, gpt-6.1-sol, local macOS.
No production plugin code was changed. `summary.json` records source fingerprints,
provider-reported usage and component estimates. Temporary authentication and
Codex configuration were isolated from the normal user configuration.

## Initial request: real provider token counts

The same prompt (`Do not call tools or inspect files. Reply exactly OK.`) was run
without tools twice per arm, in forward then reverse order. Every result was OK.
The common host base (including unrelated built-in instructions) was retained.
Both samples for every arm agreed exactly:

| Configuration | Input tokens | Increment vs off |
| --- | ---: | ---: |
| Plugin off | 18,120 | 0 |
| MCP only | 18,158 | 38 |
| Skills + MCP, hooks disabled | 18,352 | 232 |
| Full plugin, hooks normally trusted | 18,422 | 302 |

Thus skill catalog/path metadata contributed 194 tokens, and the two startup/turn
hooks together contributed 70 with host framing. These figures are not the model
context capacity or the plugin's cost after it starts working. Cached input is
included in these counts: caching does not remove resident context.

Each arm was switched by rewriting only the isolated host's config file.
`codex debug prompt-input` assertions verified the absence/presence of the skill
catalog and MCP inventory, and confirmed that all 16 schemas were not exposed in
the initial additional-tools list. The debug command does not execute hooks;
actual model usage established the 70-token hook contribution.

An initial CLI-override experiment was rejected: its nominal off arm still
contained plugin metadata and the MCP inventory. Its samples and exclusion reason
are retained separately in the summary, not included in the table above.

## Components: o200k_base estimates

These estimates count source text or compact structured JSON, excluding host
framing. They are not a declared tokenizer contract for every model:

| Component | Estimated tokens |
| --- | ---: |
| Setup skill, loaded in full | 475 |
| Coordination skill, loaded in full | 749 |
| MCP server instructions, full text | 372 |
| All 16 MCP tool definitions, SDK representation | 2,280 |
| SessionStart reminder text | 31 |
| UserPromptSubmit reminder text | 31 |
| Empty receive_messages body | 9 |

Skill bodies and tool definitions should not be added to the initial-request
increment: bodies are loaded when used, and this host defers tool discovery.
Other hosts can expose more metadata up front.

## Working context and output growth

Disposable Git fixtures used broadcast notices of roughly 100 ASCII characters,
0/8/100 retained messages, and a separate 60,000-character notice. SDK structured
results were tokenized without duplicating their content/text envelope:

| Structured result | Estimated tokens |
| --- | ---: |
| repository_status, no history | 775 |
| repository_status, 8 events | 2,633 |
| repository_status, 100 events | 23,956 |
| receive_messages, 8 short notices | 1,540 |
| receive_messages, one 60K-character notice | 15,531 |
| repository_status, 100 events including that large notice | 39,519 |

The consumer already bounds non-first batch entries by eight notices / roughly
64K JavaScript characters. That is not a token budget, and a single large notice
can still be substantial. repository_status includes up to 100 retained event
bodies and their delivery details without an aggregate output budget.

Two further real model turns called repository_status once. With no history,
the last model request had 19,560 input tokens; with 100 short events it had
33,621. Both initial requests had 17,800 tokens. These are per-request values
from native rollout `last_token_usage`, not cumulative turn totals. The large
result was truncated by the host; raw SDK payload size is therefore not the
same as resident model context. Truncation must not be interpreted as complete
message acceptance.

## Validated code-mode projection

A controlled eight-event fixture was queried in two real model turns. Printing
the complete MCP result envelope produced two copies of the status body;
printing only its structuredContent produced one:

| Forwarding | Tool text tokens (estimate) | Last request input (provider) |
| --- | ---: | ---: |
| text(result) | 5,396 | 23,338 |
| text(result.structuredContent) | 2,654 | 20,591 |

Neither output was truncated. Tool text fell by 2,742 tokens (50.8%). The provider
request comparison includes small differences in the user instruction and model
call text. In an implementation, use `structuredContent ?? result` so errors
without structured content remain visible. Keep the server's text content for
other MCP clients; the duplication here came from code-mode forwarding.

## Recommendations, in order

1. Keep routine status checks small: return state/counts by default and load
   retained history explicitly. A local projection omitting only the `events`
   list reduced the 100-event structured sample from 23,956 to 772 tokens
   (96.8%). This projection was measured locally, not implemented or accepted as
   a new API. Preserve history access and make omission explicit.
2. In code-mode guidance, forward structuredContent once rather than the entire
   envelope. The real eight-event comparison above validates this saving.
3. Give large message/detail flows an explicit aggregate output budget and an
   on-demand detail path. Do not simply truncate a batch and ACK unseen content.
4. Shortening the two skill descriptions in a local catalog projection saved
   only 38 tokens. Current 31-token reminders and 475/749-token skill bodies are
   small; do not add a throttle database or remove authorization/recovery rules
   to optimize these few tokens.

The 12 accepted native turns (16 provider requests) here measure a bounded fixture, not a
production conversation distribution, every host, or long-session compaction.
Earlier native acceptance totals of hundreds of thousands of input tokens sum
multiple model requests; they are not one resident plugin context size.
