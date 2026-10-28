import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookResponse, runHook } from "../../src/adapters/hooks.ts";
import { sessionActivation } from "../../src/core/activation.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { joinSession, leaveSessionIfRepository, preflightLeaveSession } from "../../src/core/sessions.ts";
import { listSessions, readReceipt, readSession, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { chooseFreshRepository, hash, repository, withLock } from "../../src/core/store.ts";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";
const input = (cwd: string, session = "receiver") => ({
  hook_event_name: "UserPromptSubmit",
  session_id: session,
  cwd,
});

test("code block examples do not change hook activation", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.b, ref, adapter: "codex", session: "receiver" },
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "“Example:\nEnable GitRelay\n    ”" }, ref, output);
  await runHook({ ...input(f.b), prompt: "`Example:\nEnable GitRelay\n    `" }, ref, output);
  await runHook({ ...input(f.b), prompt: "    `Example:\nEnable GitRelay\n`" }, ref, output);
  await runHook({ ...input(f.b), prompt: "    “Example:\nEnable GitRelay\n”" }, ref, output);
  await runHook({ ...input(f.b), prompt: "Example:\n~~~\nEnable GitRelay\n~~~" }, ref, output);
  assert.equal(await sessionActivation(options), false);
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(f.b), prompt: "「例:\nDisable GitRelay\n    」" }, ref, output);
  await runHook({ ...input(f.b), prompt: "`Example:\nDisable GitRelay\n    `" }, ref, output);
  await runHook({ ...input(f.b), prompt: "    `Example:\nDisable GitRelay\n`" }, ref, output);
  await runHook({ ...input(f.b), prompt: "    「示例:\nDisable GitRelay\n」" }, ref, output);
  await runHook({ ...input(f.b), prompt: "Example:\n\n    Disable GitRelay" }, ref, output);
  await runHook({ ...input(f.b), prompt: " \tDisable GitRelay" }, ref, output);
  assert.equal(await sessionActivation(options), true);
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  await runHook({ ...input(f.b), prompt: "- ~~~\n  Disable GitRelay\n  ~~~" }, ref, output);
  assert.equal(await sessionActivation(options), true);
  await runHook({ ...input(f.b), prompt: "- ~~~\n  example\nDisable GitRelay" }, ref, output);
  assert.equal(await sessionActivation(options), false);
  assert.ok((await listSessions(f.b))[0].closedAt);
});

test("failed enable leaves unborn and missing monitored branches disabled", async (t) => {
  const f = await fixture(t),
    output = async (value: object) => assert.deepEqual(value, {});
  for (const name of ["unborn", "master"]) {
    const cwd = join(f.root, name);
    await mkdir(cwd);
    git(cwd, "init", "-b", name === "master" ? "master" : "main");
    if (name === "master") git(cwd, "commit", "--allow-empty", "-m", "init");
    await assert.rejects(runHook({ ...input(cwd), prompt: "Enable GitRelay" }, ref, output));
    assert.equal(await sessionActivation({ cwd, ref, adapter: "codex", session: "receiver" }), false);
    for (const event of ["SessionStart", "PostToolUse", "Stop"])
      await runHook({ ...input(cwd), hook_event_name: event }, ref, output);
  }
});

