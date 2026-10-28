import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { eventsIn, readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/store.ts";
import { sessionActivation } from "../../src/core/activation.ts";
import { runHook } from "../../src/adapters/hooks.ts";
import { fixture, git } from "../helpers.ts";

const exec = promisify(execFile),
  cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

test("CLI can explicitly acknowledge a missing blob in the patch stage", async (t) => {
  const f = await fixture(t),
    ref = "refs/heads/main";
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "blob",
    async deliver() {
      return false;
    },
  };
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await consumeMailbox(receiver);
  await f.commit(f.main, "other.txt", "upstream B\n");
  const current = await f.commit(f.main, "shared.txt", "upstream C\n");
  const blob = git(f.main, "rev-parse", `${current}:shared.txt`).trim();
  await rm(join(f.main, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const args = [
    "--experimental-strip-types",
    cli,
    "check",
    "--cwd",
    f.b,
    "--agent",
    receiver.adapter,
    "--session",
    receiver.session,
  ];
  await assert.rejects(exec(process.execPath, args), /could not compare/);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  const events = (await eventsIn(repo)).filter((event) => event.recipients.includes(key));
  assert.ok(events.length);
  for (const event of events) assert.equal(await readReceipt(repo, key, event.id), undefined);
  const { stdout } = await exec(process.execPath, [...args, "--acknowledge-history-gap", "--apply"]);
  assert.ok(
    stdout
      .split("\n")
      .filter(Boolean)
      .every((line) => JSON.parse(line).unavailable === true),
  );
  for (const event of events) assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
});

test("CLI requires explicit consent to acknowledge an unavailable history notification", async (t) => {
  const f = await fixture(t),
    ref = "refs/heads/main";
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "gap",
    async deliver() {
      return false;
    },
  };
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await consumeMailbox(receiver);
  await f.commit(f.main, "shared.txt", "lost\n");
  await consumeMailbox(receiver);
  git(f.main, "reset", "--hard", f.initial);
  git(f.main, "reflog", "expire", "--expire=now", "--all");
  git(f.main, "gc", "--prune=now");
  const args = [
    "--experimental-strip-types",
    cli,
    "check",
    "--cwd",
    f.b,
    "--agent",
    receiver.adapter,
    "--session",
    receiver.session,
  ];
  await assert.rejects(exec(process.execPath, [...args, "--acknowledge-history-gap"]), /requires check --apply/);
  await assert.rejects(exec(process.execPath, args), /could not compare/);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  const events = (await eventsIn(repo)).filter((event) => event.recipients.includes(key));
  for (const event of events) assert.equal(await readReceipt(repo, key, event.id), undefined);
  const { stdout } = await exec(process.execPath, [...args, "--acknowledge-history-gap", "--apply"]);
  assert.ok(
    stdout
      .split("\n")
      .filter(Boolean)
      .every((line) => JSON.parse(line).unavailable === true),
  );
  for (const event of events) assert.equal((await readReceipt(repo, key, event.id))?.status, "delivered");
  assert.equal(git(f.b, "status", "--porcelain").trim(), "M shared.txt");
});

test("Codex hook succeeds after delivering a message while preserving an unreadable history gap", async (t) => {
  const f = await fixture(t),
    ref = "refs/heads/main",
    receiver = {
      cwd: f.b,
      ref,
      adapter: "codex",
      session: "gap",
      async deliver() {
        return false;
      },
    };
  await writeFile(join(f.b, "shared.txt"), "local\n");
  await sessionActivation(receiver, true);
  await consumeMailbox(receiver);
  await f.commit(f.main, "shared.txt", "lost\n");
  await consumeMailbox(receiver);
  git(f.main, "reset", "--hard", f.initial);
  git(f.main, "reflog", "expire", "--expire=now", "--all");
  git(f.main, "gc", "--prune=now");
  await f.commit(f.main, "shared.txt", "new history\n");
  const message = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "independent message" });
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  await assert.rejects(
    runHook(
      { hook_event_name: "UserPromptSubmit", session_id: receiver.session, cwd: f.b, prompt: "hello" },
      ref,
      async () => {
        throw new Error("output failed");
      },
    ),
    /output failed/,
  );
  assert.equal(await readReceipt(repo, key, message.id), undefined);
  const hook = () =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, "hook", "codex"], {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: receiver.session,
        cwd: f.b,
        prompt: "hello",
      }),
      encoding: "utf8",
      env: process.env,
    });
  const first = hook();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /independent message/);
  assert.match(first.stderr, /could not compare/);
  assert.equal((await readReceipt(repo, key, message.id))?.status, "delivered");
  const gap = (await eventsIn(repo)).find((event) => event.kind === "upstream" && event.recipients.includes(key));
  assert.ok(gap);
  assert.equal(await readReceipt(repo, key, gap.id), undefined);
  const second = hook();
  assert.equal(second.status, 1);
  assert.equal(second.stdout, "");
  assert.match(second.stderr, /could not compare/);
  assert.equal(await readReceipt(repo, key, gap.id), undefined);
});
