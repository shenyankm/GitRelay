import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/adapters/opencode/index.ts";

type Session = { location: { directory: string }; parentID?: string };
type PendingEvent = { event: { type: "session.deleted"; data: { sessionID: string } }; done: () => void };
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for mock host")), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fixture(
  t: TestContext,
  get: (input: { sessionID: string }) => Promise<Session>,
  verifyDeleted?: (input: { sessionID: string }) => Promise<Session>,
) {
  const dir = await mkdtemp(join(tmpdir(), "gitrelay-oc-get-retry-"));
  const home = join(dir, "home"),
    template = join(dir, "template"),
    repo = join(dir, "repo"),
    config = join(dir, "gitconfig");
  for (const path of [home, template]) await mkdir(path);
  await writeFile(config, "");
  const previous = { ...process.env };
  const isolated = (key: string) =>
    key.startsWith("GIT_") ||
    ["HOME", "PATH", "WORKTREE_SYNC_STATE_DIR", "WORKTREE_SYNC_REPOSITORY_IDS", "WORKTREE_MAIN_REF"].includes(key);
  for (const key of Object.keys(process.env)) if (isolated(key)) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    WORKTREE_SYNC_STATE_DIR: join(dir, "state"),
  });
  let close: (() => Promise<void>) | undefined;
  t.after(async () => {
    let closed = false;
    try {
      if (close) {
        await deadline(close());
        closed = true;
      }
    } finally {
      for (const key of Object.keys(process.env)) if (isolated(key)) delete process.env[key];
      for (const [key, value] of Object.entries(previous)) if (isolated(key)) process.env[key] = value;
      if (closed && !process.env.GITRELAY_KEEP_TEST_FIXTURES) await rm(dir, { recursive: true, force: true });
    }
  });
  execFileSync("git", ["init", "--template", template, repo], { stdio: "ignore", timeout: 5000 });
  execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "ignore", timeout: 5000 });
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { stdio: "ignore", timeout: 5000 },
  );
  const root = await realpath(repo);
  let tick: (() => void) | undefined, hook!: (event: { sessionID: string; prompt?: { text: string } }) => Promise<void>;
  let wake: (() => void) | undefined;
  const queue: PendingEvent[] = [];
  const deletedSessions = new Set<string>();
  t.mock.method(globalThis, "setInterval", ((fn: () => void) => {
    tick = fn;
    return { unref() {} } as unknown as NodeJS.Timeout;
  }) as typeof setInterval);
  t.mock.method(globalThis, "clearInterval", (() => {
    tick = undefined;
  }) as typeof clearInterval);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warnings.push(String(message));
  });
  const context = {
    location: { directory: root },
    session: {
      async hook(_name: string, fn: typeof hook) {
        hook = fn;
        return { async dispose() {} };
      },
      get: async (input: { sessionID: string }) => {
        if (deletedSessions.has(input.sessionID) && verifyDeleted)
          return { ...(await verifyDeleted(input)), time: { created: 1 } };
        if (deletedSessions.has(input.sessionID))
          throw Object.assign(new Error("Session.NotFoundError"), { _tag: "SessionNotFoundError" });
        return { ...(await get(input)), time: { created: 1 } };
      },
      async prompt() {
        throw new Error("Unexpected host prompt");
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        let stopped = signal.aborted;
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            wake?.();
          },
          { once: true },
        );
        while (!stopped) {
          if (!queue.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          wake = undefined;
          if (stopped) return;
          const item = queue.shift()!;
          yield item.event;
          item.done();
        }
      },
    },
  };
  close = await plugin.setup(context as unknown as Plugin.Context);
  return {
    dir,
    root,
    warnings,
    prompt: (id: string) => {
      deletedSessions.delete(id);
      return deadline(hook({ sessionID: id, prompt: { text: "Enable GitRelay" } }));
    },
    tick: () => tick?.(),
    hasTimer: () => Boolean(tick),
    deleted: async (id: string) => {
      deletedSessions.add(id);
      await deadline(
        new Promise<void>((done) => {
          queue.push({ event: { type: "session.deleted", data: { sessionID: id } }, done });
          wake?.();
        }),
      );
      await pause();
    },
  };
}

test(
  "OpenCode retries a transient initial session lookup without a second user prompt",
  { skip: process.platform === "win32" || !existsSync("/usr/bin/git"), timeout: 10000 },
  async (t) => {
    let calls = 0,
      directory = "";
    const f = await fixture(t, async () => {
      if (++calls === 1) throw new Error("transient");
      return { location: { directory } };
    });
    directory = f.root;
    await f.prompt("initial");
    assert.equal(calls, 1);
    assert.equal(f.hasTimer(), true);
    f.tick();
    let registered: string | undefined;
    for (let n = 0; n < 200 && !registered; n++) {
      try {
        const repos = join(f.dir, "state", "repos");
        for (const id of (await readdir(repos)).filter((name) => /^[a-f0-9]{64}$/.test(name))) {
          const sessions = join(repos, id, "sessions");
          for (const name of (await readdir(sessions)).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)))
            registered = JSON.parse(await readFile(join(sessions, name), "utf8")).session;
        }
      } catch {
        /* Registration is still in progress. */
      }
      if (!registered) await pause();
    }
    assert.equal(registered, "initial");
    assert.equal(calls, 3);
  },
);