test("a failed enable preserves a legacy subdirectory opt-in", async (t) => {
  const f = await fixture(t),
    cwd = join(f.b, "sub"),
    missingRef = "refs/heads/missing";
  const options = { cwd, ref: missingRef, adapter: "codex", session: "receiver" };
  await mkdir(cwd);
  const directory = join(f.root, "state", "activations"),
    key = sessionKey({ root: cwd }, options, missingRef);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${key}.json`), JSON.stringify({ key, enabled: true }));
  assert.equal(await sessionActivation(options), true);
  await assert.rejects(runHook({ ...input(cwd), prompt: "Enable GitRelay" }, missingRef, async () => {}));
  assert.equal(await sessionActivation(options), true);
});

test(
  "a killed enable attempt does not activate subsequent hooks",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      cwd = join(f.root, "unborn");
    await mkdir(cwd);
    git(cwd, "init", "-b", "main");
    const activation = new URL("../../src/core/activation.ts", import.meta.url).href;
    const script = `const { sessionActivation } = await import(${JSON.stringify(activation)}); await sessionActivation({ cwd: ${JSON.stringify(cwd)}, ref: ${JSON.stringify(ref)}, adapter: 'codex', session: 'receiver' }, true, undefined, { token: 'interrupted', phase: 'begin' }); process.kill(process.pid, 'SIGKILL');`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: process.env,
    });
    assert.equal(result.signal, "SIGKILL");
    await runHook({ ...input(cwd), hook_event_name: "SessionStart" }, ref, async (value) =>
      assert.deepEqual(value, {}),
    );
    assert.equal(await sessionActivation({ cwd, ref, adapter: "codex", session: "receiver" }), false);
  },
);

test("a killed enable after join leaves the subscription active", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t),
    cwd = f.b;
  const activation = new URL("../../src/core/activation.ts", import.meta.url).href;
  const sessions = new URL("../../src/core/sessions.ts", import.meta.url).href;
  const script = `const { sessionActivation } = await import(${JSON.stringify(activation)}); const { joinSession } = await import(${JSON.stringify(sessions)}); const options = { cwd: ${JSON.stringify(cwd)}, ref: ${JSON.stringify(ref)}, adapter: 'codex', session: 'receiver' }; await sessionActivation(options, true, undefined, { token: 'interrupted', phase: 'begin' }); await joinSession(options, async (register, repositoryId, subscriptionKey) => { await sessionActivation(options, true, undefined, { token: 'interrupted', phase: 'prepare', repositoryId, subscriptionKey, run: async () => { await register('interrupted'); process.kill(process.pid, 'SIGKILL'); } }); });`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    env: process.env,
  });
  assert.equal(result.signal, "SIGKILL");
  assert.equal(await sessionActivation({ cwd, ref, adapter: "codex", session: "receiver" }), true);
  await assert.rejects(
    runHook({ ...input(cwd), hook_event_name: "SessionStart" }, ref, async () => {}),
    /Stale git-relay lock/,
  );
  const repo = await repository(cwd),
    key = sessionKey(repo, { adapter: "codex", session: "receiver" }, ref);
  await rm(join(repo.directory, "sessions", `${key}.lock`));
  await rm(join(repo.directory, "publish.lock"));
  await rm(join(f.root, "state", "activations", `${key}.json.lock`));
  await runHook({ ...input(cwd), hook_event_name: "SessionStart" }, ref, async (value) => assert.deepEqual(value, {}));
  assert.equal((await listSessions(cwd))[0].closedAt, undefined);
});

test("failed activation cleanup waits for the activation lock", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
  await sessionActivation(options, true, undefined, { token: "failure", phase: "begin" });
  const path = join(f.root, "state", "activations", `${sessionKey({ root: f.b }, options, ref)}.json.lock`);
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const lock = withLock(path, async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const cleanup = sessionActivation(options, true, undefined, { token: "failure", phase: "failure" });
  try {
    await delay(50);
    assert.equal(await sessionActivation(options), false);
  } finally {
    release.resolve();
  }
  await Promise.all([lock, cleanup]);
  assert.equal(await sessionActivation(options), false);
});

test("registration failure rolls back before a competing activation lock", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
  const path = join(f.root, "state", "activations", `${sessionKey({ root: f.b }, options, ref)}.json.lock`);
  await sessionActivation(options, true, undefined, { token: "registration", phase: "begin" });
  let competing: Promise<void> | undefined;
  await assert.rejects(
    sessionActivation(options, true, undefined, {
      token: "registration",
      repositoryId: "a".repeat(64),
      phase: "prepare",
      run: async () => {
        competing = withLock(path, async () => {}, { waitMs: 5000 });
        await delay(50);
        throw new Error("registration failed");
      },
    }),
    /registration failed/,
  );
  await competing;
  assert.equal(await sessionActivation(options), false);
});

test("hook registration failure stays disabled under lock contention", async (t) => {
  const f = await fixture(t);
  const hooks = new URL("../../src/adapters/hooks.ts", import.meta.url).href;
  const activation = new URL("../../src/core/activation.ts", import.meta.url).href;
  const mailbox = new URL("../../src/core/mailbox.ts", import.meta.url).href;
  const store = new URL("../../src/core/store.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const { runHook } = await import(${JSON.stringify(hooks)});
    const { sessionActivation } = await import(${JSON.stringify(activation)});
    const { sessionKey } = await import(${JSON.stringify(mailbox)});
    const { withLock } = await import(${JSON.stringify(store)});
    const options = { cwd: process.argv[1], ref: 'refs/heads/main', adapter: 'codex', session: 'receiver' };
    const lock = join(process.env.WORKTREE_SYNC_STATE_DIR, 'activations', sessionKey({ root: options.cwd }, options, options.ref) + '.json.lock');
    const original = fs.promises.open;
    let competing, fired = false;
    fs.promises.open = async (...args) => {
      if (!fired && typeof args[0] === 'string' && /[\\/]sessions[\\/][a-f0-9]{64}\\.json\\..*\\.tmp$/.test(args[0])) {
        fired = true;
        competing = withLock(lock, async () => new Promise(resolve => setTimeout(resolve, 100)), { waitMs: 5000 });
        throw new Error('injected registration failure');
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(runHook({ cwd: options.cwd, session_id: options.session, hook_event_name: 'UserPromptSubmit', prompt: 'Enable GitRelay' }, options.ref, async () => {}), /injected registration failure/);
      await competing;
      assert.equal(fired, true);
      assert.equal(await sessionActivation(options), false);
    } finally { fs.promises.open = original; syncBuiltinESMExports(); }
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, f.b], {
    env: process.env,
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("hook remains disabled when registration and rollback both run out of space", async (t) => {
  const f = await fixture(t);
  const hooks = new URL("../../src/adapters/hooks.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { runHook } = await import(${JSON.stringify(hooks)});
    const input = { cwd: process.argv[1], session_id: 'receiver', hook_event_name: 'UserPromptSubmit', prompt: 'Enable GitRelay' };
    const open = fs.promises.open, originalPath = process.env.PATH;
    let full = false;
    fs.promises.open = async (...args) => {
      const path = String(args[0]);
      if (/[\\/]sessions[\\/][a-f0-9]{64}\\.json\\..*\\.tmp$/.test(path)) full = true;
      if (full && /[\\/](?:sessions|activations)[\\/][a-f0-9]{64}\\.json\\..*\\.tmp$/.test(path))
        throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
      return open(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(runHook(input, 'refs/heads/main', async () => {}), /ENOSPC/);
      assert.equal(full, true);
      process.env.PATH = '';
      await runHook({ ...input, hook_event_name: 'SessionStart' }, 'refs/heads/main', async value => assert.deepEqual(value, {}));
    } finally { fs.promises.open = open; process.env.PATH = originalPath; syncBuiltinESMExports(); }
    await runHook(input, 'refs/heads/main', async () => {});
    const names = await fs.promises.readdir(process.env.WORKTREE_SYNC_STATE_DIR + '/activations');
    const state = JSON.parse(await fs.promises.readFile(process.env.WORKTREE_SYNC_STATE_DIR + '/activations/' + names.find(name => name.endsWith('.json')), 'utf8'));
    assert.equal(state.enabled, true);
    assert.equal(state.pending, undefined);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, f.b], {
    env: process.env,
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a committed subscription recovers activation when its final write fails", async (t) => {
  const f = await fixture(t);
  const hooks = new URL("../../src/adapters/hooks.ts", import.meta.url).href;
  const activation = new URL("../../src/core/activation.ts", import.meta.url).href;
  const mailbox = new URL("../../src/core/mailbox.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { runHook } = await import(${JSON.stringify(hooks)});
    const { sessionActivation } = await import(${JSON.stringify(activation)});
    const { listSessions } = await import(${JSON.stringify(mailbox)});
    const options = { cwd: process.argv[1], ref: 'refs/heads/main', adapter: 'codex', session: 'receiver' };
    const input = { cwd: options.cwd, session_id: options.session, hook_event_name: 'UserPromptSubmit', prompt: 'Enable GitRelay' };
    const open = fs.promises.open; let registered = false, failed = false;
    fs.promises.open = async (...args) => {
      const path = String(args[0]);
      if (/[\\/]sessions[\\/][a-f0-9]{64}\\.json\\..*\\.tmp$/.test(path)) registered = true;
      if (registered && /[\\/]activations[\\/][a-f0-9]{64}\\.json\\..*\\.tmp$/.test(path)) {
        failed = true; throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
      }
      return open(...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(runHook(input, options.ref, async () => {}), /ENOSPC/); }
    finally { fs.promises.open = open; syncBuiltinESMExports(); }
    assert.equal(failed, true);
    assert.equal(await sessionActivation(options), true);
    assert.equal(await sessionActivation({ ...options, session: 'other' }), false);
    const token = (await listSessions(options.cwd))[0].activationToken;
    await runHook({ ...input, hook_event_name: 'SessionStart' }, options.ref, async () => {});
    assert.equal((await listSessions(options.cwd))[0].activationToken, token);
    await runHook(input, options.ref, async () => {});
    const names = await fs.promises.readdir(process.env.WORKTREE_SYNC_STATE_DIR + '/activations');
    const state = JSON.parse(await fs.promises.readFile(process.env.WORKTREE_SYNC_STATE_DIR + '/activations/' + names.find(name => name.endsWith('.json')), 'utf8'));
    assert.equal(state.pending, undefined);
    await runHook({ ...input, prompt: 'Disable GitRelay' }, options.ref, async () => {});
    assert.equal(await sessionActivation(options), false);
    assert.ok((await listSessions(options.cwd))[0].closedAt);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, f.b], {
    env: process.env,
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test(
  "activation recovery uses Git's subscription key when root spelling differs",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "git-shim");
    await mkdir(bin);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realGit);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$3" = rev-parse ] && [ "$4" = --show-toplevel ]; then "$GIT_RELAY_TEST_GIT" "$@" | sed "s|^/|//|"; else exec "$GIT_RELAY_TEST_GIT" "$@"; fi\n',
      { mode: 0o755 },
    );
    const hooks = new URL("../../src/adapters/hooks.ts", import.meta.url).href;
    const activation = new URL("../../src/core/activation.ts", import.meta.url).href;
    const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { runHook } = await import(${JSON.stringify(hooks)});
    const { sessionActivation } = await import(${JSON.stringify(activation)});
    const options = { cwd: process.argv[1], ref: 'refs/heads/main', adapter: 'codex', session: 'receiver' };
    const input = { cwd: options.cwd, session_id: options.session, hook_event_name: 'UserPromptSubmit', prompt: 'Enable GitRelay' };
    const open = fs.promises.open; let registered = false;
    fs.promises.open = async (...args) => {
      const path = String(args[0]);
      if (/\\/sessions\\/[a-f0-9]{64}\\.json\\..*\\.tmp$/.test(path)) registered = true;
      if (registered && /\\/activations\\/[a-f0-9]{64}\\.json\\..*\\.tmp$/.test(path))
        throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
      return open(...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(runHook(input, options.ref, async () => {}), /ENOSPC/); }
    finally { fs.promises.open = open; syncBuiltinESMExports(); }
    assert.equal(registered, true);
    assert.equal(await sessionActivation(options), true);
  `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, f.b],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_RELAY_TEST_GIT: realGit },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

