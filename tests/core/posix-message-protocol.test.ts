import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { consumeChanges, consumeMailbox } from "../../src/core/consumer.ts";
import { collectGarbage } from "../../src/core/cleanup.ts";
import {
  eventsIn,
  publishUpstream,
  registerSession,
  sendMessage,
  sessionKey,
  validateEvent,
} from "../../src/core/mailbox.ts";
import { joinSession } from "../../src/core/sessions.ts";
import { hash, repository, withLock } from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";

test(
  "capability checks include separate instances and refs of the sender",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const sender = { cwd: f.b, ref, adapter: "test", session: "shared", instance: hash("one") };
    const other = { ...sender, instance: hash("two"), async deliver() {} };
    const otherRef = { ...sender, ref: "refs/heads/other", async deliver() {} };
    git(f.b, "branch", "other");
    await joinSession(sender);
    await joinSession(other);
    await assert.rejects(
      sendMessage({ ...sender, text: "message", files: ["\\notes"] }),
      /all recipients.*compatible POSIX receiver/,
    );
    await consumeMailbox(other);
    const repo = await repository(f.b);
    const event = await sendMessage({ ...sender, text: "message", files: ["\\notes"] });
    assert.deepEqual(event.recipients, [sessionKey(repo, other, ref)]);
    // A second ref remains an independent target, even with the same instance.
    await joinSession(otherRef);
    await assert.rejects(
      sendMessage({ ...sender, text: "message", files: ["\\notes"] }),
      /all recipients.*compatible POSIX receiver/,
    );
  },
);

test("capability registration uses the captured consumer mode", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const options = { cwd: f.b, ref, adapter: "test", session: "upstream", upstreamOnly: true, async deliver() {} };
  const pending = consumeMailbox(options);
  options.upstreamOnly = false;
  await pending;
  await assert.rejects(
    sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "message", files: ["\\notes"] }),
    /all recipients.*compatible POSIX receiver/,
  );
});

test(
  "a Windows join clears an earlier POSIX receiver capability",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
    await consumeMailbox(receiver);
    const moduleUrl = new URL("../../src/core/sessions.ts", import.meta.url).href;
    const script = `
    const { joinSession } = await import(${JSON.stringify(moduleUrl)});
    Object.defineProperty(process, "platform", { value: "win32" });
    await joinSession({ cwd: process.argv[1], ref: "refs/heads/main", adapter: "test", session: "receiver" });
  `;
    await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, f.b],
      { env: process.env, timeout: 20000 },
    );
    await assert.rejects(
      sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "message", files: ["\\notes"] }),
      /all recipients.*compatible POSIX receiver/,
    );
  },
);

test(
  "upstream-only consumers cannot claim POSIX message capability",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref, adapter: "test", session: "upstream", async deliver() {} };
    const message = { cwd: f.a, adapter: "test", session: "sender", text: "message", files: ["\\notes"] };
    await consumeChanges(receiver);
    await assert.rejects(sendMessage(message), /all recipients.*compatible POSIX receiver/);
    await consumeMailbox(receiver);
    assert.equal((await sendMessage(message)).pathFormat, "posix-v1");
    await consumeChanges(receiver);
    await assert.rejects(sendMessage(message), /all recipients.*compatible POSIX receiver/);
  },
);

test("join alone does not claim receiver capability", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
  await joinSession(receiver);
  const legacy = await sendMessage({
    cwd: f.a,
    adapter: "test",
    session: "sender",
    text: "message",
    files: ["dir\\file"],
  });
  assert.equal(legacy.pathFormat, undefined);
  await assert.rejects(
    sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "message", files: ["\\notes"] }),
    /all recipients.*compatible POSIX receiver/,
  );
  await consumeMailbox(receiver);
  assert.equal(
    (await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "message", files: ["\\notes"] }))
      .pathFormat,
    "posix-v1",
  );
});

test(
  "POSIX filenames survive delivery, downgrade, and garbage collection",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const files = ["\\notes.txt", "C:notes.txt", "dir\\..\\inside.txt"];
    for (const file of files) await writeFile(join(f.b, file), "local");
    const receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
    await consumeMailbox(receiver);
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "POSIX", files });
    assert.deepEqual(event.files, files);
    assert.equal(event.pathFormat, "posix-v1");
    const path = join(repo.directory, "events", `${event.id}.posix.json`);
    assert.ok(await readFile(path));
    assert.ok(
      !(await readdir(join(repo.directory, "events")))
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .includes(`${event.id}.json`),
    );
    const pending = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
    assert.ok(pending.kept.some((item) => item.id === event.id && item.reason === "unconfirmed"));
    const sessionPath = join(repo.directory, "sessions", `${key}.json`);
    const saved = JSON.parse(await readFile(sessionPath, "utf8"));
    delete saved.posixPaths;
    await writeFile(sessionPath, JSON.stringify(saved)); // An older receiver overwrites its session registration.
    assert.ok(await readFile(path));
    const delivered = await consumeMailbox(receiver);
    assert.equal(delivered[0]?.event.id, event.id);
    assert.deepEqual(delivered[0]?.event.kind === "message" && delivered[0].event.files, files);
    await rename(path, join(repo.directory, "trash", `${event.id}.posix.json`));
    const collected = await collectGarbage(f.b, { apply: true, retentionDays: 0 });
    assert.ok(collected.removed.includes(event.id));
    assert.ok(!(await readdir(join(repo.directory, "events"))).includes(`${event.id}.posix.json`));
    assert.ok(!(await readdir(join(repo.directory, "trash"))).includes(`${event.id}.posix.json`));
  },
);

