import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBranchStatus } from "../../src/core/status-format.ts";

test("Markdown status escapes entity-like text and angle brackets", () => {
  const rendered = formatBranchStatus({
    type: "worktree.branch-status",
    worktree: { branch: "a&lt;b", commit: null, dirty: false },
    local: { ref: "refs/heads/a&lt;b", commit: null, tracking: null },
    github: { error: "A & B < C > D &amp;" },
  });
  assert.match(rendered, /\| Worktree branch \| a&amp;lt;b \|/);
  assert.match(rendered, /\| Monitored branch \| refs\/heads\/a&amp;lt;b \|/);
  assert.match(rendered, /\| GitHub \| Query failed: A &amp; B &lt; C &gt; D &amp;amp; \|/);
});

test("Markdown status strips C1 control characters", () => {
  const rendered = formatBranchStatus({
    type: "worktree.branch-status",
    worktree: { branch: "x\u009b2J", commit: null, dirty: false },
    local: { ref: "refs/heads/x\u009b2J", commit: null, tracking: null },
    github: { error: "ref \u009d0;https://example.invalid\u0007" },
  });
  for (const line of rendered.split("\n").filter((line) => line.startsWith("| ")))
    assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
  assert.match(rendered, /\| Worktree branch \| x 2J \|/);
  assert.match(rendered, /\| Monitored branch \| refs\/heads\/x 2J \|/);
});