test("changed subscription is detected before disabling activation", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
  const checked = await preflightLeaveSession(options);
  await joinSession(options);
  await sessionActivation(options, true);
  await assert.rejects(sessionActivation(options, false, checked), /subscription changed during opt-out/);
  assert.equal(await sessionActivation(options), true);
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
});

test("legacy subdirectory activation closes its inbox when disabled at the root", async (t) => {
  const f = await fixture(t),
    sub = join(f.b, "sub"),
    options = { cwd: sub, ref, adapter: "codex", session: "receiver" };
  await mkdir(sub);
  const directory = join(f.root, "state", "activations");
  await mkdir(directory, { recursive: true });
  const oldKey = sessionKey({ root: sub }, options, ref);
  await writeFile(join(directory, `${oldKey}.json`), JSON.stringify({ key: oldKey, enabled: true }));
  await joinSession(options);
  const event = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "unread" });
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, async () => {});
  const repo = await repository(f.b),
    key = sessionKey(repo, options, ref);
  assert.ok((await listSessions(f.b))[0].closedAt);
  assert.equal(await readReceipt(repo, key, event.id), undefined);
});

test("failed nested repository disable cannot disable its parent activation", async (t) => {
  const f = await fixture(t),
    nested = join(f.b, "nested");
  await mkdir(nested);
  git(nested, "init", "-b", "main");
  git(nested, "commit", "--allow-empty", "-m", "init");
  const output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(nested), prompt: "Enable GitRelay" }, ref, output);
  await rename(join(nested, ".git"), join(nested, ".git-saved"));
  await assert.rejects(runHook({ ...input(nested), prompt: "Disable GitRelay" }, ref, output), /restore.*repository/i);
  assert.equal(await sessionActivation({ cwd: f.b, ref, adapter: "codex", session: "receiver" }), true);
});

