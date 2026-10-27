import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/adapters/opencode/index.ts";
import { listSessions, readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { hash, repository } from "../../src/core/store.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fixture } from "../helpers.ts";
import { sessionActivation } from "../../src/core/activation.ts";
import { leaveSession } from "../../src/core/sessions.ts";

type Prompt = Parameters<Plugin.Context["session"]["prompt"]>[0];
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "OpenCode adapter timed out");
    await delay(10);
  }
}

async function harness(t: TestContext, prompt: (input: Prompt, signal?: AbortSignal) => Promise<void>, nonGit = false) {
  let finish = async () => {};
  t.after(() => finish());
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let onPrompt!: (event: {
    sessionID: string;
    prompt?: { text: string };
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  let disposeHook = async () => {};
  let wake = Promise.withResolvers<void>();
  const events: { type: "session.deleted"; data: { sessionID: string }; handled(): void }[] = [];
  let created = 1;
  const locations = new Map<string, { location: { directory: string }; parentID?: string }>();
  const context = {
    location: { directory: nonGit ? f.root : f.b },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return { time: { created }, ...(locations.get(sessionID) ?? { location: { directory: f.b } }) };
      },
      async hook(name: string, handler: typeof onPrompt) {
        assert.equal(name, "prompt");
        onPrompt = handler;
        return {
          async dispose() {
            await disposeHook();
          },
        };
      },
      async prompt(input: Prompt, options: { signal?: AbortSignal }) {
        await onPrompt({ sessionID: input.sessionID, metadata: input.metadata });
        await prompt(input, options.signal);
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          while (events.length) {
            const event = events.shift()!;
            yield event;
            event.handled();
          }
          const current = wake;
          const stop = () => current.resolve();
          signal.addEventListener("abort", stop, { once: true });
          try {
            if (!signal.aborted) await current.promise;
          } finally {
            signal.removeEventListener("abort", stop);
            if (wake === current) wake = Promise.withResolvers<void>();
          }
        }
      },
    },
  };
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await cleanup();
    }
  };
  finish = close;
  const id = "ses_receiver";
  const repo = await repository(f.b);
  const keyFor = (session = id) =>
    sessionKey(
      repo,
      { adapter: "opencode", session, instance: hash([resolve(process.env.XDG_DATA_HOME || homedir()), created]) },
      "refs/heads/main",
    );
  return {
    ...f,
    id,
    repo,
    get key() {
      return keyFor();
    },
    keyFor,
    locations,
    session: context.session,
    hookRegistered: () => Boolean(onPrompt),
    setDispose: (dispose: () => Promise<void>) => {
      disposeHook = dispose;
    },
    enroll: (sessionID = id, metadata?: Prompt["metadata"], text = "Enable GitRelay") =>
      onPrompt({ sessionID, metadata, prompt: { text } }),
    tick: () => t.mock.timers.tick(5000),
    close,
    recreateWithoutEvent() {
      created++;
    },
    removed(sessionID = id) {
      created++;
      const done = Promise.withResolvers<void>();
      events.push({ type: "session.deleted", data: { sessionID }, handled: done.resolve });
      wake.resolve();
      wake = Promise.withResolvers<void>();
      return done.promise;
    },
    async unlocked() {
      return !(await stat(join(repo.directory, "sessions", `${keyFor()}.lock`)).catch(() => undefined));
    },
  };
}

test("OpenCode v2 queues durable input, wakes idle sessions and does not recursively enroll", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll(f.id, { source: "worktree-relay" });
  await f.enroll(f.id, { source: "git-relay" });
  assert.equal((await listSessions(f.b)).length, 0);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await f.enroll();
  assert.equal(calls.length, 0);
  await f.commit(f.main, "shared.txt", "upstream\n");
  f.tick();
  await waitFor(async () => calls.length === 1 && (await f.unlocked()));
  assert.equal(calls[0].sessionID, f.id);
  assert.equal(calls[0].delivery, "queue");
  assert.match(calls[0].text!, /shared.txt/);
  assert.deepEqual(calls[0].metadata, { source: "git-relay" });
  assert.equal((await listSessions(f.b)).length, 1);
  const lastSeen = (await listSessions(f.b))[0].lastSeen;
  f.tick();
  await waitFor(async () => (await listSessions(f.b))[0].lastSeen !== lastSeen && (await f.unlocked()));
  assert.equal(calls.length, 1);
});

