import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { messagePayloadWithinLimit, sendMessage } from "../../src/core/mailbox.ts";

const cli = join(process.cwd(), "src", "cli", "main.ts");
const unix = { skip: process.platform === "win32", timeout: 20_000 };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gitrelay-status-broadcast-"));
  const children = new Map<ChildProcess, Promise<void>>();
  t.after(async () => {
    for (const [child, closed] of children) {
      child.kill("SIGTERM");
      child.stdout?.destroy();
      child.stderr?.destroy();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await closed;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home"),
    template = join(root, "template"),
    repo = join(root, "repo"),
    bin = join(root, "bin");
  for (const dir of [home, template, bin]) await mkdir(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  execFileSync("git", ["init", "--template", template, "-b", "main", repo], { env, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    { env, stdio: "ignore" },
  );
  function track(child: ChildProcess) {
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => {
        children.delete(child);
        resolve();
      }),
    );
    children.set(child, closed);
  }
  return { root, repo, bin, env, track };
}

async function until(predicate: () => boolean, timeout = 12_000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for status output");
    await delay(20);
  }
}

function launch(f: Awaited<ReturnType<typeof fixture>>, args: string[], env: NodeJS.ProcessEnv, preload?: string) {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      ...(preload ? ["--import", preload] : []),
      cli,
      ...args,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  f.track(child);
  let stdout = "",
    stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (data) => {
    stdout += data;
  });
  child.stderr!.on("data", (data) => {
    stderr += data;
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

test("status watch displays oversized GitHub errors without claiming a broadcast", unix, async (t) => {
  const f = await fixture(t),
    marker = join(f.root, "first-api"),
    gh = join(f.bin, "gh");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    gh,
    `#!/bin/sh\nif [ "$1" = repo ] && [ ! -e ${quote(marker)} ]; then printf '%s\\n' '{"nameWithOwner":"test/project","url":"https://github.com/test/project"}'; exit 0; fi\nif [ "$1" = api ]; then : > ${quote(marker)}; printf '%s\\n' '[[]]'; exit 0; fi\nexec ${quote(process.execPath)} -e 'process.stderr.write("X".repeat(70000)); process.exitCode=1'\n`,
  );
  await chmod(gh, 0o755);
  const p = launch(
    f,
    ["status", "--cwd", f.repo, "--github", "--watch", "--interval-ms", "5000", "--session", "monitor"],
    { ...f.env, PATH: `${f.bin}${delimiter}${f.env.PATH ?? ""}`, WORKTREE_SYNC_STATE_DIR: join(f.root, "state") },
  );
  await until(() => p.stderr().includes("was not broadcast"));
  const lines = p
    .stdout()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].github.error, `GitHub CLI: ${"X".repeat(70000)}`);
  assert.match(p.stderr(), /status snapshot exceeds.*was not broadcast/);
  p.child.kill("SIGTERM");
  assert.deepEqual(await p.done, { code: 0, signal: null });
});

test("message payload limit counts UTF-8 and JSON escaping", unix, async (t) => {
  const f = await fixture(t),
    old = process.env.WORKTREE_SYNC_STATE_DIR;
  t.after(() => {
    if (old === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
    else process.env.WORKTREE_SYNC_STATE_DIR = old;
  });
  process.env.WORKTREE_SYNC_STATE_DIR = join(f.root, "state");
  const suffix = '"é',
    base = Buffer.byteLength(JSON.stringify({ text: "", files: [] }));
  const suffixSize = Buffer.byteLength(JSON.stringify({ text: suffix, files: [] })) - base;
  const text = "x".repeat(65536 - base - suffixSize) + suffix;
  assert.equal(Buffer.byteLength(JSON.stringify({ text, files: [] })), 65536);
  assert.equal(messagePayloadWithinLimit(text, []), true);
  assert.ok((await sendMessage({ cwd: f.repo, adapter: "test", session: "boundary", text })).id);
  assert.equal(messagePayloadWithinLimit(text + "x", []), false);
  await assert.rejects(
    sendMessage({ cwd: f.repo, adapter: "test", session: "boundary", text: text + "x" }),
    /Serialized message text and files must be at most 64 KiB/,
  );
  const ascii = "x".repeat(65536 - base);
  assert.equal(messagePayloadWithinLimit(ascii, []), true);
  assert.ok((await sendMessage({ cwd: f.repo, adapter: "test", session: "boundary", text: ascii })).id);
  await assert.rejects(
    sendMessage({ cwd: f.repo, adapter: "test", session: "boundary", text: ascii + "x" }),
    /Serialized message text and files must be at most 64 KiB/,
  );
  await assert.rejects(
    sendMessage({ cwd: f.repo, adapter: "test", session: "boundary", text: "hello", files: ["../invalid"] }),
    /Message files must be repository-relative paths/,
  );
});

test("status watch shows a failed broadcast once and does not retry the same snapshot", unix, async (t) => {
  const f = await fixture(t);
  const p = launch(f, ["status", "--cwd", f.repo, "--watch", "--interval-ms", "50", "--session", "monitor"], {
    ...f.env,
    WORKTREE_SYNC_STATE_DIR: "relative-state",
  });
  await until(() => p.stdout().includes("\n"));
  await writeFile(join(f.repo, "local.txt"), "edit\n");
  await until(() => p.stderr().includes("this snapshot will not be retried"));
  await delay(300);
  const lines = p
    .stdout()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.worktree.dirty),
    [false, true],
  );
  assert.equal(p.stderr().split("status broadcast failed").length - 1, 1);
  assert.match(p.stderr(), /may have completed/);
  p.child.kill("SIGTERM");
  assert.deepEqual(await p.done, { code: 0, signal: null });
});

