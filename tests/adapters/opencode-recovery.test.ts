import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/adapters/opencode/index.ts";
import { listSessions, sendMessage } from "../../src/core/mailbox.ts";
import { sessionKey } from "../../src/core/mailbox.ts";
import { hash } from "../../src/core/store.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "opencode-recovery-"));
  const repo = join(dir, "repo"),
    template = join(dir, "template"),
    state = join(dir, "state");
  await mkdir(repo);
  await mkdir(template);
  const previous = process.env.WORKTREE_SYNC_STATE_DIR;
  process.env.WORKTREE_SYNC_STATE_DIR = state;
  let cleanup = async () => {};
  t.after(async () => {
    try {
      await cleanup();
    } finally {
      if (previous === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
      else process.env.WORKTREE_SYNC_STATE_DIR = previous;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    repo: await realpath(repo),
    template,
    state,
    setCleanup(close: () => Promise<void>) {
      cleanup = close;
    },
  };
}
function init(repo: string, template: string, git: string) {
  execFileSync(git, ["init", "--template", template, "-b", "main", repo], { stdio: "ignore" });
  execFileSync(
    git,
    [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "test",
    ],
    { stdio: "ignore" },
  );
  return execFileSync(git, ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("OpenCode recovery timed out");
}
function host(root: string) {
  let onPrompt!: (event: { sessionID: string; prompt?: { text: string } }) => Promise<void>;
  const prompts: Array<{ text?: string }> = [];
  const ctx = {
    location: { directory: root },
    session: {
      async hook(_name: string, callback: typeof onPrompt) {
        onPrompt = callback;
        return { async dispose() {} };
      },
      async get() {
        return { location: { directory: root }, time: { created: 1 } };
      },
      async prompt(value: { text?: string }) {
        prompts.push(value);
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  };
  return {
    context: ctx as unknown as Plugin.Context,
    prompt: (id: string, text = "Enable GitRelay") => onPrompt({ sessionID: id, prompt: { text } }),
    prompts,
  };
}

test(
  "OpenCode resumes a registered inbox after temporary Git initialization failure",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
      commit = init(f.repo, f.template, git),
      common = await realpath(join(f.repo, ".git"));
    const identity = "a".repeat(64),
      id = hash([common, identity]),
      target = join(f.state, "repos", id),
      ref = "refs/heads/main";
    await writeFile(join(common, ".git-relay-id"), `${identity}\n`);
    for (const name of ["sessions", "events", "receipts", "refs", "trash"])
      await mkdir(join(target, name), { recursive: true });
    for (const name of ["identity-owner.json", "identity-ready.json"])
      await writeFile(join(target, name), JSON.stringify({ id }));
    await writeFile(join(target, "refs", `${hash(ref)}.json`), JSON.stringify({ ref, commit }));
    const native = {
        adapter: "opencode",
        session: "receiver",
        instance: hash([resolve(process.env.XDG_DATA_HOME || homedir()), 1]),
      },
      key = sessionKey({ root: f.repo }, native, ref),
      now = new Date().toISOString(),
      eventId = "b".repeat(64);
    await writeFile(
      join(target, "sessions", `${key}.json`),
      JSON.stringify({
        ...native,
        root: f.repo,
        ref,
        key,
        createdAt: now,
        lastSeen: now,
        baseline: commit,
        migrated: true,
      }),
    );
    await writeFile(
      join(target, "events", `${eventId}.json`),
      JSON.stringify({
        id: eventId,
        kind: "message",
        createdAt: now,
        sender: { adapter: "cli", session: "sender", root: f.repo },
        recipients: [key],
        text: "RECOVERY_MARKER",
        files: [],
      }),
    );
    const bin = join(f.dir, "bin"),
      mode = join(f.dir, "mode");
    await mkdir(bin);
    await writeFile(mode, "fail");
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$(/bin/cat "$GITRELAY_TEST_MODE")" = fail ]; then printf 'fatal: injected Git failure\\n' >&2; exit 77; fi\nexec "$GITRELAY_TEST_GIT" "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    const previousPath = process.env.PATH,
      previousGit = process.env.GITRELAY_TEST_GIT,
      previousMode = process.env.GITRELAY_TEST_MODE;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.GITRELAY_TEST_GIT = git;
    process.env.GITRELAY_TEST_MODE = mode;
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousGit === undefined) delete process.env.GITRELAY_TEST_GIT;
      else process.env.GITRELAY_TEST_GIT = previousGit;
      if (previousMode === undefined) delete process.env.GITRELAY_TEST_MODE;
      else process.env.GITRELAY_TEST_MODE = previousMode;
    });
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => {
      warnings.push(message);
    });
    t.mock.timers.enable({ apis: ["setInterval"] });
    let monotonic = performance.now();
    t.mock.method(performance, "now", () => monotonic);
    const h = host(f.repo),
      cleanup = await plugin.setup(h.context);
    f.setCleanup(cleanup);
    await h.prompt("receiver");
    assert.equal(h.prompts.length, 0);
    assert.equal(warnings.length, 1);
    await writeFile(mode, "ok");
    monotonic += 5000;
    t.mock.timers.tick(5000);
    await until(async () => h.prompts.length === 1);
    assert.match(h.prompts[0].text!, /RECOVERY_MARKER/);
    await until(async () => {
      try {
        return (
          JSON.parse(await readFile(join(target, "receipts", key, `${eventId}.json`), "utf8")).status === "delivered"
        );
      } catch {
        return false;
      }
    });
  },
);