test("OpenCode v2 retries failed admission and acknowledges only durable acceptance", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warnings.push(message);
  });
  let attempts = 0;
  const failAdmission = Promise.withResolvers<void>();
  t.after(() => failAdmission.resolve());
  const f = await harness(t, async () => {
    if (++attempts === 1) {
      await failAdmission.promise;
      throw new Error("admission failed");
    }
  });
  await f.enroll();
  const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "retry" });
  f.tick();
  await waitFor(async () => attempts === 1);
  assert.equal(await readReceipt(f.repo, f.key, event.id), undefined);
  // A timer tick during an active admission is intentionally ignored.
  f.tick();
  assert.equal(attempts, 1);
  failAdmission.resolve();
  await waitFor(async () => {
    f.tick();
    return (await readReceipt(f.repo, f.key, event.id))?.status === "delivered";
  });
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
});

test("OpenCode preserves each accepted receipt when a later admission fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const attempts: Prompt[] = [];
  const f = await harness(t, async (input) => {
    attempts.push(input);
    if (attempts.length === 2) throw new Error("second admission failed");
  });
  await f.enroll();
  const first = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "first event" });
  const second = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "second event" });
  await writeFile(
    join(f.repo.directory, "events", `${first.id}.json`),
    JSON.stringify({ ...first, createdAt: "2026-01-01T00:00:01.000Z" }),
  );
  await writeFile(
    join(f.repo.directory, "events", `${second.id}.json`),
    JSON.stringify({ ...second, createdAt: "2026-01-01T00:00:02.000Z" }),
  );
  f.tick();
  await waitFor(async () => attempts.length === 2 && (await f.unlocked()));
  assert.equal((await readReceipt(f.repo, f.key, first.id))?.status, "delivered");
  assert.equal(await readReceipt(f.repo, f.key, second.id), undefined);
  f.tick();
  await waitFor(async () => (await readReceipt(f.repo, f.key, second.id))?.status === "delivered");
  assert.equal(attempts.length, 3);
  assert.notEqual(attempts[0].id, attempts[1].id);
  assert.equal(attempts[1].id, attempts[2].id);
});

test("OpenCode retries a lost admission response with the same per-event ID", async (t) => {
  t.mock.method(console, "warn", () => {});
  const attempts: Prompt[] = [];
  const admitted = new Map<string, string>();
  let lost = false;
  const f = await harness(t, async (input) => {
    attempts.push(input);
    const id = input.id ?? `generated-${attempts.length}`;
    if (!admitted.has(id)) admitted.set(id, input.text!);
    if (!lost) {
      lost = true;
      throw new Error("response lost after admission");
    }
  });
  await f.enroll();
  const first = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "first event" });
  f.tick();
  await waitFor(async () => attempts.length === 1 && (await f.unlocked()));
  assert.equal(await readReceipt(f.repo, f.key, first.id), undefined);
  const second = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "second event" });
  await writeFile(
    join(f.repo.directory, "events", `${first.id}.json`),
    JSON.stringify({ ...first, createdAt: "2026-01-01T00:00:01.000Z" }),
  );
  await writeFile(
    join(f.repo.directory, "events", `${second.id}.json`),
    JSON.stringify({ ...second, createdAt: "2026-01-01T00:00:02.000Z" }),
  );
  f.tick();
  // Fair rotation can confirm the new event before retrying the first one.
  await waitFor(async () =>
    (await Promise.all([first.id, second.id].map((id) => readReceipt(f.repo, f.key, id)))).every(
      (receipt) => receipt?.status === "delivered",
    ),
  );
  const retried = attempts.filter((input) => input.text?.includes(first.id));
  const other = attempts.filter((input) => input.text?.includes(second.id));
  assert.equal(retried.length, 2);
  assert.equal(retried[0].id, retried[1].id);
  assert.match(retried[0].id!, /^msg_/);
  assert.notEqual(retried[0].id, other[0].id);
  assert.equal(admitted.size, 2, "the accepted first event is not admitted again");
  assert.equal((await readReceipt(f.repo, f.key, first.id))?.status, "delivered");
});

