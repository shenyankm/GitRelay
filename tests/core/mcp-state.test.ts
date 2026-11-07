import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { repository } from "../../src/core/repository.ts";
import { stateDirectory } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

test("gitbeacon uses its own namespace without importing or deleting old plugin state", async (t) => {
  const f = await fixture(t);
  const saved = {
    WORKTREE_SYNC_STATE_DIR: process.env.WORKTREE_SYNC_STATE_DIR,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const oldState = join(f.root, "old-plugin-state");
  const oldMarker = join(f.main, ".git", ".git-relay-id");
  const oldIdentity = "a".repeat(64);
  await mkdir(oldState);
  await writeFile(join(oldState, "unread.json"), "preserve old unread bytes");
  await writeFile(oldMarker, `${oldIdentity}\n`);
  process.env.WORKTREE_SYNC_STATE_DIR = oldState;
  process.env.XDG_STATE_HOME = join(f.root, "xdg");
  const current = process.env.GITBEACON_STATE_DIR;
  assert.ok(current);
  delete process.env.GITBEACON_STATE_DIR;
  assert.equal(stateDirectory(), join(f.root, "xdg", "gitbeacon"));
  process.env.GITBEACON_STATE_DIR = current;
  const repo = await repository(f.b);
  assert.notEqual(repo.identity, oldIdentity);
  await access(join(f.main, ".git", ".gitbeacon-id"));
  assert.equal(await readFile(oldMarker, "utf8"), `${oldIdentity}\n`);
  assert.equal(await readFile(join(oldState, "unread.json"), "utf8"), "preserve old unread bytes");
});
