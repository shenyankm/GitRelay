import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

test("persistent per-session checkpoints deduplicate, resume and retry failed delivery", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  let delivered = 0;
  let fail = false;
  const options = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "one",
    async deliver() {
      if (fail) throw new Error("offline");
      delivered++;
    },
  };
  await consumeMailbox(options);
  assert.equal(delivered, 0);
  await f.commit(f.main, "shared.txt", "upstream 1\n");
  fail = true;
  await assert.rejects(consumeMailbox(options), /offline/);
  fail = false;
  await consumeMailbox(options);
  await consumeMailbox({ ...options });
  assert.equal(delivered, 1);
  await consumeMailbox({ ...options, session: "two" }); // New conversations start at the current main.
  await f.commit(f.main, "shared.txt", "upstream 2\n");
  await consumeMailbox(options);
  await consumeMailbox({ ...options, session: "two" });
  assert.equal(delivered, 3);
  await assert.rejects(consumeMailbox({ ...options, session: "" }), /session ID/);
});

test("abandoned locks are reported without deleting another process's state", async (t) => {
  const f = await fixture(t);
  const options = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "stale", async deliver() {} };
  await consumeMailbox(options);
  const directory = join((await repository(f.b)).directory, "sessions");
  const cursor = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
  await writeFile(join(directory, cursor.replace(/\.json$/, ".lock")), JSON.stringify({ pid: 2_000_000_000 }));
  await assert.rejects(consumeMailbox(options), /Stale gitbeacon lock/);
  assert.ok((await readdir(directory)).includes(cursor));
});

test("concurrent checks on one session do not double-deliver", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "B local\n");
  let delivered = 0;
  const options = {
    cwd: f.b,
    ref: "refs/heads/main",
    adapter: "test",
    session: "concurrent",
    async deliver() {
      delivered++;
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  };
  await consumeMailbox(options);
  await f.commit(f.main, "shared.txt", "new\n");
  await Promise.all([consumeMailbox(options), consumeMailbox(options)]);
  assert.equal(delivered, 1);
});