test("OpenCode reuses message IDs when receipt persistence fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const attempts: Prompt[] = [];
  const admitted = new Set<string>();
  let failReceipt = true;
  let receiptPath = "";
  const f = await harness(t, async (input) => {
    attempts.push(input);
    admitted.add(input.id!);
    if (failReceipt) {
      failReceipt = false;
      await mkdir(receiptPath);
    }
  });
  await f.enroll();
  const first = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "first" });
  await delay(5);
  const second = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "second" });
  receiptPath = join(f.repo.directory, "receipts", f.key, `${second.id}.json`);
  f.tick();
  await waitFor(async () => attempts.length === 2 && (await f.unlocked()));
  assert.equal((await readReceipt(f.repo, f.key, first.id))?.status, "delivered");
  await rm(receiptPath, { recursive: true });
  f.tick();
  await waitFor(async () => (await readReceipt(f.repo, f.key, second.id))?.status === "delivered");
  assert.equal(attempts.length, 3);
  assert.equal(attempts[1].id, attempts[2].id);
  assert.equal(admitted.size, 2);
  assert.equal((await readReceipt(f.repo, f.key, first.id))?.status, "delivered");
});

test("OpenCode uses different message IDs for different receiving sessions", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll("one");
  await f.enroll("two");
  const event = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "broadcast" });
  f.tick();
  await waitFor(async () =>
    (await Promise.all(["one", "two"].map((session) => readReceipt(f.repo, f.keyFor(session), event.id)))).every(
      (receipt) => receipt?.status === "delivered",
    ),
  );
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
});

test("OpenCode v2 deletion aborts in-flight admission without acknowledging it", async (t) => {
  let attempts = 0;
  const f = await harness(t, async (_input, signal) => {
    attempts++;
    await new Promise<void>((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
    );
  });
  await f.enroll();
  const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "cancel" });
  f.tick();
  await waitFor(async () => attempts === 1);
  f.removed();
  await waitFor(f.unlocked);
  assert.equal(await readReceipt(f.repo, f.key, event.id), undefined);
  f.tick();
  assert.equal(attempts, 1);
});

test("OpenCode v2 lookup failures warn and retry without failing the user's prompt", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warnings.push(message);
  });
  const f = await harness(t, async () => {
    assert.fail("lookup failed");
  });
  const lookup = t.mock.method(f.session, "get", async () => {
    throw new Error("Session.NotFoundError");
  });
  await assert.doesNotReject(f.enroll());
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /Session.NotFoundError/);
  assert.equal((await listSessions(f.b)).length, 0);
  f.tick();
  assert.equal(lookup.mock.callCount(), 2);
  await delay(0);
  lookup.mock.restore();
  await f.enroll();
  assert.equal((await listSessions(f.b)).length, 1, "a transient lookup failure remains retryable");
});

test("OpenCode v2 deletion during lookup cannot enroll or poll a ghost session", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warnings.push(message);
  });
  const f = await harness(t, async () => {
    assert.fail("deleted session");
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalGet = f.session.get;
  let nativeDeleted = false;
  const lookup = t.mock.method(f.session, "get", async (input: { sessionID: string }) => {
    if (nativeDeleted) throw new Error("Session.NotFoundError");
    entered.resolve();
    await release.promise;
    return originalGet(input);
  });
  const enrolling = f.enroll();
  await entered.promise;
  await f.removed();
  release.resolve();
  await enrolling;
  nativeDeleted = true;
  await f.enroll(); // A late prompt rechecks the host, which reports the deleted ID missing.
  f.tick();
  f.tick();
  assert.equal(lookup.mock.callCount(), 3);
  await delay(0);
  assert.equal((await listSessions(f.b)).length, 0);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /Session.NotFoundError/);
});

test("OpenCode rechecks a recreated session even when it reuses a deleted ID", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll();
  await f.removed();
  await f.enroll();
  const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "recreated session" });
  f.tick();
  await waitFor(async () => calls.some((input) => input.text?.includes(event.id)));
  assert.equal(calls.filter((input) => input.text?.includes(event.id)).length, 1);
});

