import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { listSessions, sendMessage, sessionKey, sessionsIn, type Notification } from "../../src/core/mailbox.ts";
import { joinSession, leaveSession, leaveSessionIfRepository, preflightLeaveSession } from "../../src/core/sessions.ts";
import { repository, withLock, writeJson } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";

test("session scans preserve all batches, reject invalid records and refresh after removal", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f.b);
  const directory = join(repo.directory, "sessions");
  const at = new Date().toISOString();
  const expected = Array.from({ length: 67 }, (_, index) => {
    const identity = { adapter: "test", session: `session-${index}` };
    return {
      ...identity,
      key: sessionKey(repo, identity, ref),
      root: repo.root,
      ref,
      createdAt: at,
      lastSeen: at,
      migrated: true,
      ...(index % 2 ? { closedAt: at } : {}),
    };
  });
  await Promise.all(expected.map((session) => writeJson(join(directory, `${session.key}.json`), session)));
  await writeJson(join(directory, "unrelated.json"), { ignored: true });
  const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  const byKey = new Map(expected.map((session) => [session.key, session]));
  assert.deepEqual(
    await sessionsIn(repo),
    names.map((name) => byKey.get(name.slice(0, -5))),
  );
  const invalid = join(directory, names[32]);
  await writeJson(invalid, { key: names[32].slice(0, -5) });
  await assert.rejects(sessionsIn(repo), /Invalid session/);
  await rm(invalid);
  assert.equal((await sessionsIn(repo)).length, 66);
});

test("explicit leave excludes future messages but keeps the old inbox for an explicit rejoin", async (t) => {
  const f = await fixture(t);
  const received: string[] = [];
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "codex",
    session: "B",
    async deliver(batch: Notification[]) {
      received.push(...batch.map((n) => n.event.id));
    },
  };
  const sender = { cwd: f.a, adapter: "codex", session: "A" };
  await consumeMailbox(receiver);
  const pending = await sendMessage({ ...sender, text: "before leave" });
  const left = await leaveSession(receiver);
  assert.ok(left?.closedAt);
  assert.equal((await leaveSession(receiver))?.closedAt, left.closedAt);
  await consumeMailbox(receiver); // Polling must not silently re-open a closed session.
  assert.deepEqual(received, []);
  assert.equal((await sendMessage({ ...sender, text: "while closed" })).recipients.length, 0);
  assert.ok((await listSessions(f.b)).find((s) => s.session === "B")?.closedAt);
  const report = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
  assert.ok(report.kept.some((entry) => entry.id === pending.id && entry.reason === "unconfirmed"));
  await assert.rejects(sendMessage({ ...receiver, text: "cannot send while closed" }), /use join/);
  await joinSession(receiver);
  await consumeMailbox(receiver);
  assert.deepEqual(received, [pending.id]);
  const next = await sendMessage({ ...sender, text: "after rejoin" });
  await consumeMailbox(receiver);
  assert.deepEqual(received, [pending.id, next.id]);
});

test("a preflight-bound opt-out returns the closed session", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.b, ref, adapter: "test", session: "receiver" };
  const joined = await joinSession(options),
    checked = await preflightLeaveSession(options);
  const closed = await leaveSessionIfRepository(options, checked);
  assert.equal(closed?.key, joined.key);
  assert.ok(closed?.closedAt);
});

test("session identity fields must match the stored key before leave or send", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "opencode", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  const path = join(repo.directory, "sessions", `${key}.json`),
    original = await readFile(path, "utf8");
  const session = JSON.parse(original);
  for (const [field, value] of Object.entries({
    root: f.a,
    ref: "refs/heads/other",
    adapter: "other",
    session: "other",
  })) {
    const corrupt = JSON.stringify({ ...session, [field]: value });
    await writeFile(path, corrupt);
    await assert.rejects(leaveSession(receiver), /Invalid session/);
    await assert.rejects(
      sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "preserve" }),
      /Invalid session/,
    );
    assert.equal(await readFile(path, "utf8"), corrupt);
  }
  await writeFile(path, original);
  assert.ok((await leaveSession(receiver))?.closedAt);
});

test("lastSeen alone does not retire an offline session, and unknown leave does not register a ghost", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "opencode", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const session = (await listSessions(f.b))[0];
  await writeJson(join(repo.directory, "sessions", `${session.key}.json`), {
    ...session,
    lastSeen: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(
    (await sendMessage({ cwd: f.a, adapter: "cc", session: "A", text: "offline still subscribed" })).recipients.length,
    1,
  );
  assert.equal(await leaveSession({ ...receiver, session: "not-registered" }), undefined);
  assert.equal((await listSessions(f.b)).length, 1);
});

test("leave cannot race an in-flight receive and never overwrites its session lock", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "opencode", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const session = (await listSessions(f.b))[0];
  await withLock(join(repo.directory, "sessions", `${session.key}.lock`), async () => {
    await assert.rejects(leaveSession(receiver), /busy/);
    assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  });
  assert.ok((await leaveSession(receiver))?.closedAt);
});
