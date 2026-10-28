import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateLegacyState } from "../../src/core/identity-migration.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sessionKey } from "../../src/core/mailbox.ts";
import {
  chooseFreshRepository,
  hash,
  recoverRepositoryInitialization,
  repository,
  stateDirectory,
  withLock,
  withRepositoryIdentity,
  writeJson,
} from "../../src/core/store.ts";
import { fixture as gitFixture } from "../helpers.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "git-relay-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = join(root, "git"),
    repos = join(root, "repos");
  await mkdir(common);
  await mkdir(repos);
  const identity = "a".repeat(64),
    newId = hash([common, identity]);
  const oldDirectory = join(repos, hash(common)),
    newDirectory = join(repos, newId);
  await mkdir(oldDirectory);
  for (const name of ["sessions", "events", "receipts", "refs", "trash"]) await mkdir(join(oldDirectory, name));
  await writeJson(join(oldDirectory, "repo.json"), { id: hash(common), common });
  const key = "b".repeat(64),
    event = "c".repeat(64),
    receiptEvent = "d".repeat(64);
  await writeJson(join(oldDirectory, "sessions", `${key}.json`), {
    key,
    adapter: "cli",
    session: "native",
    root: join(root, "worktree"),
    ref: "refs/heads/main",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    migrated: true,
  });
  await writeJson(join(oldDirectory, "events", `${event}.json`), {
    id: event,
    kind: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
    sender: { root: join(root, "worktree"), adapter: "cli", session: "sender" },
    recipients: [key],
    text: "unread",
    files: [],
  });
  await mkdir(join(oldDirectory, "receipts", key));
  await writeJson(join(oldDirectory, "receipts", key, `${receiptEvent}.json`), {
    eventId: receiptEvent,
    status: "delivered",
    at: "2026-01-01T00:00:00.000Z",
  });
  await writeJson(join(oldDirectory, "refs", `${"e".repeat(64)}.json`), {
    ref: "refs/heads/main",
    commit: "f".repeat(40),
  });
  const options = { common, oldDirectory, newDirectory, newId, identity, identitySource: "marker" as const };
  return { ...options, options, key, event, receiptEvent, root };
}

test("explicit migration preserves old unread events, receipts and metadata", async (t) => {
  const f = await fixture(t);
  const oldEvent = await readFile(join(f.oldDirectory, "events", `${f.event}.json`));
  const oldReceipt = await readFile(join(f.oldDirectory, "receipts", f.key, `${f.receiptEvent}.json`));
  const oldMetadata = await readFile(join(f.oldDirectory, "repo.json"));
  assert.deepEqual(await migrateLegacyState(f.options), { source: f.oldDirectory, target: f.newDirectory });
  assert.deepEqual(await readFile(join(f.newDirectory, "events", `${f.event}.json`)), oldEvent);
  assert.deepEqual(await readFile(join(f.newDirectory, "receipts", f.key, `${f.receiptEvent}.json`)), oldReceipt);
  assert.deepEqual(await readFile(join(f.oldDirectory, "repo.json")), oldMetadata);
  assert.deepEqual(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)), oldEvent);
  assert.deepEqual(JSON.parse(await readFile(join(f.newDirectory, "identity-owner.json"), "utf8")), { id: f.newId });
  assert.deepEqual(JSON.parse(await readFile(join(f.newDirectory, "identity-ready.json"), "utf8")), { id: f.newId });
  assert.deepEqual(JSON.parse(await readFile(join(f.newDirectory, "repo.json"), "utf8")), {
    id: f.newId,
    common: f.common,
    identity: f.identity,
    identitySource: "marker",
  });
  assert.deepEqual(await migrateLegacyState(f.options), {
    source: f.oldDirectory,
    target: f.newDirectory,
    alreadyMigrated: true,
  });
  assert.deepEqual(await readFile(join(f.newDirectory, "events", `${f.event}.json`)), oldEvent);
});