test("OpenCode enables a recreated session on the first prompt without a deletion event", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll();
  const oldKey = f.key;
  f.recreateWithoutEvent();
  await f.enroll();
  assert.notEqual(f.key, oldKey);
  assert.ok((await listSessions(f.b)).some((session) => session.key === f.key));
  const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "new instance" });
  f.tick();
  await waitFor(async () => (await readReceipt(f.repo, f.key, event.id))?.status === "delivered");
  assert.equal(calls.length, 1);
});

test("OpenCode retries a recreated session when its enable lookup fails", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(message));
  const f = await harness(t, async () => {});
  await f.enroll();
  f.recreateWithoutEvent();
  const lookup = t.mock.method(f.session, "get", async () => {
    throw new Error("transient lookup failure");
  });
  await f.enroll();
  assert.match(String(warnings[0]), /transient lookup failure/);
  lookup.mock.restore();
  f.tick();
  await waitFor(async () => (await listSessions(f.b)).some((session) => session.key === f.key));
});

test("a disable during enable's delivery drain does not re-enable the session", async (t) => {
  const started = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const f = await harness(t, async (_input, signal) => {
    signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await release.promise;
  });
  await f.enroll();
  await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "in flight" });
  f.tick();
  await started.promise;
  const enabling = f.enroll();
  await aborted.promise;
  const disabling = f.enroll(f.id, undefined, "Disable GitRelay");
  release.resolve();
  await Promise.all([enabling, disabling]);
  assert.ok((await listSessions(f.b))[0].closedAt);
});

test("OpenCode must not deliver an old inbox to a recreated session with the same ID", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll();
  const old = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "unread for the old session" });
  const oldKey = f.key;
  await f.removed();
  await f.enroll(); // The host has created a different session with the same native ID.
  const before = (await listSessions(f.b)).find((session) => session.key === f.key)!.lastSeen;
  await delay(5);
  f.tick();
  await waitFor(
    async () =>
      (await listSessions(f.b)).find((session) => session.key === f.key)!.lastSeen !== before && (await f.unlocked()),
  );
  assert.equal(
    await readReceipt(f.repo, oldKey, old.id),
    undefined,
    "the old event must not be acknowledged by the replacement",
  );
  assert.equal(
    calls.some((input) => input.text?.includes(old.id)),
    false,
    "the replacement must not receive the old event",
  );
});

test("OpenCode invalidates an old lookup without blocking a recreated session", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = f.session.get;
  let queries = 0;
  t.mock.method(f.session, "get", async (input: { sessionID: string }) => {
    if (++queries === 1) {
      entered.resolve();
      await release.promise;
    }
    return original(input);
  });
  const oldPrompt = f.enroll();
  try {
    await entered.promise;
    await f.removed();
    await f.enroll(); // The host now exposes a recreated session with the same ID.
    release.resolve();
    await oldPrompt;
    assert.equal((await listSessions(f.b)).length, 1);
    const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "new incarnation" });
    f.tick();
    await waitFor(async () => (await readReceipt(f.repo, f.key, event.id))?.status === "delivered");
    assert.equal(calls.filter((input) => input.text?.includes(event.id)).length, 1);
  } finally {
    release.resolve();
    await oldPrompt;
  }
});

test("OpenCode does not retain unrelated deleted session IDs", async (t) => {
  const f = await fixture(t);
  const module = pathToFileURL(join(process.cwd(), "src/adapters/opencode/index.ts")).href;
  const script = `
    import assert from "node:assert/strict";
    const { default: plugin } = await import(${JSON.stringify(module)});
    const start = Promise.withResolvers(), done = Promise.withResolvers();
    let hook;
    const ctx = { location: { directory: ${JSON.stringify(f.b)} }, session: { get: async () => ({ location: { directory: ${JSON.stringify(f.b)} }, time: { created: 1 } }), hook: async (_name, handler) => { hook = handler; return { dispose: async () => {} }; } }, event: { async *subscribe({ signal }) {
      await start.promise;
      for (let i = 0; i < 100000; i++) yield { type: "session.deleted", data: { sessionID: 'foreign-' + i + '-' + 'x'.repeat(90) } };
      done.resolve();
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    } } };
    const cleanup = await plugin.setup(ctx);
    await hook({sessionID: "receiver", prompt: {text: "Enable GitRelay"}});
    global.gc(); const before = process.memoryUsage().heapUsed;
    start.resolve(); await done.promise; global.gc(); const growth = process.memoryUsage().heapUsed - before;
    await cleanup();
    assert.ok(growth < 8 * 1024 * 1024, 'retained heap growth: ' + growth);
  `;
  execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "-e", script], {
    env: process.env,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
});