test("an error after event publication does not duplicate a snapshot", unix, async (t) => {
  const f = await fixture(t),
    preload = join(f.root, "after-publish.mjs");
  await writeFile(
    preload,
    `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  await rename(from, to);
  if (/\\/events\\/[a-f0-9]{64}\\.json$/.test(String(to))) throw new Error('injected after publish');
};
syncBuiltinESMExports();\n`,
  );
  const env = { ...f.env, WORKTREE_SYNC_STATE_DIR: join(f.root, "state") };
  const p = launch(
    f,
    ["status", "--cwd", f.repo, "--watch", "--interval-ms", "50", "--session", "monitor"],
    env,
    preload,
  );
  await until(() => p.stdout().includes("\n"));
  await writeFile(join(f.repo, "local.txt"), "edit\n");
  await until(() => p.stderr().includes("this snapshot will not be retried"));
  await delay(400);
  const repos = join(f.root, "state", "repos"),
    ids = await readdir(repos, { withFileTypes: true });
  const events = await readdir(join(repos, ids.find((entry) => entry.isDirectory())!.name, "events"));
  assert.equal(events.filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(p.stdout().trimEnd().split("\n").length, 2);
  assert.match(p.stderr(), /may have completed/);
  p.child.kill("SIGTERM");
  assert.deepEqual(await p.done, { code: 0, signal: null });
});

test("stdout EPIPE reports an uncertain completed broadcast", unix, async (t) => {
  const f = await fixture(t);
  const p = launch(f, ["status", "--cwd", f.repo, "--watch", "--interval-ms", "50", "--session", "monitor"], {
    ...f.env,
    WORKTREE_SYNC_STATE_DIR: join(f.root, "state"),
  });
  await until(() => p.stdout().includes("\n"));
  p.child.stdout!.destroy();
  await writeFile(join(f.repo, "local.txt"), "edit\n");
  assert.deepEqual(await p.done, { code: 1, signal: null });
  assert.match(p.stderr(), /status output failed; the broadcast may have completed/);
  const repos = join(f.root, "state", "repos"),
    ids = await readdir(repos, { withFileTypes: true });
  const events = await readdir(join(repos, ids.find((entry) => entry.isDirectory())!.name, "events"));
  assert.equal(events.filter((name) => name.endsWith(".json")).length, 1);
});

test("stdout EPIPE exits even if stderr has a full pipe", unix, async (t) => {
  const f = await fixture(t),
    preload = join(f.root, "fill-stderr.mjs");
  await writeFile(preload, `process.stderr.write('X'.repeat(200000));\n`);
  const env = { ...f.env, WORKTREE_SYNC_STATE_DIR: "relative-state" };
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--import",
      preload,
      cli,
      "status",
      "--cwd",
      f.repo,
      "--watch",
      "--interval-ms",
      "50",
      "--session",
      "monitor",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  f.track(child);
  let output = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (data) => {
    output += data;
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await until(() => output.includes("\n"));
  child.stdout!.destroy();
  await writeFile(join(f.repo, "local.txt"), "edit\n");
  const result = await Promise.race([done, delay(4_000, "timeout" as const, { ref: false })]);
  assert.deepEqual(result, { code: 1, signal: null });
});