test("migration preserves POSIX format events and rejects duplicate IDs", async (t) => {
  const f = await fixture(t),
    id = "a".repeat(64);
  const event = {
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
    sender: { root: f.root, adapter: "test", session: "sender" },
    recipients: [f.key],
    text: "message",
    files: ["\\notes"],
    pathFormat: "posix-v1",
  };
  await writeJson(join(f.oldDirectory, "events", `${id}.posix.json`), event);
  await writeJson(join(f.oldDirectory, "trash", `${id}.json`), { ...event, pathFormat: undefined, files: ["notes"] });
  await assert.rejects(migrateLegacyState(f.options), /Duplicate legacy event/);
  await rm(join(f.oldDirectory, "trash", `${id}.json`));
  await migrateLegacyState(f.options);
  assert.deepEqual(JSON.parse(await readFile(join(f.newDirectory, "events", `${id}.posix.json`), "utf8")), event);
});

test("missing legacy metadata reports an actionable error and leaves fresh state available", async (t) => {
  const f = await gitFixture(t);
  const repo = await withRepositoryIdentity(f.b, undefined, async (value) => value);
  const oldDirectory = join(stateDirectory(), "repos", hash(repo.common));
  await mkdir(oldDirectory, { recursive: true });
  for (const folder of ["sessions", "events", "receipts", "refs", "trash"]) await mkdir(join(oldDirectory, folder));
  await assert.rejects(
    withRepositoryIdentity(f.b, undefined, (current) =>
      migrateLegacyState({
        common: current.common,
        oldDirectory,
        newDirectory: current.directory,
        newId: current.id,
        identity: current.identity,
        identitySource: current.identitySource,
      }),
    ),
    /Legacy repository metadata is missing.*identity-fresh/,
  );
  assert.equal((await chooseFreshRepository(f.b)).id, repo.id);
  assert.deepEqual((await readdir(oldDirectory)).sort(), ["events", "receipts", "refs", "sessions", "trash"]);
});

test("migration refuses an active old consumer and leaves source and target intact", async (t) => {
  const f = await fixture(t);
  await withLock(join(f.oldDirectory, "sessions", `${f.key}.lock`), async () => {
    await assert.rejects(migrateLegacyState(f.options), /Unexpected legacy sessions entry|busy/i);
  });
  await assert.rejects(readdir(f.newDirectory), { code: "ENOENT" });
  assert.ok(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)));
});

test(
  "migration refuses symlinks and existing targets without modifying either",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const source = join(f.oldDirectory, "events", `${f.event}.json`),
      outside = join(f.root, "outside");
    await writeFile(outside, "sentinel");
    await rm(source);
    await symlink(outside, source);
    await assert.rejects(migrateLegacyState(f.options));
    assert.equal(await readFile(outside, "utf8"), "sentinel");
    await assert.rejects(readdir(f.newDirectory), { code: "ENOENT" });
    await rm(source);
    await writeFile(source, "{}");
    await mkdir(f.newDirectory);
    await writeFile(join(f.newDirectory, "other"), "keep");
    await assert.rejects(migrateLegacyState(f.options));
    assert.equal(await readFile(join(f.newDirectory, "other"), "utf8"), "keep");
  },
);

test("invalid source JSON leaves incomplete destination unpublished and old bytes preserved", async (t) => {
  const f = await fixture(t),
    path = join(f.oldDirectory, "refs", `${"e".repeat(64)}.json`);
  await writeFile(path, "{bad");
  await assert.rejects(migrateLegacyState(f.options));
  assert.equal(await readFile(path, "utf8"), "{bad");
  await assert.rejects(readFile(join(f.newDirectory, "identity-ready.json")), { code: "ENOENT" });
  await writeJson(path, { ref: "refs/heads/main", commit: "f".repeat(40) });
  await migrateLegacyState(f.options);
  assert.ok(await readFile(join(f.newDirectory, "events", `${f.event}.json`)));
});

test("concurrent explicit migrations publish at most one target", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([migrateLegacyState(f.options), migrateLegacyState(f.options)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(f.newDirectory, "identity-ready.json"), "utf8")), { id: f.newId });
  assert.ok(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)));
});