test("CLI can leave a deleted nested repository with an enabled parent", async (t) => {
  const f = await fixture(t),
    nested = join(f.b, "nested");
  await mkdir(nested);
  git(nested, "init", "-b", "main");
  git(nested, "commit", "--allow-empty", "-m", "init");
  const output = async (_value: object) => {};
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(nested), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(f.b, "other"), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(nested, "other"), prompt: "Enable GitRelay" }, ref, output);
  for (const session of ["plain", "plain-other"]) {
    await runHook({ ...input(f.b, session), prompt: "Enable GitRelay" }, ref, output);
    await runHook({ ...input(nested, session), prompt: "Enable GitRelay" }, ref, output);
  }
  const repo = await repository(nested);
  for (const session of ["receiver", "other"]) {
    const key = sessionKey(repo, { adapter: "codex", session }, ref);
    const path = join(repo.directory, "sessions", `${key}.json`);
    const saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, activationToken: "interrupted" }));
    await writeFile(
      join(process.env.WORKTREE_SYNC_STATE_DIR!, "activations", `${key}.json`),
      JSON.stringify({
        key,
        enabled: false,
        pending: ["interrupted"],
        prepared: [{ token: "interrupted", repositoryId: repo.id }],
        committed: false,
      }),
    );
  }
  await rm(nested, { recursive: true });
  for (const [session, args] of [
    ["receiver", ["--repository-id", repo.id]],
    ["other", []],
    ["plain", ["--repository-id", repo.id]],
    ["plain-other", []],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "leave", "--cwd", nested, "--agent", "codex", "--session", session, ...args],
      { encoding: "utf8", env: process.env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await readSession(repo, sessionKey(repo, { adapter: "codex", session }, ref)))?.closedAt);
    assert.equal(await sessionActivation({ cwd: f.b, ref, adapter: "codex", session }), true);
  }
});

test("invalid explicit CLI repository selection does not disable an existing worktree", async (t) => {
  const f = await fixture(t);
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, async () => {});
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      cli,
      "leave",
      "--cwd",
      f.b,
      "--agent",
      "codex",
      "--session",
      "receiver",
      "--repository-id",
      "d".repeat(64),
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only for a missing worktree/);
  assert.equal(await sessionActivation({ cwd: f.b, ref, adapter: "codex", session: "receiver" }), true);
});