test(
  "non-capable recipients reject POSIX messages before publication",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      receiver = { cwd: f.b, ref, adapter: "test", session: "old", async deliver() {} };
    await consumeMailbox(receiver);
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const path = join(repo.directory, "sessions", `${key}.json`);
    const old = JSON.parse(await readFile(path, "utf8"));
    delete old.posixPaths;
    await writeFile(path, JSON.stringify(old));
    await withLock(join(repo.directory, "publish.lock"), () => registerSession(repo, receiver, ref));
    assert.equal(JSON.parse(await readFile(path, "utf8")).posixPaths, undefined);
    const before = await readdir(join(repo.directory, "events"));
    await assert.rejects(
      sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "test", files: ["\\notes"] }),
      /all recipients.*compatible POSIX receiver/,
    );
    assert.deepEqual(await readdir(join(repo.directory, "events")), before);
    await assert.rejects(
      sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "test", files: ["../outside"] }),
      /repository-relative/,
    );
  },
);

test(
  "duplicate event IDs are rejected before a receipt can hide a format",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
    await consumeMailbox(receiver);
    const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "test", files: ["\\notes"] });
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const posixPath = join(repo.directory, "events", `${event.id}.posix.json`);
    await writeFile(
      join(repo.directory, "receipts", key, `${event.id}.json`),
      JSON.stringify({ eventId: event.id, status: "delivered", at: new Date().toISOString() }),
    );
    await writeFile(join(repo.directory, "events", `${event.id}.json`), "{}");
    await assert.rejects(eventsIn(repo, key), /Duplicate event/);
    await assert.rejects(collectGarbage(f.b, { apply: true, retentionDays: 0 }), /Duplicate event/);
    await rename(join(repo.directory, "events", `${event.id}.json`), join(repo.directory, "trash", `${event.id}.json`));
    await assert.rejects(eventsIn(repo, key), /Duplicate event/);
    assert.ok(await readFile(posixPath));
  },
);

test("POSIX event parsing keeps literal backslashes and rejects traversal", () => {
  const id = "a".repeat(64);
  const event = {
    id,
    kind: "message",
    createdAt: new Date().toISOString(),
    sender: { root: "/r", adapter: "test", session: "s" },
    recipients: [],
    text: "message",
    files: ["dir\\..\\inside"],
    pathFormat: "posix-v1",
  };
  assert.deepEqual((validateEvent(event, id, true) as typeof event).files, event.files);
  assert.throws(() => validateEvent({ ...event, files: ["../outside"] }, id, true), /repository-relative/);
  assert.throws(() => validateEvent(event, id), /path format/);
});

test("upstream publication cannot create another format for an existing ID", async (t) => {
  const f = await fixture(t),
    repo = await repository(f.b);
  const id = hash(["upstream", ref, f.initial, f.initial, ""]);
  const path = join(repo.directory, "events", `${id}.posix.json`);
  await writeFile(path, "preserve");
  await assert.rejects(
    publishUpstream(repo, { adapter: "test", session: "s" }, ref, f.initial, f.initial, []),
    /conflicts with POSIX message/,
  );
  assert.equal(await readFile(path, "utf8"), "preserve");
});

test(
  "a Windows receiver preserves an addressed POSIX event without acknowledging it",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
    await consumeMailbox(receiver);
    const event = await sendMessage({
      cwd: f.a,
      adapter: "test",
      session: "sender",
      text: "message",
      files: ["\\notes"],
    });
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const moduleUrl = new URL("../../src/core/consumer.ts", import.meta.url).href;
    const script = `
    import assert from "node:assert/strict";
    const { consumeMailbox } = await import(${JSON.stringify(moduleUrl)});
    Object.defineProperty(process, "platform", { value: "win32" });
    await assert.rejects(consumeMailbox({ cwd: process.argv[1], ref: "refs/heads/main", adapter: "test", session: "receiver", async deliver() {} }), /requires a POSIX receiver/);
  `;
    await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, f.b],
      { env: process.env, timeout: 20000 },
    );
    await assert.rejects(readFile(join(repo.directory, "receipts", key, `${event.id}.json`)), { code: "ENOENT" });
    assert.ok(await readFile(join(repo.directory, "events", `${event.id}.posix.json`)));
  },
);

test(
  "a GC rename between directory scans is not mistaken for a duplicate",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref, adapter: "test", session: "receiver", async deliver() {} };
    await consumeMailbox(receiver);
    const event = await sendMessage({
      cwd: f.a,
      adapter: "test",
      session: "sender",
      text: "message",
      files: ["\\notes"],
    });
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const moduleUrl = new URL("../../src/core/mailbox.ts", import.meta.url).href;
    const script = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const repo = JSON.parse(process.argv[1]), id = process.argv[2], key = process.argv[3];
    const original = fs.readdir;
    fs.readdir = async (path, ...args) => {
      const result = await original(path, ...args);
      if (path === join(repo.directory, "events"))
        await fs.rename(join(path, id + ".posix.json"), join(repo.directory, "trash", id + ".posix.json"));
      return result;
    };
    syncBuiltinESMExports();
    const { eventsIn } = await import(${JSON.stringify(moduleUrl)});
    await eventsIn(repo, key);
  `;
    await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, JSON.stringify(repo), event.id, key],
      { env: process.env, timeout: 20000 },
    );
    assert.ok(await readFile(join(repo.directory, "trash", `${event.id}.posix.json`)));
  },
);
