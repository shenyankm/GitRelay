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

test("ordinary hooks skip Git, status and subscriptions until the native session opts in", async (t) => {
  const f = await fixture(t),
    previousPath = process.env.PATH;
  process.env.PATH = join(f.root, "missing-bin");
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  for (const hook_event_name of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const responses: object[] = [];
    await runHook(
      { ...input(f.b), hook_event_name, prompt: "修复这个 bug" },
      ref,
      async (value) => {
        responses.push(value);
      },
      undefined,
      true,
    );
    assert.deepEqual(responses, [{}]);
  }
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
});

test("an unrelated session in a subdirectory stays off without Git even when the worktree is enabled", async (t) => {
  const f = await fixture(t),
    sub = join(f.b, "pkg"),
    previousPath = process.env.PATH;
  await mkdir(sub);
  await sessionActivation({ cwd: f.b, ref, adapter: "codex", session: "enabled" }, true);
  process.env.PATH = join(f.root, "missing-bin");
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  await runHook({ ...input(sub, "other"), hook_event_name: "PostToolUse" }, ref, async (value) => {
    assert.deepEqual(value, {});
  });
});

test("an unenabled nested repository stays off without Git for the same session", async (t) => {
  const f = await fixture(t),
    nested = join(f.b, "nested"),
    previousPath = process.env.PATH;
  await mkdir(nested);
  git(nested, "init");
  await sessionActivation({ cwd: f.b, ref, adapter: "codex", session: "receiver" }, true);
  process.env.PATH = join(f.root, "missing-bin");
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  await runHook({ ...input(nested), hook_event_name: "PostToolUse" }, ref, async (value) => {
    assert.deepEqual(value, {});
  });
});

test("a direct prompt enables only its session and later hooks deliver shared messages once", async (t) => {
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
  assert.deepEqual(
    (await listSessions(f.b)).map((session) => session.session),
    ["receiver"],
  );
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

test("legacy auto-enrollment alone does not activate hooks or acknowledge an old inbox", async (t) => {
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
  assert.deepEqual(responses, [{}]);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  assert.equal(await readReceipt(repo, key, event.id), undefined);
});

test("status requires activation and Stop never blocks without a new event", async (t) => {
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

test("subagents and tool payloads cannot activate a session", async (t) => {
  const f = await fixture(t),
    output = async (value: object) => assert.deepEqual(value, {});
  await runHook({ ...input(f.b), prompt: "Enable GitRelay", agent_id: "subagent" }, ref, output);
  await runHook({ ...input(f.b), hook_event_name: "PostToolUse", prompt: "Enable GitRelay" }, ref, output);
  assert.equal(await sessionActivation({ cwd: f.b, ref, adapter: "codex", session: "receiver" }), false);
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
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
    await waitForChoice(true);
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