test(
  "disable does not close a replacement repository after activation preflight",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const hooksUrl = new URL("../../src/adapters/hooks.ts", import.meta.url).href;
    const sessionsUrl = new URL("../../src/core/sessions.ts", import.meta.url).href;
    const mailboxUrl = new URL("../../src/core/mailbox.ts", import.meta.url).href;
    const prepare = `const { joinSession } = await import(${JSON.stringify(sessionsUrl)}); await joinSession({ cwd: process.argv[1], ref: 'refs/heads/main', adapter: 'codex', session: 'receiver' });`;
    const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.argv[1], activation = process.argv[2], old = root + '-old';
    const { runHook } = await import(${JSON.stringify(hooksUrl)});
    const { listSessions } = await import(${JSON.stringify(mailboxUrl)});
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'receiver', cwd: root };
    await runHook({ ...input, prompt: 'Enable GitRelay' }, 'refs/heads/main', async () => {});
    const original = fs.renameSync;
    let swapped = false;
    fs.renameSync = (from, to) => {
      if (!swapped && typeof to === 'string' && to.startsWith(activation) && to.endsWith('.json')) {
        swapped = true;
        original(root, old);
        fs.mkdirSync(root);
        execFileSync('git', ['init', '-q', '-b', 'main', root]);
        execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
        execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', ${JSON.stringify(prepare)}, root], { env: process.env });
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(runHook({ ...input, prompt: 'Disable GitRelay' }, 'refs/heads/main', async () => {}), /identity changed|subscription changed/i);
    } finally {
      fs.renameSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true);
    assert.equal((await listSessions(root))[0].closedAt, undefined);
  `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, f.b, join(f.root, "state", "activations")],
      { encoding: "utf8", env: process.env, timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  "worktree activation, disable retry and POSIX message capability remain compatible",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      sub = join(f.b, "sub"),
      responses: object[] = [],
      output = async (value: object) => {
        responses.push(value);
      };
    await mkdir(sub);
    await writeFile(join(f.b, "\\notes"), "local");
    await writeFile(join(f.b, "\\later"), "local");
    await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
    const repo = await repository(f.b),
      key = sessionKey(repo, { adapter: "codex", session: "receiver" }, ref);
    assert.equal((await listSessions(f.b))[0].posixPaths, true);
    const first = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "first", files: ["\\notes"] });
    assert.equal(first.pathFormat, "posix-v1");
    await runHook({ ...input(sub), hook_event_name: "PostToolUse" }, ref, output);
    assert.equal((await readReceipt(repo, key, first.id))?.status, "delivered");
    const second = await sendMessage({
      cwd: f.a,
      adapter: "cli",
      session: "sender",
      text: "unread",
      files: ["\\later"],
    });
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const locked = withLock(join(repo.directory, "sessions", `${key}.lock`), async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      await assert.rejects(runHook({ ...input(sub), prompt: "Disable GitRelay" }, ref, output), /busy/);
    } finally {
      release.resolve();
      await locked;
    }
    await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
    assert.ok((await listSessions(f.b))[0].closedAt);
    assert.equal(await readReceipt(repo, key, second.id), undefined);
    const closed = await sendMessage({
      cwd: f.a,
      adapter: "cli",
      session: "sender",
      text: "closed",
      files: ["\\closed"],
    });
    assert.ok(!closed.recipients.includes(key));
    await runHook({ ...input(sub), prompt: "Enable GitRelay" }, ref, output);
    assert.equal((await readReceipt(repo, key, second.id))?.status, "delivered");
    assert.equal((await listSessions(f.b))[0].posixPaths, true);
  },
);

test("Codex protocol returns model context and Stop continuation", () => {
  assert.deepEqual(hookResponse("PostToolUse", "diff"), {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "diff" },
  });
  assert.deepEqual(hookResponse("Stop", "diff"), { decision: "block", reason: "diff" });
});

test("ordinary hooks automatically register and report status without an enable prompt", async (t) => {
  const f = await fixture(t);
  for (const hook_event_name of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const responses: object[] = [];
    await runHook(
      { ...input(f.b), hook_event_name, prompt: "Fix this bug" },
      ref,
      async (value) => {
        responses.push(value);
      },
      undefined,
      true,
    );
    assert.equal((await listSessions(f.b)).length, 1);
    if (["SessionStart", "UserPromptSubmit"].includes(hook_event_name))
      assert.match(JSON.stringify(responses), /feature\/b/);
    else assert.deepEqual(responses, [{}]);
  }
});

test("invalid hook refs do not enable a session", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runHook({ ...input(f.b), prompt: "Enable GitRelay" }, "refs/heads/bad..name", async () => {}),
    /check-ref-format/,
  );
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
});

test("new sessions participate automatically in subdirectories and nested repositories", async (t) => {
  const f = await fixture(t),
    sub = join(f.b, "pkg"),
    nested = join(f.b, "nested");
  await mkdir(sub);
  await mkdir(nested);
  git(nested, "init", "-b", "main");
  git(nested, "commit", "--allow-empty", "-m", "initial");
  for (const cwd of [sub, nested]) {
    await runHook({ ...input(cwd), hook_event_name: "SessionStart" }, ref, async () => {});
    assert.equal((await listSessions(cwd)).length, 1);
  }
  assert.notEqual((await repository(sub)).id, (await repository(nested)).id);
});

test("automatic sessions establish independent baselines and deliver shared messages once", async (t) => {
  const f = await fixture(t),
    responses: object[] = [],
    output = async (value: object) => {
      responses.push(value);
    };
  await runHook({ ...input(f.b), prompt: "请并行开发这个功能" }, ref, output);
  await sendMessage({ cwd: f.a, adapter: "opencode", session: "sender", text: "first shared note" });
  await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "second shared note" });
  await runHook({ ...input(f.b, "other"), hook_event_name: "PostToolUse" }, ref, output);
  assert.deepEqual(responses.at(-1), {});
  await runHook({ ...input(f.b), hook_event_name: "PostToolUse" }, ref, output);
  assert.match(JSON.stringify(responses.at(-1)), /first shared note.*second shared note/s);
  assert.match(JSON.stringify(responses.at(-1)), /systemMessage/);
  await runHook({ ...input(f.b), hook_event_name: "SessionStart" }, ref, output);
  assert.deepEqual(responses.at(-1), {});
  assert.deepEqual((await listSessions(f.b)).map((session) => session.session).sort(), ["other", "receiver"]);
});

test("hooks deliver across root and nested directories in either activation direction", async (t) => {
  const f = await fixture(t),
    sub = join(f.b, "pkg"),
    responses: object[] = [],
    output = async (value: object) => {
      responses.push(value);
    };
  await mkdir(sub);
  const repo = await repository(f.b);
  for (const [activation, delivery, session] of [
    [f.b, sub, "root-first"],
    [sub, f.b, "sub-first"],
  ]) {
    await runHook({ ...input(activation, session), prompt: "Enable GitRelay" }, ref, output);
    const event = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: session });
    await runHook({ ...input(delivery, session), hook_event_name: "PostToolUse" }, ref, output);
    assert.match(JSON.stringify(responses.at(-1)), new RegExp(session));
    const key = sessionKey(repo, { adapter: "codex", session }, ref);
    assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
  }
});

test("disabling closes enrollment and preserves unread messages for an explicit rejoin", async (t) => {
  const f = await fixture(t),
    responses: object[] = [],
    output = async (value: object) => {
      responses.push(value);
    };
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const event = await sendMessage({
    cwd: f.a,
    adapter: "opencode",
    session: "sender",
    text: "unread before disabling",
  });
  await runHook({ ...input(f.b), prompt: "关闭 GitRelay" }, ref, output);
  await runHook({ ...input(f.b), hook_event_name: "Stop" }, ref, output);
  assert.deepEqual(responses.at(-1), {});
  const repo = await repository(f.b),
    key = sessionKey(repo, { adapter: "codex", session: "receiver" }, ref);
  assert.equal(await readReceipt(repo, key, event.id), undefined);
  assert.ok((await listSessions(f.b))[0].closedAt);
  const skipped = await sendMessage({ cwd: f.a, adapter: "opencode", session: "sender", text: "while disabled" });
  assert.ok(!skipped.recipients.includes(key));
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  assert.match(JSON.stringify(responses.at(-1)), /unread before disabling/);
  assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
});

test("a failed disable can be retried after the session lock is released", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {},
    options = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const repo = await repository(f.b),
    key = sessionKey(repo, options, ref);
  await withLock(join(repo.directory, "sessions", `${key}.lock`), async () => {
    await assert.rejects(runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output), /busy/);
  });
  assert.equal(await sessionActivation(options), false);
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await listSessions(f.b))[0].closedAt);
  const message = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "after disable" });
  assert.ok(!message.recipients.includes(key));
});

test("disabling outside a Git repository is a no-op", async (t) => {
  const f = await fixture(t);
  await runHook({ ...input(f.root), prompt: "Disable GitRelay" }, ref, async (value) => assert.deepEqual(value, {}));
});

test("disabling a never-enabled Git worktree does not initialize repository state", async (t) => {
  const f = await fixture(t);
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, async (value) => assert.deepEqual(value, {}));
  await assert.rejects(access(join(f.main, ".git", ".git-relay-id")), { code: "ENOENT" });
  await assert.rejects(access(join(f.root, "state", "repos")), { code: "ENOENT" });
});

test(
  "disable closes a session when Git reports an equivalent root spelling",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "bin"),
      previousPath = process.env.PATH;
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, async () => {});
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$3" = rev-parse ] && [ "$4" = --show-toplevel ]; then printf "%s/\\n" "$TEST_WORKTREE"; exit 0; fi\nexec "$TEST_REAL_GIT" "$@"\n',
    );
    await chmod(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.TEST_WORKTREE = f.b;
    process.env.TEST_REAL_GIT = realGit;
    try {
      await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, async () => {});
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      delete process.env.TEST_WORKTREE;
      delete process.env.TEST_REAL_GIT;
    }
    assert.ok((await listSessions(f.b))[0].closedAt);
  },
);

test("cancellation during a no-op opt-out is not reported as success", async (t) => {
  const f = await fixture(t),
    module = new URL("../../src/core/sessions.ts", import.meta.url).href;
  const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const controller = new AbortController();
const original = fs.promises.readdir;
fs.promises.readdir = async function(path, ...args) {
  if (String(path).endsWith('/repos')) controller.abort();
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();
const { leaveSessionIfRepository } = await import(${JSON.stringify(module)});
try {
  await leaveSessionIfRepository({ cwd: process.cwd(), ref: 'refs/heads/main', adapter: 'codex', session: 's', signal: controller.signal });
  process.exitCode = 1;
} catch (error) {
  if (!controller.signal.aborted || error.name !== 'AbortError') process.exitCode = 1;
}
`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: f.b,
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("disabling reports a broken Git pointer and can be retried after repair", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const repo = await repository(f.b),
    key = sessionKey(repo, { adapter: "codex", session: "receiver" }, ref);
  const pointer = join(f.b, ".git"),
    original = await readFile(pointer);
  for (const missing of [false, true]) {
    if (missing) await rm(pointer);
    else await writeFile(pointer, `gitdir: ${join(f.root, "missing-gitdir")}\n`);
    try {
      await assert.rejects(
        runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output),
        /not a git repository|gitfile does not point to a valid repository/i,
      );
    } finally {
      await writeFile(pointer, original);
    }
  }
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  const message = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "before retry" });
  assert.ok(message.recipients.includes(key));
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await listSessions(f.b))[0].closedAt);
});

