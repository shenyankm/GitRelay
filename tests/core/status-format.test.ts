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
