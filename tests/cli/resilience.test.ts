import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { hash, readJson, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const exec = promisify(execFile);
const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { timeout: 10_000 });
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, "CLI condition timed out");
    await delay(10);
  }
}

for (const command of ["gc", "send", "join", "leave"]) {
  test(`${command} handles SIGINT while holding publish.lock and releases every acquired lock`, async (t) => {
    const f = await fixture(t);
    const identity = ["--cwd", f.b, "--session", "B"];
    await run("check", ...identity);
    const repo = await repository(f.b);
    const key = sessionKey(repo, { adapter: "cli", session: "B" }, "refs/heads/main");
    const args =
      command === "gc"
        ? [command, "--cwd", f.b, "--apply", "--retention-days", "0"]
        : [command, ...identity, ...(command === "send" ? ["--message", "cancel before publication"] : [])];
    const script = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const open = fs.open;
      fs.open = async (...args) => {
        const file = await open(...args);
        if (String(args[0]).endsWith("publish.lock")) {
          const write = file.writeFile.bind(file);
          file.writeFile = async (...args) => {
            await write(...args);
            process.stderr.write("publish-lock-held\\n");
            await new Promise((resolve) => setTimeout(resolve, 500));
          };
        }
        return file;
      };
      syncBuiltinESMExports();
      process.argv = ${JSON.stringify([process.execPath, ...args])};
      await import(${JSON.stringify(pathToFileURL(cli).href)});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.stdout.resume();
    try {
      // A controlled delay in the real FileHandle write makes the signal timing deterministic.
      await waitFor(() => stderr.includes("publish-lock-held"));
      assert.equal(((await readJson(join(repo.directory, "publish.lock"))) as { pid: number }).pid, child.pid);
      child.kill("SIGINT");
      await delay(20);
      child.kill("SIGINT");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        assert.equal(await exited, 130, stderr);
        assert.match(stderr, /may have completed.*before retrying/i);
      } finally {
        clearTimeout(force);
      }
      assert.equal(await readJson(join(repo.directory, "publish.lock")), undefined);
      assert.equal(await readJson(join(repo.directory, "sessions", `${key}.lock`)), undefined);
      await run("check", ...identity);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}

test("interrupted send after publication reports an unknown outcome", async (t) => {
  const f = await fixture(t);
  const args = ["--cwd", f.b, "--session", "B"];
  await run("check", ...args);
  const repo = await repository(f.b);
  const script = `
    process.stdout.write = () => { process.stderr.write("output-blocked\\n"); setInterval(() => {}, 1000); return false; };
    process.argv = ${JSON.stringify([process.execPath, "send", "--cwd", f.a, "--session", "sender", "--message", "published before output"])};
    await import(${JSON.stringify(pathToFileURL(cli).href)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  try {
    await waitFor(() => stderr.includes("output-blocked"));
    const events = await Promise.all(
      (await readdir(join(repo.directory, "events"))).map((name) => readJson(join(repo.directory, "events", name))),
    );
    assert.ok(events.some((event) => (event as { text?: string })?.text === "published before output"));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      assert.equal(await exited, 143, stderr);
      assert.match(stderr, /may have completed.*before retrying/i);
    } finally {
      clearTimeout(force);
    }
    assert.equal(await readJson(join(repo.directory, "publish.lock")), undefined);
    assert.match((await run("check", ...args)).stdout, /published before output/);
    assert.equal((await run("check", ...args)).stdout, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

for (const command of ["check", "watch"]) {
  test(`${command} cancels a real full stdout pipe without acknowledging or leaving a session lock`, async (t) => {
    const f = await fixture(t);
    const args = ["--cwd", f.b, "--session", "B"];
    await run("check", ...args);
    const repo = await repository(f.b);
    const key = sessionKey(repo, { adapter: "cli", session: "B" }, "refs/heads/main");
    const event = await sendMessage({
      cwd: f.a,
      adapter: "cli",
      session: "one-off",
      text: "retry after blocked output",
    });
    // A large, valid recipient snapshot makes one real NDJSON record exceed the OS pipe buffer.
    await writeJson(join(repo.directory, "events", `${event.id}.json`), {
      ...event,
      recipients: [...event.recipients, ...Array.from({ length: 10_000 }, (_, index) => hash(index))],
    });
    const child = spawn(process.execPath, [cli, command, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    try {
      await waitFor(async () =>
        Boolean(await stat(join(repo.directory, "sessions", `${key}.lock`)).catch(() => undefined)),
      );
      await delay(200); // Do not read stdout: the callback must still be blocked.
      assert.ok(await stat(join(repo.directory, "sessions", `${key}.lock`)));
      assert.equal(await readReceipt(repo, key, event.id), undefined);
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        assert.equal(await exited, command === "check" ? 143 : 0, stderr);
      } finally {
        clearTimeout(force);
      }
      assert.equal(await readJson(join(repo.directory, "sessions", `${key}.lock`)), undefined);
      assert.equal(await readJson(join(repo.directory, "publish.lock")), undefined);
      assert.equal(await readReceipt(repo, key, event.id), undefined);
      assert.equal(JSON.parse((await run("check", ...args)).stdout).eventId, event.id);
      assert.equal((await run("check", ...args)).stdout, "");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdout.destroy();
      await exited;
    }
  });
}

test("watch exits on a closed stdout pipe without acknowledging the event", async (t) => {
  const f = await fixture(t);
  const args = ["--cwd", f.b, "--session", "B"];
  await run("check", ...args);
  const event = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "unread" });
  const repo = await repository(f.b);
  const key = sessionKey(repo, { adapter: "cli", session: "B" }, "refs/heads/main");
  const child = spawn(process.execPath, [cli, "watch", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    assert.equal(await exited, 1, stderr);
    assert.match(stderr, /EPIPE|closed|destroyed/i);
    assert.equal(await readReceipt(repo, key, event.id), undefined);
    assert.equal(await readJson(join(repo.directory, "sessions", `${key}.lock`)), undefined);
  } finally {
    clearTimeout(force);
  }
});

for (const command of ["check", "watch"]) {
  test(`${command} acknowledges a complete record before a later pipe failure`, async (t) => {
    const f = await fixture(t);
    const args = ["--cwd", f.b, "--session", "B"];
    await run("check", ...args);
    const repo = await repository(f.b);
    const key = sessionKey(repo, { adapter: "cli", session: "B" }, "refs/heads/main");
    const first = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "first record" });
    const second = await sendMessage({
      cwd: f.a,
      adapter: "test",
      session: "sender",
      text: `second record ${"x".repeat(59_000)}`,
    });
    await writeJson(join(repo.directory, "events", `${first.id}.json`), {
      ...first,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await writeJson(join(repo.directory, "events", `${second.id}.json`), {
      ...second,
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    // Wait for the reader to close before the second write; OS pipe capacity is not fixed.
    const script = `
      const write = process.stdout.write.bind(process.stdout);
      let writes = 0;
      process.stdout.write = (...args) => {
        if (++writes !== 2) return write(...args);
        process.stdin.once("data", () => write(...args));
        return false;
      };
      process.argv = ${JSON.stringify([process.execPath, command, ...args])};
      await import(${JSON.stringify(pathToFileURL(cli).href)});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let stdout = "",
      stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.stdin.on("error", () => {});
    child.stdout.once("close", () => child.stdin.end("reader closed\n"));
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.includes("\n")) child.stdout.destroy();
    });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      assert.equal(await exited, 1, stderr);
      assert.equal(JSON.parse(stdout.split("\n")[0]).eventId, first.id);
      assert.equal((await readReceipt(repo, key, first.id))?.status, "delivered");
      assert.equal(await readReceipt(repo, key, second.id), undefined);
      const retry = (await run("check", ...args)).stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).eventId);
      assert.deepEqual(retry, [second.id]);
      assert.equal((await run("check", ...args)).stdout, "");
    } finally {
      clearTimeout(force);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdout.destroy();
      await exited;
    }
  });
}

