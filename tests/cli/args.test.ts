import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "../helpers.ts";

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

test("commands reject unrelated options before initializing state or starting work", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["status", "--apply"],
    ["status", "--retention-days", "not-a-number"],
    ["sessions", "--message", "ignored"],
    ["send", "--session", "s", "--message", "must not send", "--apply"],
    ["join", "--session", "s", "--file", "ignored"],
    ["install", "--session", "ignored"],
    ["watch", "--session", "s", "--interval-ms", "50"],
    ["daemon", "status", "--interval-ms", "50"],
    ["hook", "codex", "--message", "ignored"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: f.b, encoding: "utf8" });
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /is not supported by/);
  }
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
});
