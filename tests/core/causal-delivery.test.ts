import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { readReceipt, sendMessage, sessionKey, type Notification } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture, git } from "../helpers.ts";

for (const pending of [false, true])
  test("upstream order survives " + (pending ? "a host-owned pending event" : "a rejected delivery"), async (t) => {
    const f = await fixture(t),
      ref = "refs/heads/main",
      seen: Notification[] = [];
    let blocked = true,
      firstId = "";
    const receiver = {
      cwd: f.b,
      ref,
      adapter: "test",
      session: "ordered",
      deliverIndividually: true,
      isPending(id: string) {
        return pending && blocked && id === firstId;
      },
      async deliver(batch: Notification[]) {
        seen.push(...batch);
        return !(blocked && batch[0].kind === "upstream");
      },
    };
    const observer = { cwd: f.c, ref, adapter: "test", session: "observer", async deliver() {} };
    await writeFile(join(f.b, "shared.txt"), "local\n");
    await consumeMailbox(receiver);
    await f.commit(f.main, "shared.txt", "first\n");
    await consumeMailbox(observer);
    await f.commit(f.main, "shared.txt", "second\n");
    await consumeMailbox(observer);
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const { eventsIn } = await import("../../src/core/mailbox.ts");
    const upstream = (await eventsIn(repo, key)).filter((event) => event.kind === "upstream");
    firstId = upstream[0].id;
    const message = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "independent" });
    await consumeMailbox(receiver);
    assert.equal(await readReceipt(repo, key, upstream[1].id), undefined);
    assert.ok(!seen.some((item) => item.event.id === upstream[1].id));
    assert.equal((await readReceipt(repo, key, message.id))?.status, "delivered");
    seen.length = 0;
    blocked = false;
    await consumeMailbox(receiver);
    assert.deepEqual(
      seen.map((item) => item.event.id),
      upstream.map((event) => event.id),
    );
  });

test("event-chain IDs order a ref rollback without creating a commit-graph cycle", async (t) => {
  const f = await fixture(t),
    ref = "refs/heads/main",
    seen: Notification[] = [];
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "reset",
    async deliver(batch: Notification[]) {
      seen.push(...batch);
    },
  };
  const observer = { cwd: f.c, ref, adapter: "test", session: "observer", async deliver() {} };
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await consumeMailbox(receiver);
  const first = await f.commit(f.main, "shared.txt", "first\n");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  try {
    await consumeMailbox(observer);
  } finally {
    t.mock.timers.reset();
  }
  git(f.main, "reset", "--hard", f.initial);
  await consumeMailbox(observer);
  const last = await f.commit(f.main, "shared.txt", "last\n");
  await consumeMailbox(observer);
  await consumeMailbox(receiver);
  assert.deepEqual(
    seen.map((item) => (item.kind === "upstream" ? [item.event.previous, item.event.commit] : [])),
    [
      [f.initial, first],
      [first, f.initial],
      [f.initial, last],
    ],
  );
});