test(
  "OpenCode registers after a non-Git directory becomes a repository",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
      warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => {
      warnings.push(message);
    });
    t.mock.timers.enable({ apis: ["setInterval"] });
    let monotonic = performance.now();
    t.mock.method(performance, "now", () => monotonic);
    const h = host(f.repo),
      cleanup = await plugin.setup(h.context);
    f.setCleanup(cleanup);
    await h.prompt("new");
    assert.equal(warnings.length, 1);
    init(f.repo, f.template, git);
    monotonic += 5000;
    t.mock.timers.tick(5000);
    const common = await realpath(join(f.repo, ".git")),
      key = sessionKey(
        { root: f.repo },
        { adapter: "opencode", session: "new", instance: hash([resolve(process.env.XDG_DATA_HOME || homedir()), 1]) },
        "refs/heads/main",
      );
    await until(async () => {
      try {
        const identity = (await readFile(join(common, ".git-relay-id"), "utf8")).trim(),
          id = hash([common, identity]);
        return (
          JSON.parse(await readFile(join(f.state, "repos", id, "sessions", `${key}.json`), "utf8")).session === "new"
        );
      } catch {
        return false;
      }
    });
    assert.equal(h.prompts.length, 0);
  },
);

test("OpenCode resumes existing and new conversations automatically after plugin reload", async (t) => {
  const f = await fixture(t),
    git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  init(f.repo, f.template, git);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const first = host(f.repo),
    closeFirst = await plugin.setup(first.context);
  f.setCleanup(closeFirst);
  await first.prompt("receiver");
  await closeFirst();
  const second = host(f.repo),
    closeSecond = await plugin.setup(second.context);
  f.setCleanup(closeSecond);
  await second.prompt("other", "Fix this bug");
  await second.prompt("receiver", "Continue the existing task");
  const event = await sendMessage({ cwd: f.repo, adapter: "codex", session: "sender", text: "RESUMED_ACTIVATION" });
  const sessions = await listSessions(f.repo);
  assert.deepEqual(sessions.map((session) => session.session).sort(), ["other", "receiver"]);
  assert.ok(event.recipients.length);
  t.mock.timers.tick(5000);
  await until(async () => second.prompts.some((prompt) => prompt.text?.includes("RESUMED_ACTIVATION") === true));
});
