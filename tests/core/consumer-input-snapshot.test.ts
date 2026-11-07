import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { registerSession, sessionKey, sessionsIn } from "../../src/core/mailbox.ts";
import { joinSession, leaveSession } from "../../src/core/sessions.ts";
import { hash, withLock } from "../../src/core/store.ts";
import { type Repository } from "../../src/core/repository.ts";

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "gitbeacon-consumer-input-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oldState = process.env.GITBEACON_STATE_DIR;
  process.env.GITBEACON_STATE_DIR = join(dir, "state");
  t.after(() => {
    if (oldState === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = oldState;
  });
  const cwd = join(dir, "repo"),
    template = join(dir, "template");
  await mkdir(template);
  execFileSync("git", ["init", "--template", template, "-b", "main", cwd], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { stdio: "pipe" },
  );
  return { dir, root: await realpath(cwd) };
}

test("consumer retains the session identity across asynchronous repository and registration work", async (t) => {
  const { dir, root } = await fixture(t);
  const options = { cwd: root, ref: "refs/heads/main", adapter: "test", session: "initial", async deliver() {} };
  const originalOpen = fs.promises.open;
  let changed = false;
  const mocked = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    if (!changed && typeof args[0] === "string" && /[\\/]sessions[\\/][a-f0-9]{64}\.json$/.test(args[0])) {
      changed = true;
      options.session = "changed-during-read";
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await consumeMailbox(options);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(changed, true);
  const repos = join(dir, "state", "repos"),
    id = (await readdir(repos)).find((name) => /^[a-f0-9]{64}$/.test(name));
  assert.ok(id);
  const directory = join(repos, id),
    sessions = await sessionsIn({ directory } as Repository);
  assert.deepEqual(
    sessions.map(({ session }) => session),
    ["initial"],
  );
  assert.equal(sessions[0].key, sessionKey({ root }, { adapter: "test", session: "initial" }, "refs/heads/main"));
});

test("registerSession snapshots repository and identity before the first read", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gitbeacon-register-input-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, "first"),
    other = join(dir, "other");
  await mkdir(join(first, "sessions"), { recursive: true });
  await mkdir(join(other, "sessions"), { recursive: true });
  const repo = { root: "/initial", directory: first } as Repository;
  const identity = { adapter: "test", session: "initial" };
  await withLock(join(first, "publish.lock"), async () => {
    const pending = registerSession(repo, identity, "refs/heads/main", "a".repeat(40));
    repo.root = "/changed";
    repo.directory = other;
    identity.session = "changed";
    const session = await pending;
    assert.equal(session.root, "/initial");
    assert.equal(session.session, "initial");
  });
  assert.equal((await sessionsIn({ directory: first } as Repository)).length, 1);
  assert.deepEqual(await readdir(join(other, "sessions")), []);
});

