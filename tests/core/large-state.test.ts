import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import {
  eventsIn,
  publishUpstream,
  readReceipt,
  sendMessage,
  sessionKey,
  type UpstreamEvent,
} from "../../src/core/mailbox.ts";
import { readRef, synchronizeRef } from "../../src/core/publisher.ts";
import { hash, readJson, withLock, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

const limit = 2 * 1024 * 1024;
const ref = "refs/heads/main";

test("JSON writes honor the reader's exact UTF-8 byte limit without replacing old state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gitbeacon-json-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const exact = "🚀" + "x".repeat(limit - 6); // Quotes plus four UTF-8 bytes.
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), limit);
  await writeJson(path, exact);
  assert.equal(await readJson(path), exact);
  await assert.rejects(writeJson(path, exact + "x"), /State file exceeds 2 MiB/);
  assert.equal(await readJson(path), exact);
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("oversized broadcast fails before publication and preserves the existing inbox", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const key = sessionKey(repo, receiver, ref);
  const existing = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "unread" });
  const createdAt = new Date().toISOString();
  const dir = join(repo.directory, "sessions");
  for (let i = 0; i < 32_000; i++) {
    const session = `recipient-${i}`;
    const identity = { adapter: "test", session };
    const id = sessionKey(repo, identity, ref);
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        ...identity,
        key: id,
        root: repo.root,
        ref,
        createdAt,
        lastSeen: createdAt,
        baseline: f.initial,
      }),
    );
  }
  await assert.rejects(
    sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "too many recipients" }),
    /State file exceeds 2 MiB/,
  );
  assert.deepEqual(
    (await eventsIn(repo)).map((event) => event.id),
    [existing.id],
  );
  assert.equal(await readReceipt(repo, key, existing.id), undefined);
  assert.deepEqual((await readdir(join(repo.directory, "events"))).sort(), [`${existing.id}.json`]);
});

test("oversized upstream recipient retry preserves event and ref cursor", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const key = sessionKey(repo, receiver, ref);
  const before = await readRef(repo, ref);
  const current = await f.commit(f.main, "shared.txt", "new upstream\n");
  const tooMany = Array.from({ length: 32_000 }, (_, i) => i.toString(16).padStart(64, "0"));
  const freshId = hash(["upstream", ref, f.initial, current, "fresh"]);
  await assert.rejects(
    publishUpstream(repo, receiver, ref, f.initial, current, tooMany, "fresh"),
    /State file exceeds 2 MiB/,
  );
  assert.equal(await readJson(join(repo.directory, "events", `${freshId}.json`)), undefined);
  const id = hash(["upstream", ref, f.initial, current, before?.eventId ?? ""]);
  const event: UpstreamEvent = {
    id,
    kind: "upstream",
    ref,
    previous: f.initial,
    commit: current,
    recipients: [],
    sender: { adapter: "test", session: "sender", root: f.a },
    createdAt: new Date().toISOString(),
  };
  const base = Buffer.byteLength(JSON.stringify(event));
  const count = Math.floor((limit - base + 1) / 67);
  event.recipients = Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, "0"));
  assert.ok(!event.recipients.includes(key));
  const serialized = JSON.stringify(event);
  assert.ok(Buffer.byteLength(serialized) <= limit);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...event, recipients: [...event.recipients, key] })) > limit);
  const path = join(repo.directory, "events", `${id}.json`);
  await writeFile(path, serialized);
  const priorKey = event.recipients[0];
  const priorReceipt = { eventId: id, status: "delivered", at: new Date().toISOString() };
  await mkdir(join(repo.directory, "receipts", priorKey));
  await writeJson(join(repo.directory, "receipts", priorKey, `${id}.json`), priorReceipt);
  await assert.rejects(
    withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, receiver)),
    /State file exceeds 2 MiB/,
  );
  assert.equal(await readFile(path, "utf8"), serialized);
  assert.deepEqual(await readRef(repo, ref), before);
  assert.deepEqual(await readReceipt(repo, priorKey, id), priorReceipt);
});
