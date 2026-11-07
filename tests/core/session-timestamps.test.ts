import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hash } from "../../src/core/store.ts";
import { sendMessage, sessionKey, validateSession } from "../../src/core/mailbox.ts";

const ref = "refs/heads/main";
const identity = { adapter: "test", session: "receiver" };
const root = "/tmp/fixture-root";
const key = sessionKey({ root }, identity, ref);
const base = {
  ...identity,
  key,
  root,
  ref,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-01T00:00:00.000Z",
};

test("session timestamps require strings and retain parseable historical strings", () => {
  for (const field of ["createdAt", "lastSeen", "closedAt"] as const) {
    for (const bad of [0, 1, 2026, [0], ["2026-01-01"]]) {
      assert.throws(() => validateSession({ ...base, [field]: bad }, key), /Invalid session/);
    }
    assert.equal(validateSession({ ...base, [field]: "2026" }, key)[field], "2026");
  }
  assert.equal(validateSession(base, key).closedAt, undefined);
  assert.equal(
    validateSession({ ...base, closedAt: "2026-01-01T00:00:00.000Z" }, key).closedAt,
    "2026-01-01T00:00:00.000Z",
  );
});

test("malformed closedAt cannot make a closed subscription a broadcast recipient", async (t) => {
  const previousState = process.env.GITBEACON_STATE_DIR;
  const temp = await mkdtemp(join(tmpdir(), "gitbeacon-session-time-"));
  t.after(() => {
    if (previousState === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = previousState;
  });
  t.after(() => rm(temp, { recursive: true, force: true }));
  const template = join(temp, "template"),
    wt = join(temp, "worktree");
  await mkdir(template);
  execFileSync("git", ["init", "--template", template, wt], { stdio: "pipe" });
  const worktree = await realpath(wt),
    common = await realpath(join(worktree, ".git"));
  const state = join(temp, "state");
  process.env.GITBEACON_STATE_DIR = state;
  const marker = "a".repeat(64),
    id = hash([common, marker]),
    dir = join(state, "repos", id);
  await writeFile(join(common, ".gitbeacon-id"), `${marker}\n`);
  for (const name of ["sessions", "events", "receipts", "refs", "trash"])
    await mkdir(join(dir, name), { recursive: true });
  for (const name of ["identity-owner.json", "identity-ready.json"])
    await writeFile(join(dir, name), JSON.stringify({ id }));
  const key = sessionKey({ root: worktree }, identity, ref);
  const session = { ...base, root: worktree, key, closedAt: 0 };
  const path = join(dir, "sessions", `${key}.json`),
    bytes = JSON.stringify(session);
  await writeFile(path, bytes);
  await assert.rejects(
    sendMessage({ cwd: worktree, adapter: "test", session: "sender", text: "synthetic regression" }),
    /Invalid session/,
  );
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await readdir(join(dir, "events")), []);
});