test("one legacy inbox cannot be claimed again under a different identity", async (t) => {
  const f = await fixture(t);
  await migrateLegacyState(f.options);
  const identity = "f".repeat(64),
    newId = hash([f.common, identity]);
  const other = { ...f.options, identity, newId, newDirectory: join(f.root, "repos", newId) };
  await assert.rejects(migrateLegacyState(other), /already claimed by another identity/);
  await assert.rejects(readdir(other.newDirectory), { code: "ENOENT" });
  assert.ok(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)));
  assert.ok(await readFile(join(f.newDirectory, "events", `${f.event}.json`)));
});

test("a missing or incomplete claimed target is never replayed automatically", async (t) => {
  const f = await fixture(t);
  await migrateLegacyState(f.options);
  const moved = join(f.root, "inspect-target");
  await rename(f.newDirectory, moved);
  await assert.rejects(migrateLegacyState(f.options), /Completed migration target is missing or changed/);
  await assert.rejects(readdir(f.newDirectory), { code: "ENOENT" });
  await rename(moved, f.newDirectory);
  await rm(join(f.newDirectory, "identity-ready.json"));
  await assert.rejects(migrateLegacyState(f.options), /Completed migration target is missing or changed/);
  assert.ok(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)));
  assert.ok(await readFile(join(f.newDirectory, "events", `${f.event}.json`)));
});

test("an interrupted claim resumes partial copying without replacing data", async (t) => {
  const f = await fixture(t),
    claims = join(f.root, "identity-migration-claims");
  await mkdir(claims);
  await writeJson(join(claims, `${hash(f.common)}.json`), { common: f.common, newId: f.newId });
  await mkdir(f.newDirectory);
  await writeJson(join(f.newDirectory, "identity-owner.json"), { id: f.newId });
  await mkdir(join(f.newDirectory, "events"));
  const event = await readFile(join(f.oldDirectory, "events", `${f.event}.json`));
  await writeFile(join(f.newDirectory, "events", `${f.event}.json`), event);
  await migrateLegacyState(f.options);
  assert.deepEqual(await readFile(join(f.newDirectory, "events", `${f.event}.json`)), event);
  assert.deepEqual(JSON.parse(await readFile(join(claims, `${hash(f.common)}.completed.json`), "utf8")), {
    common: f.common,
    newId: f.newId,
  });
});

test("a claim left before target creation can resume; a ready non-migration target cannot", async (t) => {
  const f = await fixture(t),
    claims = join(f.root, "identity-migration-claims");
  await mkdir(claims);
  await writeJson(join(claims, `${hash(f.common)}.json`), { common: f.common, newId: f.newId });
  await mkdir(f.newDirectory);
  await writeJson(join(f.newDirectory, "identity-owner.json"), { id: f.newId });
  await writeJson(join(f.newDirectory, "identity-ready.json"), { id: f.newId });
  await writeJson(join(f.newDirectory, "repo.json"), {
    id: f.newId,
    common: f.common,
    identity: f.identity,
    identitySource: f.identitySource,
  });
  await assert.rejects(migrateLegacyState(f.options), /not a migration target/);
  assert.ok(await readFile(join(f.newDirectory, "identity-ready.json")));
  // Simulate an interruption immediately after claiming and before creating the target.
  const untouched = await fixture(t),
    otherClaims = join(untouched.root, "identity-migration-claims");
  await mkdir(otherClaims);
  await writeJson(join(otherClaims, `${hash(untouched.common)}.json`), {
    common: untouched.common,
    newId: untouched.newId,
  });
  await migrateLegacyState(untouched.options);
  assert.ok(await readFile(join(untouched.newDirectory, "events", `${untouched.event}.json`)));
});

test("recovery preserves conflicting partial files instead of overwriting them", async (t) => {
  const f = await fixture(t),
    claims = join(f.root, "identity-migration-claims");
  await mkdir(claims);
  await writeJson(join(claims, `${hash(f.common)}.json`), { common: f.common, newId: f.newId });
  await mkdir(f.newDirectory);
  await writeJson(join(f.newDirectory, "identity-owner.json"), { id: f.newId });
  await mkdir(join(f.newDirectory, "events"));
  const target = join(f.newDirectory, "events", `${f.event}.json`);
  await writeFile(target, '{"different":true}');
  await assert.rejects(migrateLegacyState(f.options), /conflicts with existing file/);
  assert.equal(await readFile(target, "utf8"), '{"different":true}');
  await assert.rejects(readFile(join(f.newDirectory, "identity-ready.json")), { code: "ENOENT" });
});