test("a missing Git pointer is detected when the disable comes from a worktree subdirectory", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {},
    nested = join(f.b, "nested");
  await mkdir(nested);
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const pointer = join(f.b, ".git"),
    original = await readFile(pointer);
  await rm(pointer);
  try {
    await assert.rejects(
      runHook({ ...input(nested), prompt: "Disable GitRelay" }, ref, output),
      /not a git repository/i,
    );
  } finally {
    await writeFile(pointer, original);
  }
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await listSessions(f.b))[0].closedAt);
});

test("a closed subscription does not block a repeated disable outside Git", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  const pointer = join(f.b, ".git"),
    original = await readFile(pointer);
  await rm(pointer);
  try {
    await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, async (value) => assert.deepEqual(value, {}));
  } finally {
    await writeFile(pointer, original);
  }
  assert.ok((await listSessions(f.b))[0].closedAt);
});

test("a damaged prior session prevents silently ignoring an unavailable repository", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const repo = await repository(f.b),
    key = sessionKey(repo, { adapter: "codex", session: "receiver" }, ref);
  const session = join(repo.directory, "sessions", `${key}.json`),
    originalSession = await readFile(session);
  const pointer = join(f.b, ".git"),
    originalPointer = await readFile(pointer);
  await writeFile(session, "{}");
  await rm(pointer);
  try {
    await assert.rejects(runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output), /Invalid session/);
  } finally {
    await writeFile(session, originalSession);
    await writeFile(pointer, originalPointer);
  }
});

