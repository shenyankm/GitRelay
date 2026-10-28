import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { fixture, git } from "../helpers.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const run = (...args: string[]) => exec(process.execPath, [cli, ...args]);

test("separate CLI processes share messages across coding agents", async (t) => {
  const f = await fixture(t);
  const b = ["check", "--cwd", f.b, "--agent", "codex", "--session", "B"];
  const c = ["check", "--cwd", f.c, "--agent", "opencode", "--session", "C"];
  await run(...b);
  await run(...c);
  const sent = JSON.parse(
    (await run("send", "--cwd", f.a, "--agent", "codex", "--session", "A", "--message", "Cross-process shared message"))
      .stdout,
  );
  assert.equal(sent.recipients, 2);
  for (const args of [b, c]) {
    const received = JSON.parse((await run(...args)).stdout);
    assert.equal(received.type, "worktree.agent-message");
    assert.equal(received.eventId, sent.eventId);
    assert.equal(received.text, "Cross-process shared message");
    assert.equal((await run(...args)).stdout, "");
  }
  assert.equal(JSON.parse((await run("sessions", "--cwd", f.main)).stdout).sessions.length, 2);
});

test("unsupported dry-run options fail before delivering or changing state", async (t) => {
  const f = await fixture(t);
  const receiver = ["--cwd", f.b, "--agent", "codex", "--session", "B"];
  await run("check", ...receiver);
  const sent = JSON.parse((await run("send", "--cwd", f.a, "--session", "A", "--message", "unread")).stdout);
  for (const args of [
    ["check", ...receiver],
    ["watch", ...receiver],
    ["send", "--cwd", f.a, "--session", "A", "--message", "must not send"],
    ["join", ...receiver],
    ["leave", ...receiver],
    ["hook", "codex"],
    ["daemon"],
    ["status", "--cwd", f.b, "--watch"],
  ]) {
    await assert.rejects(run(...args, "--dry-run"), /--dry-run requires install, uninstall or gc/);
  }
  const delivered = JSON.parse((await run("check", ...receiver)).stdout);
  assert.equal(delivered.eventId, sent.eventId);
  assert.equal((await run("check", ...receiver)).stdout, "");
  const sessions = JSON.parse((await run("sessions", "--cwd", f.b)).stdout).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].closedAt, undefined);
  assert.equal(JSON.parse((await run("daemon", "status")).stdout).running, false);
});

test(
  "CLI help, explicit cwd and hooks survive a deleted process cwd",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const cases = [
      { args: ["--help"], expected: /GitRelay/ },
      { args: ["check", "--cwd", f.b, "--session", "deleted-cwd"], expected: /^$/ },
      { args: ["daemon", "status"], expected: /"running":false/ },
      { args: ["hook", "codex"], expected: /^\{\}\s*$/ },
    ];
    for (const [index, { args, expected }] of cases.entries()) {
      const script = `
      import { mkdirSync, rmdirSync } from "node:fs";
      const gone = ${JSON.stringify(join(f.root, "gone-"))} + ${index};
      mkdirSync(gone);
      process.chdir(gone);
      rmdirSync(gone);
      process.argv = ${JSON.stringify([process.execPath, ...args])};
      await import(${JSON.stringify(pathToFileURL(cli).href)});
    `;
      const result = exec(process.execPath, ["--input-type=module", "--eval", script], { timeout: 5000 });
      result.child.stdin!.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "deleted-cwd", cwd: f.b }));
      assert.match((await result).stdout, expected);
    }
  },
);

test("CLI emits portable JSON once, persists its cursor, and rejects invalid invocation", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const args = ["check", "--cwd", f.b, "--session", "CLI-B"];
  assert.equal((await run(...args)).stdout, "");
  await f.commit(f.main, "shared.txt", "upstream\n");
  const result = JSON.parse((await run(...args)).stdout);
  assert.equal(result.type, "worktree.upstream-change");
  assert.deepEqual(result.files, ["shared.txt"]);
  assert.match(result.message, /not been automatically synchronized/);
  assert.equal((await run(...args)).stdout, "");
  await assert.rejects(run("check"), /--session ID/);
  await assert.rejects(run("hook", "unknown"), /Choose hook/);
  assert.match((await run("--help")).stdout, /hook codex/);
});

test("removed clients have no installer or hook entry point", async (t) => {
  await fixture(t);
  for (const platform of ["claude-code", "pi", "cursor"]) {
    await assert.rejects(run("install", "--platform", platform), /Unknown platform/);
    await assert.rejects(run("hook", platform), /Choose hook codex/);
  }
});

test("empty cwd and malformed refs are rejected before touching session state", async (t) => {
  const f = await fixture(t);
  const identity = ["--cwd", f.b, "--agent", "codex", "--session", "s"];
  await run("check", ...identity);
  await assert.rejects(run("check", "--cwd", "", "--session", "s"), /--cwd must not be empty/);
  for (const ref of ["", "main", "refs/heads/bad..name"]) {
    for (const command of ["check", "join", "leave", "send"]) {
      await assert.rejects(
        run(command, ...identity, "--ref", ref, ...(command === "send" ? ["--message", "x"] : [])),
        ref.startsWith("refs/") ? /check-ref-format/ : /full branch ref/,
      );
    }
  }
  await assert.rejects(
    exec(process.execPath, [cli, "leave", ...identity], { env: { ...process.env, WORKTREE_MAIN_REF: "" } }),
    /full branch ref/,
  );
  const sessions = JSON.parse((await run("sessions", "--cwd", f.b)).stdout).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].closedAt, undefined);
  assert.equal((await run("check", ...identity)).stdout, "");
});

test("inactive hooks ignore an invalid configured ref", async (t) => {
  const f = await fixture(t);
  const child = exec(process.execPath, [cli, "hook", "codex"], {
    env: { ...process.env, WORKTREE_MAIN_REF: "main", PATH: join(f.root, "missing-git") },
  });
  child.child.stdin!.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: f.b }));
  assert.deepEqual(JSON.parse((await child).stdout), {});
  const enabled = exec(process.execPath, [cli, "hook", "codex"], {
    env: { ...process.env, WORKTREE_MAIN_REF: "main" },
  });
  enabled.child.stdin!.end(
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: f.b, prompt: "Enable GitRelay" }),
  );
  await assert.rejects(enabled, /full branch ref/);
});

test("leave outside a repository is a no-op while missing worktrees retain their diagnostic", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  assert.deepEqual(JSON.parse((await run("leave", "--cwd", outside, "--agent", "codex", "--session", "s")).stdout), {
    left: false,
  });
  await assert.rejects(
    run("leave", "--cwd", join(f.root, "missing"), "--agent", "codex", "--session", "s"),
    /Cannot uniquely locate the removed worktree subscription/,
  );
  await run("check", "--cwd", f.b, "--agent", "codex", "--session", "s");
  git(f.main, "worktree", "remove", "--force", f.b);
  assert.equal(JSON.parse((await run("leave", "--cwd", f.b, "--agent", "codex", "--session", "s")).stdout).left, true);
});
