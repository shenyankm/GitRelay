import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { listSessions, readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { joinSession, leaveSession } from "../../src/core/sessions.ts";
import { hash, repository } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

test("native instances keep separate inboxes, resumes and leave state", async (t) => {
  const f = await fixture(t),
    ref = "refs/heads/main";
  const first = { cwd: f.b, ref, adapter: "opencode", session: "reused", instance: hash("first"), async deliver() {} };
  await consumeMailbox(first);
  const old = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "old private message" });
  const second = { ...first, instance: hash("second") };
  assert.deepEqual(await consumeMailbox(second), []);
  const repo = await repository(f.b),
    oldKey = sessionKey(repo, first, ref),
    newKey = sessionKey(repo, second, ref);
  assert.notEqual(oldKey, newKey);
  assert.equal(await readReceipt(repo, oldKey, old.id), undefined);
  assert.equal((await consumeMailbox(first))[0].event.id, old.id);
  await leaveSession(second);
  const next = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "only first" });
  assert.deepEqual(next.recipients, [oldKey]);
  await joinSession(second);
  assert.deepEqual(await consumeMailbox(second), []);
  assert.equal((await listSessions(f.b)).length, 2);
  assert.equal(sessionKey(repo, { adapter: "test", session: "legacy" }, ref), hash([repo.root, ref, "test", "legacy"]));
  await assert.rejects(consumeMailbox({ ...second, instance: "invalid" }), /session instance/);
});

test("a sender excludes only its own ref and instance inbox", async (t) => {
  const f = await fixture(t);
  const base = { cwd: f.b, ref: "refs/heads/main", adapter: "opencode", session: "same" };
  const sender = { ...base, instance: hash("first") };
  const instance = { ...base, instance: hash("second") };
  const otherRef = { ...sender, ref: "refs/heads/feature/a" };
  const legacy = base;
  for (const options of [sender, instance, otherRef, legacy]) await joinSession(options);
  const repo = await repository(f.b);
  const message = await sendMessage({ ...sender, text: "other inboxes" });
  assert.deepEqual(
    new Set(message.recipients),
    new Set([
      sessionKey(repo, instance, instance.ref),
      sessionKey(repo, otherRef, otherRef.ref),
      sessionKey(repo, legacy, legacy.ref),
    ]),
  );
  for (const options of [instance, otherRef, legacy]) {
    const received = await consumeMailbox({ ...options, async deliver() {} });
    assert.ok(received.some((item) => item.event.id === message.id));
  }
  assert.equal(await readReceipt(repo, sessionKey(repo, sender, sender.ref), message.id), undefined);
});