test("cross-filesystem publication reports the limit and preserves partial state", async (t) => {
  const f = await fixture(t),
    original = fs.link;
  fs.link = async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).startsWith(f.newDirectory))
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      migrateLegacyState(f.options),
      /Migration state directories must be on the same filesystem; incomplete state preserved/,
    );
    assert.ok(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)));
    assert.deepEqual(await readdir(f.newDirectory), []);
  } finally {
    fs.link = original;
    syncBuiltinESMExports();
  }
  await migrateLegacyState(f.options);
  assert.ok(await readFile(join(f.newDirectory, "events", `${f.event}.json`)));
});

test("synthetic interruptions before ready or completion resume the same unconsumed copy", async (t) => {
  for (const phase of ["publishing", "ready"] as const) {
    const f = await fixture(t),
      claims = join(f.root, "identity-migration-claims");
    await migrateLegacyState(f.options);
    // These manually constructed states model an interruption; they do not claim a SIGKILL test.
    await rename(join(claims, `${hash(f.common)}.completed.json`), join(f.root, `held-${phase}-completion`));
    if (phase === "publishing") await rename(join(f.newDirectory, "identity-ready.json"), join(f.root, "held-ready"));
    await migrateLegacyState(f.options);
    assert.deepEqual(JSON.parse(await readFile(join(claims, `${hash(f.common)}.completed.json`), "utf8")), {
      common: f.common,
      newId: f.newId,
    });
    assert.ok(await readFile(join(f.newDirectory, "events", `${f.event}.json`)));
    assert.ok(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)));
  }
});

test("a nonempty incomplete target without an owner is preserved for manual inspection", async (t) => {
  const f = await fixture(t),
    claims = join(f.root, "identity-migration-claims");
  await mkdir(claims);
  await writeJson(join(claims, `${hash(f.common)}.json`), { common: f.common, newId: f.newId });
  await mkdir(f.newDirectory);
  await writeFile(join(f.newDirectory, "unknown"), "preserve");
  await assert.rejects(migrateLegacyState(f.options), /Unowned incomplete migration target/);
  assert.equal(await readFile(join(f.newDirectory, "unknown"), "utf8"), "preserve");
  assert.ok(await readFile(join(f.oldDirectory, "events", `${f.event}.json`)));
});

test("archiving an owned empty interrupted target allows a claimed migration to resume", async (t) => {
  const f = await gitFixture(t);
  const repo = await withRepositoryIdentity(f.b, undefined, async (value) => value);
  const oldDirectory = join(stateDirectory(), "repos", hash(repo.common));
  await mkdir(oldDirectory, { recursive: true });
  for (const folder of ["sessions", "events", "receipts", "refs", "trash"]) await mkdir(join(oldDirectory, folder));
  await writeJson(join(oldDirectory, "repo.json"), { id: hash(repo.common), common: repo.common });
  const id = "c".repeat(64),
    oldEvent = join(oldDirectory, "events", `${id}.json`);
  await writeJson(oldEvent, {
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
    sender: { root: f.a, adapter: "test", session: "sender" },
    recipients: [],
    text: "preserve migration event",
    files: [],
  });
  const original = await readFile(oldEvent);
  const claims = join(stateDirectory(), "identity-migration-claims");
  await mkdir(claims);
  const claim = join(claims, `${hash(repo.common)}.json`);
  const claimData = JSON.stringify({ common: repo.common, newId: repo.id });
  await writeFile(claim, claimData);
  await mkdir(repo.directory);
  await writeJson(join(repo.directory, "identity-owner.json"), { id: repo.id });
  await assert.rejects(repository(f.b), /migration is incomplete/);
  const { archived } = await recoverRepositoryInitialization(f.b);
  assert.deepEqual(await readdir(archived), ["identity-owner.json"]);
  assert.equal(await readFile(claim, "utf8"), claimData);
  await withRepositoryIdentity(f.b, undefined, (current) =>
    migrateLegacyState({
      common: current.common,
      oldDirectory,
      newDirectory: current.directory,
      newId: current.id,
      identity: current.identity,
      identitySource: current.identitySource,
    }),
  );
  assert.equal((await repository(f.b)).id, repo.id);
  assert.deepEqual(await readFile(join(repo.directory, "events", `${id}.json`)), original);
  assert.deepEqual(await readFile(oldEvent), original);
  assert.deepEqual(await readdir(archived), ["identity-owner.json"]);
});