test("OpenCode simultaneous first prompts cannot leave a deleted session registered", async (t) => {
  const f = await harness(t, async () => {
    assert.fail("deleted session");
  });
  const bothInitial = Promise.withResolvers<void>();
  const releaseInitial = Promise.withResolvers<void>();
  const scanning = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const releaseScan = Promise.withResolvers<void>();
  const originalGet = f.session.get;
  let calls = 0;
  t.mock.method(f.session, "get", async (input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
    const call = ++calls;
    if (call <= 2) {
      if (call === 2) bothInitial.resolve();
      await releaseInitial.promise;
    } else {
      scanning.resolve();
      options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      await releaseScan.promise;
    }
    return originalGet(input);
  });
  const prompts = [f.enroll(), f.enroll()];
  await bothInitial.promise;
  releaseInitial.resolve();
  await scanning.promise;
  const removed = f.removed();
  await aborted.promise;
  releaseScan.resolve();
  await Promise.all([...prompts, removed]);
  f.tick();
  assert.equal(calls, 3);
  assert.equal((await listSessions(f.b)).length, 0);
});

for (const ending of ["error", "end"] as const) {
  test(`OpenCode resubscribes after the event stream ${ending}`, async (t) => {
    const f = await fixture(t),
      release = Promise.withResolvers<void>(),
      observed = Promise.withResolvers<void>();
    let onPrompt!: (event: { sessionID: string; prompt?: { text: string } }) => Promise<void>,
      subscriptions = 0,
      lookups = 0,
      nativeDeleted = false;
    t.mock.method(console, "warn", () => {});
    const context = {
      location: { directory: f.b },
      session: {
        get: async () => {
          lookups++;
          if (nativeDeleted) throw new Error("Session.NotFoundError");
          return { location: { directory: f.b }, time: { created: 1 } };
        },
        hook: async (_name: string, handler: typeof onPrompt) => {
          onPrompt = handler;
          return { dispose: async () => {} };
        },
        prompt: async () => {},
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          if (++subscriptions === 1) {
            await release.promise;
            if (ending === "error") throw new Error("stream disconnected");
            return;
          }
          nativeDeleted = true;
          yield { type: "session.deleted", data: { sessionID: "resubscribe" } };
          observed.resolve();
          if (!signal.aborted)
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
    };
    const cleanup = await plugin.setup(context as unknown as Plugin.Context);
    try {
      await onPrompt({ sessionID: "resubscribe", prompt: { text: "Enable GitRelay" } });
      release.resolve();
      await delay(100);
      assert.equal(subscriptions, 1, "reconnection does not spin immediately");
      await observed.promise;
      assert.equal(subscriptions, 2);
      const before = lookups;
      await onPrompt({ sessionID: "resubscribe", prompt: { text: "Enable GitRelay" } });
      assert.equal(lookups, before + 1, "a later prompt rechecks the host after deletion");
      assert.equal(
        (await listSessions(f.b))[0]?.closedAt,
        undefined,
        "deletion does not yet close the persisted subscription",
      );
    } finally {
      release.resolve();
      await cleanup();
    }
  });
}

test("OpenCode backs off repeated event-stream failures and cleanup interrupts the wait", async (t) => {
  const f = await fixture(t);
  let subscriptions = 0;
  let hook!: (event: any) => Promise<void>;
  t.mock.method(console, "warn", () => {});
  const context = {
    location: { directory: f.b },
    session: {
      get: async () => ({ location: { directory: f.b }, time: { created: 1 } }),
      hook: async (_name: string, handler: typeof hook) => {
        hook = handler;
        return { dispose: async () => {} };
      },
    },
    event: {
      async *subscribe() {
        subscriptions++;
        throw new Error("offline");
      },
    },
  };
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);
  assert.equal(subscriptions, 0);
  await hook({ sessionID: "enabled", prompt: { text: "Enable GitRelay" } });
  await delay(100);
  assert.equal(subscriptions, 1);
  await waitFor(async () => subscriptions >= 2);
  assert.equal(subscriptions, 2);
  await delay(100);
  assert.equal(subscriptions, 2);
  await Promise.race([
    cleanup(),
    delay(1000).then(() => {
      throw new Error("cleanup waited for backoff");
    }),
  ]);
  await delay(100);
  assert.equal(subscriptions, 2);
});