test("interrupting an actual 5000-event GC scan does not strand publish.lock", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f.b);
  for (let offset = 0; offset < 5000; offset += 128) {
    await Promise.all(
      Array.from({ length: Math.min(128, 5000 - offset) }, (_, index) => {
        const id = hash(["gc-scan", offset + index]);
        return writeFile(
          join(repo.directory, "events", `${id}.json`),
          JSON.stringify({
            id,
            kind: "message",
            createdAt: new Date().toISOString(),
            sender: { adapter: "test", session: "seed", root: f.a },
            recipients: [],
            text: "scan fixture",
            files: [],
          }),
        );
      }),
    );
  }
  const child = spawn(process.execPath, [cli, "gc", "--cwd", f.b, "--apply", "--retention-days", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.stdout.resume();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  try {
    await waitFor(
      async () =>
        ((await readJson(join(repo.directory, "publish.lock")).catch(() => undefined)) as { pid?: number } | undefined)
          ?.pid === child.pid,
    );
    await delay(20);
    assert.ok(await stat(join(repo.directory, "publish.lock")));
    child.kill("SIGINT");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      assert.equal(await exited, 130, stderr);
    } finally {
      clearTimeout(force);
    }
    assert.equal(await readJson(join(repo.directory, "publish.lock")), undefined);
    assert.ok((await readdir(join(repo.directory, "events"))).length > 0);
    await run("gc", "--cwd", f.b, "--dry-run", "--retention-days", "0");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

test("large Write-tool hooks deliver normally; oversized input fails open without consuming events", async (t) => {
  const f = await fixture(t);
  const input = { hook_event_name: "UserPromptSubmit", prompt: "Enable GitRelay", session_id: "S", cwd: f.b };
  async function hook(value: object) {
    const result = run("hook", "codex");
    result.child.stdin!.end(JSON.stringify(value));
    return result;
  }
  await hook(input);
  const repo = await repository(f.b);
  const key = sessionKey(repo, { adapter: "codex", session: "S" }, "refs/heads/main");
  const first = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "large hook note" });
  const large = await hook({
    ...input,
    hook_event_name: "PostToolUse",
    tool_input: { content: "x".repeat(1100 * 1024) },
  });
  assert.match(large.stdout, /large hook note/);
  assert.equal((await readReceipt(repo, key, first.id))?.status, "delivered");
  const second = await sendMessage({ cwd: f.a, adapter: "cli", session: "sender", text: "retain oversized hook note" });
  const oversized = await hook({
    ...input,
    hook_event_name: "PostToolUse",
    tool_input: { content: "x".repeat(17 * 1024 * 1024) },
  });
  assert.deepEqual(JSON.parse(oversized.stdout), {});
  assert.match(oversized.stderr, /16 MiB.*next hook/i);
  assert.equal(await readReceipt(repo, key, second.id), undefined);
  assert.match((await hook({ ...input, hook_event_name: "PostToolUse" })).stdout, /retain oversized hook note/);
  const nonGit = await hook({ ...input, cwd: f.root });
  assert.deepEqual(JSON.parse(nonGit.stdout), {});
  assert.equal(nonGit.stderr, "");
});
