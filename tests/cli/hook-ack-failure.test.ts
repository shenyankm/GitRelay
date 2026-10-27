import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionActivation } from "../../src/core/activation.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

for (const mode of [
  "first-receipt",
  "second-receipt",
  "interrupt-after-output-int",
  "interrupt-after-output-term",
  "interrupt-before-output",
  "output-error",
]) {
  test(`Codex hook preserves delivery on ${mode}`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t),
      ref = "refs/heads/main",
      receiver = { cwd: f.b, ref, adapter: "codex", session: "receiver" };
    await sessionActivation(receiver, true);
    await consumeMailbox({ ...receiver, async deliver() {} });
    const messages = await Promise.all(
      ["first message", "second message"].map((text) =>
        sendMessage({ cwd: f.a, adapter: "test", session: "sender", text }),
      ),
    );
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref),
      preload = join(f.root, "inject.mjs");
    await writeFile(
      preload,
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
let count = 0;
fs.renameSync = (from, to) => {
  if (/\\/receipts\\/[a-f0-9]{64}\\/[a-f0-9]{64}\\.json$/.test(String(to))) {
    count++;
    if ((process.env.GITRELAY_TEST_MODE === 'first-receipt' && count === 1) ||
        (process.env.GITRELAY_TEST_MODE === 'second-receipt' && count === 2))
      throw Object.assign(new Error('injected receipt failure'), { code: 'EACCES' });
  }
  const result = rename(from, to);
  if (count === 1 && process.env.GITRELAY_TEST_MODE?.startsWith('interrupt-after-output'))
    queueMicrotask(() => process.emit(process.env.GITRELAY_TEST_MODE.endsWith('term') ? 'SIGTERM' : 'SIGINT'));
  return result;
};
syncBuiltinESMExports();
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (data, callback) => {
  if (process.env.GITRELAY_TEST_MODE === 'interrupt-before-output') process.emit('SIGINT');
  if (process.env.GITRELAY_TEST_MODE === 'output-error') {
    queueMicrotask(() => callback(Object.assign(new Error('injected output failure'), { code: 'EPIPE' })));
    return true;
  }
  return write(data, callback);
};
`,
    );
    const input = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: receiver.session,
      cwd: f.b,
      prompt: "hello",
    });
    const run = (inject: boolean) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", ...(inject ? ["--import", preload] : []), cli, "hook", "codex"],
        { input, encoding: "utf8", env: { ...process.env, GITRELAY_TEST_MODE: mode } },
      );
    const first = run(true);
    const afterOutput = !["interrupt-before-output", "output-error"].includes(mode);
    assert.equal(first.status, afterOutput ? 0 : mode === "interrupt-before-output" ? 130 : 1, first.stderr);
    if (afterOutput) {
      for (const text of ["first message", "second message"]) assert.match(first.stdout, new RegExp(text));
      assert.match(
        first.stderr,
        mode.startsWith("interrupt-after-output") ? /interrupt|abort/i : /injected receipt failure/,
      );
    }
    const receipts = await Promise.all(messages.map((message) => readReceipt(repo, key, message.id)));
    if (mode === "first-receipt" || !afterOutput) assert.equal(receipts.filter(Boolean).length, 0);
    if (mode === "second-receipt" || mode.startsWith("interrupt-after-output"))
      assert.equal(receipts.filter(Boolean).length, 1);
    const retry = run(false);
    assert.equal(retry.status, 0, retry.stderr);
    for (let i = 0; i < messages.length; i++) {
      assert.equal((await readReceipt(repo, key, messages[i].id))?.status, "delivered");
      if (!receipts[i]) assert.match(retry.stdout, new RegExp(messages[i].text));
    }
  });
}
