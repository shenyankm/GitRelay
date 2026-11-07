import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox, type MailboxOptions } from "../../src/core/consumer.ts";
import { readReceipt, sessionKey, type UpstreamEvent } from "../../src/core/mailbox.ts";
import { writeJson } from "../../src/core/store.ts";
import { type Repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

test("upstream events cannot acknowledge a recipient subscribed to another ref", async (t) => {
  const f = await fixture(t);
  const ref = "refs/heads/main",
    actor = { adapter: "test", session: "receiver" };
  const previous = f.initial,
    commit = await f.commit(f.main, "shared.txt", "upstream\n");
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const base = process.env.GITBEACON_STATE_DIR!;
  await consumeMailbox({ cwd: f.b, ref, ...actor, async deliver() {} });
  const repoId = (await readdir(join(base, "repos"))).find((id) => /^[a-f0-9]{64}$/.test(id));
  assert.ok(repoId);
  const key = sessionKey({ root: f.b }, actor, ref);
  const otherKey = sessionKey({ root: f.b }, { adapter: "test", session: "other" }, "refs/heads/other");
  let count = 0;
  async function scenario(run: (repo: Repository, event: UpstreamEvent) => Promise<void>) {
    const state = join(f.root, `scenario-${++count}`);
    await cp(base, state, { recursive: true, filter: (path) => !path.endsWith(".lock") });
    process.env.GITBEACON_STATE_DIR = state;
    const directory = join(state, "repos", repoId!);
    const repo = { directory } as Repository;
    const event: UpstreamEvent = {
      id: randomBytes(32).toString("hex"),
      kind: "upstream",
      ref: "refs/heads/other",
      previous,
      commit,
      recipients: [key],
      sender: { ...actor, root: f.b },
      createdAt: new Date().toISOString(),
    };
    await run(repo, event);
  }
  const pathFor = (repo: Repository, event: UpstreamEvent) => join(repo.directory, "events", `${event.id}.json`);
  {
    await scenario(async (repo, event) => {
      const path = pathFor(repo, event);
      await writeJson(path, event);
      const before = await readFile(path, "utf8");
      let calls = 0;
      const options: MailboxOptions = {
        cwd: f.b,
        ref,
        ...actor,
        async deliver() {
          calls++;
        },
      };
      await assert.rejects(consumeMailbox(options), /session subscribed to another ref/);
      assert.equal(calls, 0);
      assert.equal(await readReceipt(repo, key, event.id), undefined);
      assert.equal(await readFile(path, "utf8"), before);
    });
  }
  for (const status of ["delivered", "irrelevant"] as const) {
    await scenario(async (repo, event) => {
      await writeJson(pathFor(repo, event), event);
      await mkdir(join(repo.directory, "receipts", key), { recursive: true });
      const path = join(repo.directory, "receipts", key, `${event.id}.json`);
      await writeJson(path, { eventId: event.id, status, at: new Date().toISOString() });
      const before = await readFile(path, "utf8");
      assert.deepEqual(
        await consumeMailbox({
          cwd: f.b,
          ref,
          ...actor,
          async deliver() {
            assert.fail("must not replay");
          },
        }),
        [],
      );
      assert.equal(await readFile(path, "utf8"), before);
    });
  }
  await scenario(async (repo, event) => {
    event.ref = ref;
    await writeJson(pathFor(repo, event), event);
    const delivered: string[] = [];
    await consumeMailbox({
      cwd: f.b,
      ref,
      ...actor,
      async deliver(batch) {
        delivered.push(...batch.map((item) => item.event.id));
      },
    });
    assert.deepEqual(delivered, [event.id]);
  });
  await scenario(async (repo, event) => {
    event.recipients = [otherKey];
    await writeJson(pathFor(repo, event), event);
    const message = {
      id: randomBytes(32).toString("hex"),
      kind: "message",
      text: "hello",
      files: [],
      recipients: [key],
      sender: event.sender,
      createdAt: new Date().toISOString(),
    };
    await writeJson(join(repo.directory, "events", `${message.id}.json`), message);
    const delivered: string[] = [];
    await consumeMailbox({
      cwd: f.b,
      ref,
      ...actor,
      async deliver(batch) {
        delivered.push(...batch.map((item) => item.event.id));
      },
    });
    assert.deepEqual(delivered, [message.id]);
  });
});