test("OpenCode polling isolates a stalled session and cancels it on cleanup", async (t) => {
  const calls: string[] = [];
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const f = await harness(t, async (input, signal) => {
    calls.push(input.sessionID);
    if (input.sessionID === "hung") {
      started.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            reject(signal!.reason);
          },
          { once: true },
        ),
      );
    }
  });
  await f.enroll("hung");
  await f.enroll("healthy");
  const event = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "independent polling" });
  f.tick();
  const healthyKey = f.keyFor("healthy");
  await waitFor(async () => (await readReceipt(f.repo, healthyKey, event.id))?.status === "delivered");
  await started.promise;
  f.tick();
  f.tick();
  assert.equal(calls.filter((id) => id === "hung").length, 1);
  assert.equal(calls.filter((id) => id === "healthy").length, 1);
  const hungKey = f.keyFor("hung");
  assert.equal(await readReceipt(f.repo, hungKey, event.id), undefined);
  await f.close();
  await stopped.promise;
  assert.equal(await readReceipt(f.repo, hungKey, event.id), undefined);
});

test("OpenCode handles other deletions while an aborted host call is still running", async (t) => {
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const firstAborted = Promise.withResolvers<void>();
  const secondAborted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const f = await harness(t, async (input, signal) => {
    if (input.sessionID === "first") {
      signal!.addEventListener("abort", () => firstAborted.resolve(), { once: true });
      firstStarted.resolve();
      await releaseFirst.promise; // Model a host call that ignores abort.
    } else {
      signal!.addEventListener("abort", () => secondAborted.resolve(), { once: true });
      secondStarted.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
    }
  });
  try {
    await f.enroll("first");
    await f.enroll("second");
    const event = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "deletion isolation" });
    f.tick();
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    const firstRemoved = f.removed("first");
    await firstAborted.promise;
    const secondRemoved = f.removed("second");
    await Promise.race([
      secondAborted.promise,
      delay(1000).then(() => {
        throw new Error("second deletion was blocked");
      }),
    ]);
    await Promise.all([firstRemoved, secondRemoved]);
    const firstKey = f.keyFor("first");
    assert.equal(await readReceipt(f.repo, firstKey, event.id), undefined);
    let closed = false;
    const closing = f.close().then(() => {
      closed = true;
    });
    await delay(20);
    assert.equal(closed, false, "cleanup waits for the removed session's in-flight call");
    releaseFirst.resolve();
    await closing;
    assert.equal(await readReceipt(f.repo, firstKey, event.id), undefined);
  } finally {
    releaseFirst.resolve();
  }
});

test("OpenCode aborts an in-flight hook before waiting for disposal", async (t) => {
  const f = await harness(t, async () => {
    assert.fail("no notifications");
  });
  const scanning = Promise.withResolvers<void>();
  const originalGet = f.session.get;
  let count = 0;
  t.mock.method(f.session, "get", async (input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
    if (++count === 2) {
      scanning.resolve();
      await new Promise<void>((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }),
      );
    }
    return originalGet(input);
  });
  const enrolling = f.enroll();
  await scanning.promise;
  f.setDispose(async () => {
    await enrolling;
  });
  await Promise.race([
    f.close(),
    delay(1000).then(() => {
      throw new Error("disposal waited on a scan that was not aborted");
    }),
  ]);
  assert.equal((await listSessions(f.b)).length, 0);
});