test("consumer keeps inherited callbacks lazy, bound to the caller, and uses the captured signal", async (t) => {
  const { root } = await fixture(t);
  const originalOpen = fs.promises.open;
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const id = "f".repeat(64),
    controller = new AbortController();
  let injected = false,
    key = "",
    directory = "",
    calls = 0,
    receiver: unknown,
    getterReceiver: unknown;
  const proto = {
    cwd: root,
    ref: "refs/heads/main",
    adapter: "test",
    session: "target",
    get deliver() {
      getterReceiver = this;
      return async function (this: unknown, notifications: unknown[]) {
        receiver = this;
        calls += notifications.length;
      };
    },
  };
  const options = Object.assign(Object.create(proto) as typeof proto, { signal: controller.signal });
  const mocked = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const path = args[0];
    if (!injected && typeof path === "string" && /[\\/]sessions[\\/][a-f0-9]{64}\.json$/.test(path)) {
      injected = true;
      key = path.slice(-69, -5);
      directory = dirname(dirname(path));
      const now = new Date().toISOString();
      await writeFile(
        path,
        JSON.stringify({
          key,
          root,
          ref: proto.ref,
          adapter: proto.adapter,
          session: proto.session,
          createdAt: now,
          lastSeen: now,
          baseline: commit,
        }),
      );
      await writeFile(
        join(directory, "events", `${id}.json`),
        JSON.stringify({
          id,
          kind: "message",
          createdAt: now,
          sender: { adapter: "test", session: "sender", root },
          recipients: [key],
          text: "snapshot marker",
          files: [],
        }),
      );
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    const pending = consumeMailbox(options);
    options.signal = AbortSignal.abort(new Error("replacement signal"));
    assert.equal((await pending).length, 1);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(calls, 1);
  assert.equal(receiver, options);
  assert.equal(getterReceiver, options);
  const receipt = JSON.parse(await readFile(join(directory, "receipts", key, `${id}.json`), "utf8"));
  assert.equal(receipt.status, "delivered");
});

test("join keeps the same session identity from locking through registration", async (t) => {
  const { dir, root } = await fixture(t);
  const options = { cwd: root, ref: "refs/heads/main", adapter: "test", session: "initial" };
  const originalOpen = fs.promises.open;
  let changed = false;
  const mocked = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    if (!changed && typeof args[0] === "string" && /[\\/]repo\.json\.[0-9a-f-]+\.tmp$/.test(args[0])) {
      changed = true;
      options.session = "changed";
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  let joined;
  try {
    joined = await joinSession(options);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(changed, true);
  assert.equal(joined.session, "initial");
  const repos = join(dir, "state", "repos"),
    id = (await readdir(repos)).find((name) => /^[a-f0-9]{64}$/.test(name));
  assert.ok(id);
  const sessions = await sessionsIn({ directory: join(repos, id) } as Repository);
  assert.deepEqual(
    sessions.map(({ session }) => session),
    ["initial"],
  );
});

test("leave closes the original session even if its caller changes the options", async (t) => {
  const { dir, root } = await fixture(t),
    common = await realpath(join(root, ".git"));
  const marker = "a".repeat(64),
    id = hash([common, marker]),
    directory = join(dir, "state", "repos", id);
  for (const name of ["sessions", "events", "receipts", "refs", "trash"])
    await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(common, ".gitbeacon-id"), `${marker}\n`);
  for (const name of ["identity-owner.json", "identity-ready.json"])
    await writeFile(join(directory, name), JSON.stringify({ id }));
  const now = new Date().toISOString(),
    ref = "refs/heads/main";
  const paths = new Map<string, string>();
  for (const session of ["initial", "changed"]) {
    const identity = { adapter: "test", session },
      key = sessionKey({ root }, identity, ref);
    const path = join(directory, "sessions", `${key}.json`);
    paths.set(session, path);
    await writeFile(path, JSON.stringify({ ...identity, key, root, ref, createdAt: now, lastSeen: now }));
  }
  const options = { cwd: root, ref, adapter: "test", session: "initial" };
  const pending = leaveSession(options);
  options.session = "changed";
  assert.equal((await pending)?.session, "initial");
  const initial = JSON.parse(await readFile(paths.get("initial")!, "utf8"));
  const changed = JSON.parse(await readFile(paths.get("changed")!, "utf8"));
  assert.ok(initial.closedAt);
  assert.equal(changed.closedAt, undefined);
});

test("leave retains the repository ID while locating a missing worktree", async (t) => {
  const { dir, root } = await fixture(t),
    common = await realpath(join(root, ".git"));
  const missing = join(dir, "missing-worktree"),
    identity = "b".repeat(64),
    id = hash([common, identity]);
  const directory = join(dir, "state", "repos", id);
  for (const name of ["sessions", "events", "receipts", "refs", "trash"])
    await mkdir(join(directory, name), { recursive: true });
  for (const name of ["identity-owner.json", "identity-ready.json"])
    await writeFile(join(directory, name), JSON.stringify({ id }));
  await writeFile(join(directory, "repo.json"), JSON.stringify({ id, common, identity, identitySource: "marker" }));
  const ref = "refs/heads/main",
    session = { adapter: "test", session: "missing" },
    key = sessionKey({ root: missing }, session, ref),
    now = new Date().toISOString();
  await writeFile(
    join(directory, "sessions", `${key}.json`),
    JSON.stringify({ ...session, key, root: missing, ref, createdAt: now, lastSeen: now }),
  );
  const options = { cwd: missing, ref, ...session, repositoryId: id };
  const pending = leaveSession(options);
  options.repositoryId = "c".repeat(64);
  assert.equal((await pending)?.session, "missing");
  assert.ok(JSON.parse(await readFile(join(directory, "sessions", `${key}.json`), "utf8")).closedAt);
});

test("session validation rejects adapter and repository ID before later getters", async () => {
  await assert.rejects(
    joinSession({
      adapter: "",
      get session(): never {
        throw new Error("session getter");
      },
      cwd: "",
      ref: "",
    }),
    /adapter name/,
  );
  await assert.rejects(
    leaveSession({
      adapter: "test",
      session: "s",
      repositoryId: "invalid",
      get cwd(): never {
        throw new Error("cwd getter");
      },
      ref: "",
    }),
    /Invalid repository state ID/,
  );
  await assert.rejects(
    leaveSession({
      adapter: "test",
      session: "s",
      cwd: undefined as unknown as string,
      ref: "",
      get signal(): never {
        throw new Error("signal getter");
      },
    }),
    { code: "ERR_INVALID_ARG_TYPE" },
  );
});