test("a missing nested repository cannot close its parent's subscription", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {},
    nested = join(f.b, "nested");
  await mkdir(nested);
  git(nested, "init", "-b", "main");
  git(nested, "commit", "--allow-empty", "-m", "initial");
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(nested), prompt: "Enable GitRelay" }, ref, output);
  await rename(join(nested, ".git"), join(nested, ".git-hidden"));
  try {
    await assert.rejects(
      runHook({ ...input(nested), prompt: "Disable GitRelay" }, ref, output),
      /another GitRelay subscription/i,
    );
  } finally {
    await rename(join(nested, ".git-hidden"), join(nested, ".git"));
  }
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  assert.equal((await listSessions(nested))[0].closedAt, undefined);
  await runHook({ ...input(nested), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await listSessions(nested))[0].closedAt);
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  await rename(join(nested, ".git"), join(nested, ".git-hidden"));
  try {
    await runHook({ ...input(nested), prompt: "Disable GitRelay" }, ref, output);
  } finally {
    await rename(join(nested, ".git-hidden"), join(nested, ".git"));
  }
  assert.ok((await listSessions(f.b))[0].closedAt);
});

test("a fresh repository identity at the same path can close its own subscription", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const oldRepo = await repository(f.b),
    oldKey = sessionKey(oldRepo, { adapter: "codex", session: "receiver" }, ref);
  await rename(join(f.b, ".git"), join(f.b, ".git-old"));
  git(f.b, "init", "-b", "main");
  git(f.b, "commit", "--allow-empty", "-m", "initial");
  await chooseFreshRepository(f.b);
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await listSessions(f.b))[0].closedAt);
  assert.equal((await readSession(oldRepo, oldKey))?.closedAt, undefined);
});

test("a missing repository identity is preserved until the user restores it", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const repo = await repository(f.b),
    key = sessionKey(repo, { adapter: "codex", session: "receiver" }, ref);
  const sessionPath = join(repo.directory, "sessions", `${key}.json`),
    before = await readFile(sessionPath);
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "preserve unread" });
  const marker = join(repo.common, ".git-relay-id"),
    history = join(f.root, "state", "identity-history", hash(repo.common));
  for (const missingHistory of [false, true]) {
    await rename(marker, `${marker}.saved`);
    if (missingHistory) await rename(history, `${history}.saved`);
    try {
      await assert.rejects(runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output), /identity is missing/i);
      await assert.rejects(access(marker), { code: "ENOENT" });
      assert.deepEqual(await readFile(sessionPath), before);
      assert.equal(await readReceipt(repo, key, event.id), undefined);
    } finally {
      if (missingHistory) await rename(`${history}.saved`, history);
      await rename(`${marker}.saved`, marker);
    }
  }
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await listSessions(f.b))[0].closedAt);
  assert.equal(await readReceipt(repo, key, event.id), undefined);
});

test("an old subscription is preserved when the current identity lacks that session", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const oldRepo = await repository(f.b),
    oldKey = sessionKey(oldRepo, { adapter: "codex", session: "receiver" }, ref);
  const marker = join(oldRepo.common, ".git-relay-id");
  await rename(marker, `${marker}.old`);
  try {
    await chooseFreshRepository(f.b);
    await runHook({ ...input(f.b, "other"), prompt: "Enable GitRelay" }, ref, output);
    await assert.rejects(
      runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output),
      /different repository identity/i,
    );
    assert.equal((await readSession(oldRepo, oldKey))?.closedAt, undefined);
    assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  } finally {
    await rm(marker, { force: true });
    await rename(`${marker}.old`, marker);
  }
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await readSession(oldRepo, oldKey))?.closedAt);
});

test("an opt-out preflight cannot close the same session under a replacement identity", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  const options = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const oldRepo = await repository(f.b),
    oldKey = sessionKey(oldRepo, options, ref);
  const checked = await preflightLeaveSession(options);
  const marker = join(oldRepo.common, ".git-relay-id");
  await rename(marker, `${marker}.old`);
  try {
    await chooseFreshRepository(f.b);
    await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
    await assert.rejects(leaveSessionIfRepository(options, checked), /identity changed during opt-out/i);
    assert.equal((await readSession(oldRepo, oldKey))?.closedAt, undefined);
    assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  } finally {
    await rm(marker, { force: true });
    await rename(`${marker}.old`, marker);
  }
});

test("an opt-out preflight does not close a subscription created afterward", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  const options = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
  const checked = await preflightLeaveSession(options);
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await assert.rejects(leaveSessionIfRepository(options, checked), /subscription changed during opt-out/i);
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
});

test("an opt-out preflight does not use a newly created repository", async (t) => {
  const f = await fixture(t),
    options = { cwd: f.root, ref, adapter: "codex", session: "receiver" };
  const checked = await preflightLeaveSession(options);
  git(f.root, "init", "-b", "main");
  await assert.rejects(leaveSessionIfRepository(options, checked), /worktree root changed during opt-out/i);
  await assert.rejects(access(join(f.root, ".git", ".git-relay-id")), { code: "ENOENT" });
});