test("OpenCode polling delivers each broadcast to all ten sessions without overlapping session scans", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  const ids = Array.from({ length: 10 }, (_, index) => `ses_${index}`);
  await Promise.all(ids.map((id) => f.enroll(id)));
  for (let round = 0; round < 3; round++) {
    const event = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: `round ${round}` });
    f.tick();
    f.tick(); // A slow scan must not launch a second scan for the same session.
    await waitFor(async () =>
      (await Promise.all(ids.map((id) => readReceipt(f.repo, f.keyFor(id), event.id)))).every(
        (receipt) => receipt?.status === "delivered",
      ),
    );
    for (const id of ids)
      assert.equal(calls.filter((input) => input.sessionID === id && input.text?.includes(event.id)).length, 1);
  }
});

test("OpenCode does not persist a subscription outside a Git repository", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warnings.push(message);
  });
  const f = await harness(
    t,
    async () => {
      assert.fail("non-Git location");
    },
    true,
  );
  assert.equal(f.hookRegistered(), true);
  f.tick();
  f.tick();
  assert.deepEqual(await listSessions(f.b), []);
  assert.equal(warnings.length, 0);
});

test("OpenCode v2 does not enroll child sessions or sessions in other directories", async (t) => {
  const f = await harness(t, async () => {
    assert.fail("unrelated session");
  });
  f.locations.set("child", { location: { directory: f.b }, parentID: "parent" });
  f.locations.set("foreign", { location: { directory: f.c } });
  await f.enroll("child");
  await f.enroll("foreign");
  assert.equal((await listSessions(f.b)).length, 0);
});

test("OpenCode rejects incomplete native identity and can retry with valid metadata", async (t) => {
  const f = await harness(t, async () => {
    assert.fail("no pending messages");
  });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warnings.push(String(message));
  });
  const mocked = t.mock.method(f.session, "get", async () => ({ location: { directory: f.b } }) as any);
  await f.enroll();
  assert.deepEqual(await listSessions(f.b), []);
  assert.ok(warnings.some((message) => message.includes("creation time")));
  mocked.mock.restore();
  await f.enroll();
  assert.equal((await listSessions(f.b)).length, 1);
});
test("OpenCode waits for an active scan when hook disposal fails", async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await harness(t, async (_input, signal) => {
    started.resolve();
    await release.promise;
    signal?.throwIfAborted();
  });
  try {
    await f.enroll();
    await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "held" });
    f.tick();
    await started.promise;
    assert.equal(await f.unlocked(), false);
    f.setDispose(async () => {
      throw new Error("host unregister failed");
    });
    let settled = false;
    const closing = f.close().catch((error) => {
      settled = true;
      throw error;
    });
    await delay(40);
    assert.equal(settled, false, "cleanup must wait for held scanner");
    release.resolve();
    await assert.rejects(closing, /host unregister failed/);
    assert.equal(await f.unlocked(), true);
  } finally {
    release.resolve();
    await waitFor(f.unlocked);
  }
});

for (const mode of ["sync", "async"] as const) {
  test(`OpenCode preserves ${mode} disposal failures while awaiting failed work`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setInterval"] });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const trigger = Promise.withResolvers<void>();
    const warned = Promise.withResolvers<void>();
    let onPrompt!: (event: {
      sessionID: string;
      prompt?: { text: string };
      metadata?: Record<string, unknown>;
    }) => Promise<void>;
    const context = {
      location: { directory: f.b },
      session: {
        get: async () => ({ location: { directory: f.b }, time: { created: 1 } }),
        hook: async (_name: string, handler: typeof onPrompt) => {
          onPrompt = handler;
          return {
            dispose: () => {
              if (mode === "sync") throw new Error("original disposal failure");
              return Promise.reject(new Error("original disposal failure"));
            },
          };
        },
        prompt: async (_input: Prompt, options: { signal?: AbortSignal }) => {
          started.resolve();
          await release.promise;
          options.signal?.throwIfAborted();
        },
      },
      event: {
        async *subscribe() {
          await trigger.promise;
          throw new Error("stream failure");
        },
      },
    };
    t.mock.method(console, "warn", () => {
      warned.resolve();
      throw new Error("reporter failure");
    });
    const cleanup = await plugin.setup(context as unknown as Plugin.Context);
    const repo = await repository(f.b);
    const id = "ses_shutdown",
      key = sessionKey(
        repo,
        { adapter: "opencode", session: id, instance: hash([resolve(process.env.XDG_DATA_HOME || homedir()), 1]) },
        "refs/heads/main",
      );
    try {
      await onPrompt({ sessionID: id, prompt: { text: "Enable GitRelay" } });
      await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "held" });
      t.mock.timers.tick(5000);
      await started.promise;
      trigger.resolve();
      await warned.promise;
      let settled = false;
      const closing = cleanup().catch((e) => {
        settled = true;
        throw e;
      });
      await delay(40);
      assert.equal(settled, false);
      assert.ok(await stat(join(repo.directory, "sessions", `${key}.lock`)));
      release.resolve();
      await assert.rejects(closing, /original disposal failure/);
      assert.equal(await stat(join(repo.directory, "sessions", `${key}.lock`)).catch(() => undefined), undefined);
    } finally {
      release.resolve();
    }
  });
}