test(
  "an older out-of-scope lookup cannot clear a newer failed lookup",
  { skip: process.platform === "win32" || !existsSync("/usr/bin/git"), timeout: 10000 },
  async (t) => {
    const held = Promise.withResolvers<Session>();
    let calls = 0;
    const f = await fixture(t, () => {
      calls++;
      return calls === 1
        ? held.promise
        : calls === 2
          ? Promise.reject(new Error("transient"))
          : Promise.resolve({ location: { directory: "/elsewhere" } });
    });
    const older = f.prompt("same"),
      newer = f.prompt("same");
    await newer;
    assert.equal(f.hasTimer(), true);
    held.resolve({ location: { directory: "/elsewhere" } });
    await older;
    assert.equal(f.hasTimer(), true);
    f.tick();
    await pause();
    assert.equal(calls, 3);
    assert.equal(f.hasTimer(), false);
  },
);

test(
  "deleted retry ignores its late result and retains its slot until the host settles",
  { skip: process.platform === "win32" || !existsSync("/usr/bin/git"), timeout: 10000 },
  async (t) => {
    const held = Promise.withResolvers<Session>();
    let calls = 0;
    const f = await fixture(t, () => {
      calls++;
      return calls === 1 || calls === 3
        ? Promise.reject(new Error("transient"))
        : calls === 2
          ? held.promise
          : Promise.resolve({ location: { directory: "/elsewhere" } });
    });
    await f.prompt("same");
    f.tick();
    await pause();
    assert.equal(calls, 2);
    await f.deleted("same");
    assert.equal(f.hasTimer(), false);
    await f.prompt("same");
    assert.equal(calls, 3);
    f.tick();
    await pause();
    assert.equal(calls, 3);
    held.resolve({ location: { directory: f.root } });
    await pause();
    f.tick();
    await pause();
    assert.equal(calls, 4);
    assert.equal(f.hasTimer(), false);
  },
);

test(
  "OpenCode bounds retained retry candidates and unfinished host calls",
  { skip: process.platform === "win32" || !existsSync("/usr/bin/git"), timeout: 10000 },
  async (t) => {
    const counts = new Map<string, number>();
    const held = new Map<string, PromiseWithResolvers<Session>>();
    let started = 0;
    const f = await fixture(t, ({ sessionID }) => {
      const count = (counts.get(sessionID) ?? 0) + 1;
      counts.set(sessionID, count);
      if (count === 1) return Promise.reject(new Error("transient"));
      started++;
      const pending = Promise.withResolvers<Session>();
      held.set(sessionID, pending);
      return pending.promise;
    });
    for (let n = 0; n < 129; n++) await f.prompt(`id-${n}`);
    assert.ok(f.warnings.some((message) => message.includes("Too many pending")));
    for (let n = 0; n < 16; n++) {
      const before = started;
      f.tick();
      await pause();
      assert.equal(started - before, 8);
    }
    assert.equal(started, 128);
    assert.equal(counts.get("id-128"), undefined);
    held.get("id-0")!.resolve({ location: { directory: "/elsewhere" } });
    await pause();
    f.tick();
    await pause();
    assert.equal(counts.get("id-128"), undefined);
    for (let n = 0; n < 128; n++) await f.deleted(`id-${n}`);
    await f.prompt("new-id");
    f.tick();
    await pause();
    assert.equal(started, 129);
    await f.deleted("new-id");
    await f.prompt("another-id");
    f.tick();
    await pause();
    assert.equal(started, 129);
  },
);

test(
  "OpenCode bounds concurrent deletion verification lookups",
  { skip: process.platform === "win32" || !existsSync("/usr/bin/git"), timeout: 10000 },
  async (t) => {
    let directory = "";
    const held: PromiseWithResolvers<Session>[] = [];
    const f = await fixture(
      t,
      ({ sessionID }) =>
        sessionID === "active" ? Promise.resolve({ location: { directory } }) : Promise.reject(new Error("transient")),
      () => {
        const pending = Promise.withResolvers<Session>();
        held.push(pending);
        return pending.promise;
      },
    );
    t.after(() => held.forEach((pending) => pending.resolve({ location: { directory } })));
    directory = f.root;
    await f.prompt("active");
    for (let n = 0; n < 128; n++) await f.prompt(`retry-${n}`);
    for (let n = 0; n < 128; n++) await f.deleted(`retry-${n}`);
    assert.equal(held.length, 128);
    await f.deleted("active");
    assert.equal(held.length, 128);
    assert.ok(f.warnings.some((message) => message.includes("Too many pending OpenCode deletion checks")));
  },
);
