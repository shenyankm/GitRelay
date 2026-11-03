import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { registerSession, sessionKey, type Notification } from "../../src/core/mailbox.ts";
import { withLock, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

test("legacy migration precedes later upstream events", async (t) => {
  const f = await fixture(t),
    ref = "refs/heads/main";
  const middle = await f.commit(f.main, "shared.txt", "middle\n");
  const observer = { cwd: f.c, ref, adapter: "test", session: "observer", async deliver() {} };
  await consumeMailbox(observer);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const received: Notification[] = [];
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "legacy",
    async deliver(batch: Notification[]) {
      received.push(...batch);
    },
  };
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  await mkdir(join(repo.common, "worktree-agent-sync"));
  await writeJson(join(repo.common, "worktree-agent-sync", `${key}.json`), { root: f.b, ref, commit: f.initial });
  await withLock(join(repo.directory, "publish.lock"), () => registerSession(repo, receiver, ref));
  const last = await f.commit(f.main, "shared.txt", "last\n");
  await consumeMailbox(observer);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 10_000 });
  try {
    await consumeMailbox(receiver);
  } finally {
    t.mock.timers.reset();
  }
  const transitions = received
    .filter((notification) => notification.kind === "upstream")
    .map(({ event }) => [event.previous, event.commit]);
  assert.deepEqual(transitions, [
    [f.initial, middle],
    [middle, last],
  ]);
});
