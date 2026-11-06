import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { readReceipt, sendMessage, sessionKey, sessionsIn } from "../../src/core/mailbox.ts";
import { acknowledgeMessages, mcpIdentity, newSessionToken, receiveMessages } from "../../src/core/mcp-mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { enableSession } from "../../src/core/session-lifecycle.ts";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";
async function enroll(cwd: string) {
  const sessionToken = newSessionToken();
  await enableSession({ cwd, ref, ...mcpIdentity(sessionToken) });
  return { cwd, ref, sessionToken };
}

test("MCP receive survives retry without receipts; explicit acknowledgement is idempotent even after GC", async (t) => {
  const f = await fixture(t);
  const receiver = await enroll(f.b);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "unread" });
  const repo = await repository(f.b);
  const key = sessionKey(repo, mcpIdentity(receiver.sessionToken), ref);
  const first = await receiveMessages(receiver);
  assert.equal(first.notifications[0].event.id, event.id);
  assert.equal(await readReceipt(repo, key, event.id), undefined);
  const preview = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
  assert.ok(preview.kept.some((item) => item.id === event.id && item.reason === "unconfirmed"));
  const again = await receiveMessages(receiver);
  assert.equal(again.deliveryId, first.deliveryId);
  const ack = { ...receiver, deliveryId: first.deliveryId! };
  assert.deepEqual(await acknowledgeMessages(ack), { acknowledged: [event.id], alreadyAcknowledged: false });
  assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
  assert.equal((await acknowledgeMessages(ack)).alreadyAcknowledged, true);
  assert.deepEqual(await receiveMessages(receiver), { notifications: [], deliveryId: null });
  assert.ok((await collectGarbage(f.b, { apply: true, retentionDays: 0 })).removed.includes(event.id));
  assert.equal((await acknowledgeMessages(ack)).alreadyAcknowledged, true);
});

test("a newer bounded delivery supersedes an older acknowledgement without losing unread events", async (t) => {
  const f = await fixture(t);
  const receiver = await enroll(f.b);
  for (let index = 0; index < 10; index++)
    await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: `message ${index}` });
  const first = await receiveMessages(receiver);
  const second = await receiveMessages(receiver);
  assert.equal(first.notifications.length, 8);
  assert.equal(second.notifications.length, 8);
  assert.notEqual(first.deliveryId, second.deliveryId);
  await assert.rejects(acknowledgeMessages({ ...receiver, deliveryId: first.deliveryId! }), /superseded/);
  await acknowledgeMessages({ ...receiver, deliveryId: second.deliveryId! });
  const rest = await receiveMessages(receiver);
  assert.equal(rest.notifications.length, 2);
  assert.equal(new Set([...second.notifications, ...rest.notifications].map((item) => item.event.id)).size, 10);
});

test("corrupt pending deliveries are rejected and preserved by both receive and acknowledgement", async (t) => {
  const f = await fixture(t);
  const receiver = await enroll(f.b);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "preserve me" });
  const batch = await receiveMessages(receiver);
  const repo = await repository(f.b);
  const key = sessionKey(repo, mcpIdentity(receiver.sessionToken), ref);
  const path = join(repo.directory, "receipts", key, "mcp-delivery.json");
  const damaged = JSON.stringify({ version: 1, key, id: batch.deliveryId, eventIds: ["x"], phase: "pending" });
  await writeFile(path, damaged);
  await assert.rejects(receiveMessages(receiver), /Invalid MCP delivery/);
  await assert.rejects(acknowledgeMessages({ ...receiver, deliveryId: batch.deliveryId! }), /Invalid MCP delivery/);
  assert.equal(await readFile(path, "utf8"), damaged);
  assert.equal(await readReceipt(repo, key, event.id), undefined);
});

test("partial acknowledgement can retry without double delivery or discarding pending state", async (t) => {
  const f = await fixture(t);
  const receiver = await enroll(f.b);
  for (let index = 0; index < 2; index++)
    await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: `message ${index}` });
  const batch = await receiveMessages(receiver);
  const repo = await repository(f.b);
  const key = sessionKey(repo, mcpIdentity(receiver.sessionToken), ref);
  const failed = join(repo.directory, "receipts", key, `${batch.notifications[1].event.id}.json`);
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === failed) throw Object.assign(new Error("injected disk failure"), { code: "ENOSPC" });
    return original(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(acknowledgeMessages({ ...receiver, deliveryId: batch.deliveryId! }), /injected disk failure/);
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
  assert.equal((await readReceipt(repo, key, batch.notifications[0].event.id))?.status, "delivered");
  assert.equal(await readReceipt(repo, key, batch.notifications[1].event.id), undefined);
  const cleanup = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
  assert.ok(cleanup.removed.includes(batch.notifications[0].event.id));
  const result = await acknowledgeMessages({ ...receiver, deliveryId: batch.deliveryId! });
  assert.equal(result.acknowledged.length, 2);
  assert.deepEqual((await receiveMessages(receiver)).notifications, []);
});

test("public IDs and another private handle cannot consume or acknowledge an existing subscription", async (t) => {
  const f = await fixture(t);
  const receiver = await enroll(f.b);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "private inbox" });
  const batch = await receiveMessages(receiver);
  const repo = await repository(f.b);
  for (const sessionToken of [newSessionToken(), mcpIdentity(receiver.sessionToken).session]) {
    await assert.rejects(receiveMessages({ ...receiver, sessionToken }), /closed or missing/);
    await assert.rejects(acknowledgeMessages({ ...receiver, sessionToken, deliveryId: batch.deliveryId! }));
  }
  assert.equal((await sessionsIn(repo)).length, 1);
  assert.equal(await readReceipt(repo, sessionKey(repo, mcpIdentity(receiver.sessionToken), ref), event.id), undefined);
});