test("a missing nested repository does not initialize an unrelated parent", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {},
    nested = join(f.b, "nested");
  await mkdir(nested);
  git(nested, "init", "-b", "main");
  git(nested, "commit", "--allow-empty", "-m", "initial");
  await runHook({ ...input(nested), prompt: "Enable GitRelay" }, ref, output);
  const repos = join(f.root, "state", "repos"),
    before = await readdir(repos);
  const marker = join(f.main, ".git", ".git-relay-id");
  await assert.rejects(access(marker), { code: "ENOENT" });
  await rename(join(nested, ".git"), join(nested, ".git-hidden"));
  try {
    await assert.rejects(
      runHook({ ...input(nested), prompt: "Disable GitRelay" }, ref, output),
      /another GitRelay subscription/i,
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.deepEqual(await readdir(repos), before);
  } finally {
    await rename(join(nested, ".git-hidden"), join(nested, ".git"));
  }
});

test(
  "filesystem boundary diagnostics skip only directories without prior subscriptions",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "bin"),
      ordinary = join(f.root, "ordinary"),
      previousPath = process.env.PATH,
      output = async (value: object) => assert.deepEqual(value, {});
    await mkdir(bin);
    await mkdir(ordinary);
    await writeFile(
      join(bin, "git"),
      "#!/bin/sh\nprintf 'fatal: not a git repository (or any parent up to mount point /)\\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\\n' >&2\nexit 128\n",
      { mode: 0o755 },
    );
    process.env.PATH = bin;
    try {
      await runHook({ ...input(ordinary), prompt: "Disable GitRelay" }, ref, output);
      await assert.rejects(access(join(f.root, "state", "repos")), { code: "ENOENT" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
    const pointer = join(f.b, ".git"),
      original = await readFile(pointer);
    await rm(pointer);
    process.env.PATH = bin;
    try {
      await assert.rejects(runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output), /filesystem boundary/i);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await writeFile(pointer, original);
    }
    assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  },
);

test(
  "disabling reports Git failures instead of treating every exit 128 as a non-repository",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "bin"),
      previousPath = process.env.PATH;
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    });
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nprintf 'fatal: injected failure\\n' >&2\nexit 128\n");
    await chmod(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    await assert.rejects(
      runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, async () => {}),
      /injected failure/,
    );
  },
);

test("automatic participation resumes an existing inbox and acknowledges delivered events", async (t) => {
  const f = await fixture(t),
    responses: object[] = [];
  const receiver = { cwd: f.b, ref, adapter: "codex", session: "receiver", async deliver() {} };
  await consumeMailbox(receiver);
  const event = await sendMessage({ cwd: f.a, adapter: "opencode", session: "sender", text: "legacy unread" });
  await runHook(
    { ...input(f.b), hook_event_name: "SessionStart" },
    ref,
    async (value) => {
      responses.push(value);
    },
    undefined,
    true,
  );
  assert.match(JSON.stringify(responses), /legacy unread/);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
});

test("automatic status and Stop never block without a new event", async (t) => {
  const f = await fixture(t),
    responses: object[] = [],
    output = async (value: object) => {
      responses.push(value);
    };
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output, undefined, true);
  assert.match(JSON.stringify(responses.at(-1)), /feature\/b/);
  assert.match(JSON.stringify(responses.at(-1)), /not authorization to act/);
  await runHook({ ...input(f.b), hook_event_name: "Stop" }, ref, output, undefined, true);
  assert.deepEqual(responses.at(-1), {});
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await f.commit(f.main, "shared.txt", "upstream\n");
  await runHook({ ...input(f.b), hook_event_name: "Stop", stop_hook_active: true }, ref, output);
  assert.deepEqual(responses.at(-1), {});
  await runHook({ ...input(f.b), hook_event_name: "Stop" }, ref, output);
  assert.match(JSON.stringify(responses.at(-1)), /"decision":"block"/);
  await runHook({ ...input(f.b), hook_event_name: "Stop" }, ref, output);
  assert.deepEqual(responses.at(-1), {});
});

test("subagents stay excluded and tool payloads cannot override an explicit opt-out", async (t) => {
  const f = await fixture(t),
    output = async (value: object) => assert.deepEqual(value, {});
  await runHook({ ...input(f.b), prompt: "Enable GitRelay", agent_id: "subagent" }, ref, output);
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  await runHook({ ...input(f.b), hook_event_name: "PostToolUse", prompt: "Enable GitRelay" }, ref, output);
  assert.equal(await sessionActivation({ cwd: f.b, ref, adapter: "codex", session: "receiver" }), false);
  assert.deepEqual(await listSessions(f.b), []);
});

test("a later disable wins while an earlier hook is still joining", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  const options = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  const repo = await repository(f.b),
    key = sessionKey(repo, options, ref);
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const locked = withLock(join(repo.directory, "publish.lock"), async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const joining = runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  let leaving: Promise<void> | undefined;
  const waitForChoice = async (enabled: boolean) => {
    const deadline = Date.now() + 3000;
    while ((await sessionActivation(options)) !== enabled) {
      assert.ok(Date.now() < deadline, "activation did not change");
      await delay(10);
    }
  };
  try {
    const deadline = Date.now() + 3000;
    while (
      !(await access(join(repo.directory, "sessions", `${key}.lock`)).then(
        () => true,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, "the joining hook did not acquire its session lock");
      await delay(10);
    }
    leaving = runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output).then(() => {});
    await waitForChoice(false);
    await leaving;
  } finally {
    release.resolve();
    await Promise.all([locked, joining, leaving]);
  }
  assert.equal(await sessionActivation(options), false);
  assert.ok((await listSessions(f.b))[0].closedAt);
});
