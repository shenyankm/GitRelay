import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sendMessage, type Notification } from "../../src/core/mailbox.ts";
import { readJson, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

test("rejected messages do not indefinitely starve later messages", async (t) => {
  const f = await fixture(t),
    attempted: string[] = [],
    ids: string[] = [];
  const receiver = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "fair",
    deliverIndividually: true,
    async deliver(batch: Notification[]) {
      attempted.push(batch[0].event.id);
      return batch[0].event.id === ids[8];
    },
  };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  for (let i = 0; i < 9; i++) {
    const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: `message-${i}` });
    const path = join(repo.directory, "events", `${event.id}.json`);
    await writeJson(path, { ...((await readJson(path)) as object), createdAt: new Date(1000 * (i + 1)).toISOString() });
    ids.push(event.id);
  }
  for (let i = 0; i < 16 && !attempted.includes(ids[8]); i++) await consumeMailbox(receiver);
  assert.ok(attempted.includes(ids[8]), "a later acceptable message was never attempted");
});

test("a rejected oversized notification does not indefinitely starve a small message", async (t) => {
  const f = await fixture(t),
    attempted: string[] = [],
    ids: string[] = [];
  const receiver = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "large",
    deliverIndividually: true,
    async deliver(batch: Notification[]) {
      attempted.push(batch[0].event.id);
      return batch[0].event.id === ids[1];
    },
  };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  for (const [i, text] of ["x".repeat(65500), "small"].entries()) {
    const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text });
    const path = join(repo.directory, "events", `${event.id}.json`);
    await writeJson(path, { ...((await readJson(path)) as object), createdAt: new Date(1000 * (i + 1)).toISOString() });
    ids.push(event.id);
  }
  for (let i = 0; i < 16 && !attempted.includes(ids[1]); i++) await consumeMailbox(receiver);
  assert.ok(attempted.includes(ids[1]), "a small message was never attempted after an oversized rejection");
});
