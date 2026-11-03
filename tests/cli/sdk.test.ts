import { execFile } from "node:child_process";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { fixture } from "../helpers.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("installed SDK exposes transactions, preserves unread state, and keeps documented legacy imports", async (t) => {
  const f = await fixture(t);
  const installed = join(f.root, "node_modules", "git-relay");
  await mkdir(installed, { recursive: true });
  await cp(join(root, "package.json"), join(installed, "package.json"));
  await cp(join(root, "dist"), join(installed, "dist"), { recursive: true });
  const program = `
    import assert from 'node:assert/strict';
    import * as api from 'git-relay';
    import { consumeMailbox } from 'git-relay/dist/core/consumer.js';
    assert.equal(api.consumeMailbox, consumeMailbox);
    assert.equal(api.registerSession, undefined);
    await assert.rejects(import('git-relay/dist/core/store.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    const receiver = { cwd: ${JSON.stringify(f.b)}, ref: 'refs/heads/main', adapter: 'codex', session: 'receiver' };
    await api.enableSession(receiver);
    const event = await api.sendMessage({ cwd: ${JSON.stringify(f.a)}, adapter: 'cli', session: 'sender', text: 'preserved' });
    await api.disableSession(receiver);
    assert.ok((await api.listSessions(receiver.cwd))[0].closedAt);
    assert.deepEqual(await api.consumeMailbox({ ...receiver, async deliver() { throw new Error('disabled'); } }), []);
    await api.enableSession(receiver);
    const delivered = [];
    await api.consumeMailbox({ ...receiver, async deliver(batch) { delivered.push(...batch); } });
    assert.equal(delivered[0].event.id, event.id);
    await assert.rejects(api.enableSession({ ...receiver, ref: 'refs/heads/missing', session: 'failed' }));
    assert.equal((await api.listSessions(receiver.cwd)).some(session => session.session === 'failed'), false);
    const mutable = { ...receiver, session: 'snapshot' };
    const enabling = api.enableSession(mutable);
    mutable.session = 'wrong';
    await enabling;
    assert.equal((await api.listSessions(receiver.cwd)).some(session => session.session === 'snapshot'), true);
    assert.equal((await api.listSessions(receiver.cwd)).some(session => session.session === 'wrong'), false);
  `;
  await exec(process.execPath, ["--input-type=module", "-e", program], { cwd: f.root });

  // Compile against only the installed declarations, without source files or extension opt-ins.
  const types = join(f.root, "node_modules", "@types");
  await symlink(join(root, "node_modules", "@types"), types, process.platform === "win32" ? "junction" : "dir");
  const consumer = join(f.root, "consumer.mts");
  await writeFile(
    consumer,
    `
    import { consumeMailbox, enableSession, type MailboxOptions, type SessionOptions } from 'git-relay';
    const session: SessionOptions = { cwd: '/repo', ref: 'refs/heads/main', adapter: 'codex', session: 's' };
    const options: MailboxOptions = { ...session, async deliver(batch) { batch[0].event.id.toUpperCase(); } };
    void enableSession(session);
    void consumeMailbox(options);
    // @ts-expect-error A stable session identity is required.
    const invalid: SessionOptions = { cwd: '/repo', ref: 'refs/heads/main', adapter: 'codex' };
    void invalid;
  `,
  );
  await exec(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      consumer,
    ],
    { cwd: f.root },
  );
});
