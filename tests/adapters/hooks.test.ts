import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hookResponse, runHook } from "../../src/adapters/hooks.ts";
import { sessionActivation } from "../../src/core/activation.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { listSessions, readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { repository, withLock } from "../../src/core/store.ts";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";
const input = (cwd: string, session = "receiver") => ({
  hook_event_name: "UserPromptSubmit",
  session_id: session,
  cwd,
});

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

test("disabling reports a broken Git pointer and can be retried after repair", async (t) => {
  const f = await fixture(t),
    output = async (_value: object) => {};
  await runHook({ ...input(f.b), prompt: "Enable GitRelay" }, ref, output);
  const repo = await repository(f.b),
    key = sessionKey(repo, { adapter: "codex", session: "receiver" }, ref);
  const pointer = join(f.b, ".git"),
    original = await readFile(pointer);
  await writeFile(pointer, `gitdir: ${join(f.root, "missing-gitdir")}\n`);
  try {
    await assert.rejects(runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output), /not a git repository/i);
  } finally {
    await writeFile(pointer, original);
  }
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  const message = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "before retry" });
  assert.ok(message.recipients.includes(key));
  await runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output);
  assert.ok((await listSessions(f.b))[0].closedAt);
});

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
    leaving = assert.rejects(runHook({ ...input(f.b), prompt: "Disable GitRelay" }, ref, output), /busy/);
    await waitForChoice(false);
    await leaving;
  } finally {
    release.resolve();
    await Promise.all([locked, joining, leaving]);
  }
  assert.equal(await sessionActivation(options), false);
  assert.ok((await listSessions(f.b))[0].closedAt);
});