test("a migrated native session receives unread events without replaying its receipt", async (t) => {
  const f = await gitFixture(t),
    ref = "refs/heads/main";
  const repo = await withRepositoryIdentity(f.b, undefined, async (value) => value);
  const oldDirectory = join(stateDirectory(), "repos", hash(repo.common));
  await mkdir(oldDirectory, { recursive: true });
  for (const name of ["sessions", "events", "receipts", "refs", "trash"]) await mkdir(join(oldDirectory, name));
  await writeJson(join(oldDirectory, "repo.json"), { id: hash(repo.common), common: repo.common });
  const identity = { adapter: "cli", session: "migrated-session" },
    key = sessionKey(repo, identity, ref);
  const now = "2026-01-01T00:00:00.000Z",
    unread = "a".repeat(64),
    delivered = "b".repeat(64);
  await writeJson(join(oldDirectory, "sessions", `${key}.json`), {
    ...identity,
    key,
    root: repo.root,
    ref,
    createdAt: now,
    lastSeen: now,
    migrated: true,
    baseline: f.initial,
  });
  await writeJson(join(oldDirectory, "refs", `${hash(ref)}.json`), { ref, commit: f.initial });
  await mkdir(join(oldDirectory, "receipts", key));
  for (const id of [unread, delivered])
    await writeJson(join(oldDirectory, "events", `${id}.json`), {
      id,
      kind: "message",
      createdAt: now,
      sender: { adapter: "cli", session: "sender", root: f.a },
      recipients: [key],
      text: id === unread ? "unread marker" : "already delivered",
      files: [],
    });
  await writeJson(join(oldDirectory, "receipts", key, `${delivered}.json`), {
    eventId: delivered,
    status: "delivered",
    at: now,
  });
  await withRepositoryIdentity(f.b, undefined, (current) =>
    migrateLegacyState({
      common: current.common,
      oldDirectory,
      newDirectory: current.directory,
      newId: current.id,
      identity: current.identity,
      identitySource: current.identitySource,
    }),
  );
  const batches: string[] = [];
  const receiver = {
    ...identity,
    cwd: f.b,
    ref,
    async deliver(items: Awaited<ReturnType<typeof consumeMailbox>>) {
      batches.push(...items.map((item) => item.event.id));
    },
  };
  const completed = join(stateDirectory(), "identity-migration-claims", `${hash(repo.common)}.completed.json`),
    held = join(f.root, "held-completion.json");
  await rename(completed, held);
  await assert.rejects(consumeMailbox(receiver), /migration is incomplete/);
  await assert.rejects(chooseFreshRepository(f.b), /migration is incomplete/);
  assert.deepEqual(batches, []);
  await rename(held, completed);
  await consumeMailbox(receiver);
  await consumeMailbox(receiver);
  assert.deepEqual(batches, [unread]);
  assert.ok(await readFile(join(oldDirectory, "events", `${unread}.json`)));
  await assert.rejects(readFile(join(oldDirectory, "receipts", key, `${unread}.json`)), { code: "ENOENT" });
});

test("missing legacy directories report that no path-keyed state exists", async (t) => {
  const f = await fixture(t);
  await rm(f.oldDirectory, { recursive: true });
  await assert.rejects(migrateLegacyState(f.options), /no path-keyed legacy state.*identity-fresh/i);
  await rm(join(f.root, "repos"), { recursive: true });
  await assert.rejects(migrateLegacyState(f.options), /no path-keyed legacy state.*identity-fresh/i);
});
