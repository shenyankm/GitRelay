import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { readReceipt, sendMessage, sessionKey, sessionsIn } from "../../src/core/mailbox.ts";
import {
  acknowledgeMessages,
  mcpIdentity,
  newSessionToken,
  receiveMessages,
  readMessageDetails,
  MCP_INLINE_BYTES,
} from "../../src/core/mcp-mailbox.ts";
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

test("large Unicode batches page exactly, block early ACK, survive retry and reject skipped/stale/private reads", async (t) => {
  const f = await fixture(t);
  const receiver = await enroll(f.b);
  const text = '你好😀"\\'.repeat(1800);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text });
  const repo = await repository(f.b);
  const key = sessionKey(repo, mcpIdentity(receiver.sessionToken), ref);
  const batch = await receiveMessages(receiver);
  assert.equal(batch.detailsRequired, true);
  assert.deepEqual(batch.notifications, []);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) < MCP_INLINE_BYTES);
  const scope = { ...receiver, deliveryId: batch.deliveryId! };
  await assert.rejects(acknowledgeMessages(scope), /Read all/);
  await assert.rejects(readMessageDetails({ ...scope, offset: 1 }), /sequentially/);
  await assert.rejects(readMessageDetails({ ...scope, sessionToken: newSessionToken(), offset: 0 }));
  await assert.rejects(readMessageDetails({ ...scope, offset: -1 }), /nonnegative/);
  const pendingPath = join(repo.directory, "receipts", key, "mcp-delivery.json");
  const originalPending = await readFile(pendingPath, "utf8");
  const corrupt = JSON.parse(originalPending);
  corrupt.details.text += "x";
  await writeFile(pendingPath, JSON.stringify(corrupt));
  await assert.rejects(readMessageDetails({ ...scope, offset: 0 }), /Invalid MCP delivery/);
  await assert.rejects(acknowledgeMessages(scope), /Invalid MCP delivery/);
  assert.equal(await readFile(pendingPath, "utf8"), JSON.stringify(corrupt));
  await writeFile(pendingPath, originalPending);
  const first = await readMessageDetails({ ...scope, offset: 0 });
  assert.deepEqual(await readMessageDetails({ ...scope, offset: 0 }), first);
  assert.equal((await receiveMessages(receiver)).deliveryId, scope.deliveryId);
  let offset = 0,
    reconstructed = "";
  for (;;) {
    const part = await readMessageDetails({ ...scope, offset });
    assert.ok(!part.text.includes("\ufffd"));
    assert.ok(Buffer.byteLength(part.text) <= 2048);
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < MCP_INLINE_BYTES);
    reconstructed += part.text;
    offset = part.nextOffset;
    if (part.complete) break;
  }
  const notifications = JSON.parse(reconstructed);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event.text, text);
  assert.equal(await readReceipt(repo, key, event.id), undefined);
  await acknowledgeMessages(scope);
  assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
  assert.equal((await acknowledgeMessages(scope)).alreadyAcknowledged, true);
  await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "new batch" });
  await receiveMessages(receiver);
  await assert.rejects(readMessageDetails({ ...scope, offset: 0 }), /superseded/);
});

test("MCP batches respect the aggregate inline byte budget without dropping messages", async (t) => {
  const f = await fixture(t);
  const receiver = await enroll(f.b);
  const ids = new Set<string>();
  for (let n = 0; n < 12; n++)
    ids.add((await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: `${n}:` + "字".repeat(450) })).id);
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 12; attempt++) {
    const batch = await receiveMessages(receiver);
    if (!batch.deliveryId) break;
    assert.ok(!batch.detailsRequired);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= MCP_INLINE_BYTES);
    for (const notification of batch.notifications) seen.add(notification.event.id);
    await acknowledgeMessages({ ...receiver, deliveryId: batch.deliveryId });
  }
  assert.deepEqual(seen, ids);
});