test("OpenCode ordinary prompts stay off and activation is scoped to a native session", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll(f.id, undefined, "Fix this bug");
  await f.enroll("other", undefined, "Explain parallel development");
  f.tick();
  assert.deepEqual(await listSessions(f.b), []);
  await f.enroll(f.id, undefined, "请用多个工作树开发");
  await f.enroll("other", undefined, "Fix this bug");
  assert.deepEqual(
    (await listSessions(f.b)).map((session) => session.session),
    [f.id],
  );
  const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "enabled session only" });
  f.tick();
  await waitFor(async () => (await readReceipt(f.repo, f.key, event.id))?.status === "delivered");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionID, f.id);
});

test("OpenCode opt-out drains delivery, preserves unread events and permits an explicit rejoin", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll();
  const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "preserve unread" });
  await f.enroll(f.id, undefined, "Disable GitRelay");
  f.tick();
  assert.equal(calls.length, 0);
  assert.equal(await readReceipt(f.repo, f.key, event.id), undefined);
  assert.ok((await listSessions(f.b))[0].closedAt);
  await f.enroll(f.id, undefined, "Fix another bug");
  f.tick();
  assert.equal(calls.length, 0);
  await f.enroll();
  f.tick();
  await waitFor(async () => (await readReceipt(f.repo, f.key, event.id))?.status === "delivered");
  assert.equal(calls.length, 1);
});

test("OpenCode retries closing a subscription after a transient session lookup failure", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(message));
  const f = await harness(t, async () => {});
  await f.enroll();
  const lookup = t.mock.method(f.session, "get", async () => {
    throw new Error("transient lookup failure");
  });
  await f.enroll(f.id, undefined, "Disable GitRelay");
  assert.match(String(warnings[0]), /transient lookup failure/);
  assert.equal((await listSessions(f.b))[0].closedAt, undefined);
  lookup.mock.restore();
  await f.enroll(f.id, undefined, "Disable GitRelay");
  assert.ok((await listSessions(f.b))[0].closedAt);
  const message = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "after disable" });
  assert.ok(!message.recipients.includes(f.key));
});

test("OpenCode disable outside a repository is a no-op", async (t) => {
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(message));
  const f = await harness(t, async () => {}, true);
  f.locations.set(f.id, { location: { directory: f.root } });
  await f.enroll(f.id, undefined, "Disable GitRelay");
  assert.deepEqual(warnings, []);
  assert.deepEqual(await listSessions(f.b), []);
});

test("OpenCode can re-enable after a CLI leave before its next polling tick", async (t) => {
  const calls: Prompt[] = [];
  const f = await harness(t, async (input) => {
    calls.push(input);
  });
  await f.enroll();
  const identity = (await listSessions(f.b))[0];
  const options = {
    cwd: f.b,
    ref: identity.ref,
    adapter: identity.adapter,
    session: identity.session,
    instance: identity.instance,
  };
  await sessionActivation(options, false);
  await leaveSession(options);
  await f.enroll();
  const event = await sendMessage({ cwd: f.a, adapter: "codex", session: "sender", text: "enabled again" });
  f.tick();
  await waitFor(async () => (await readReceipt(f.repo, f.key, event.id))?.status === "delivered");
  assert.equal(calls.length, 1);
});
