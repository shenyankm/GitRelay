import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { eventsIn, publishUpstream, sessionKey, type Notification } from "../../src/core/mailbox.ts";
import { readRef, synchronizeRef } from "../../src/core/publisher.ts";
import { hash, stateDirectory, withLock, writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";

async function interruptedPublication(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "local edit");
  const received: Notification[] = [];
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "b",
    async deliver(batch: Notification[]) {
      received.push(...batch);
    },
  };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const key = sessionKey(repo, receiver, ref);
  const first = await f.commit(f.main, "shared.txt", "first");
  // Recreate an older state in which the subscriber received an event before
  // an interrupted publisher committed its cursor.
  const token = hash("daemon"),
    now = new Date().toISOString();
  await writeJson(join(stateDirectory(), "daemon.lock"), { pid: process.pid, token });
  await writeJson(join(stateDirectory(), "daemon.json"), {
    pid: process.pid,
    token,
    intervalMs: 5000,
    heartbeatAt: now,
  });
  const refPath = join(repo.directory, "refs", `${hash(ref)}.json`);
  const priorCursor = { ...(await readRef(repo, ref)), daemonToken: token };
  await writeJson(refPath, priorCursor);
  const pending = await withLock(join(repo.directory, "publish.lock"), () =>
    publishUpstream(repo, receiver, ref, f.initial, first, [key]),
  );
  await consumeMailbox(receiver);
  assert.equal(received.length, 1);
  await writeJson(refPath, priorCursor); // Restore the historical interrupted state, including its receipt.
  const second = await f.commit(f.main, "shared.txt", "second");
  return { repo, receiver, received, pending, first, second, root: f.root };
}

async function assertRecovered(state: Awaited<ReturnType<typeof interruptedPublication>>) {
  const { repo, receiver, received, pending, first, second } = state;
  await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, ref, receiver));
  await consumeMailbox(receiver);
  await consumeMailbox(receiver);
  assert.equal((await readRef(repo, ref))?.commit, second);
  assert.equal(received.length, 2);
  assert.equal(received[0].event.id, pending.id);
  assert.equal(received[1].event.kind, "upstream");
  if (received[1].event.kind !== "upstream") throw new Error("Expected upstream event");
  assert.equal(received[1].event.previous, first);
  assert.equal(received[1].event.commit, second);
  assert.equal((await eventsIn(repo)).filter((event) => event.kind === "upstream").length, 2);
}

for (const point of ["pending-cursor", "next-event", "next-cursor"] as const) {
  test(`resumes after ${point} is renamed into place`, async (t) => {
    const state = await interruptedPublication(t);
    const original = fs.promises.rename;
    let injected = false;
    const patch = t.mock.method(
      fs.promises,
      "rename",
      async (source: Parameters<typeof original>[0], destination: Parameters<typeof original>[1]) => {
        let value: { previous?: string; commit?: string } | undefined;
        if (
          typeof destination === "string" &&
          (destination.includes(`${sep}refs${sep}`) || destination.includes(`${sep}events${sep}`))
        ) {
          value = JSON.parse(await readFile(source, "utf8"));
        }
        const hit =
          typeof destination === "string" &&
          (point === "pending-cursor"
            ? destination.includes(`${sep}refs${sep}`) && value?.commit === state.first
            : point === "next-event"
              ? destination.includes(`${sep}events${sep}`) &&
                value?.previous === state.first &&
                value.commit === state.second
              : destination.includes(`${sep}refs${sep}`) && value?.commit === state.second);
        await original(source, destination);
        if (hit && !injected) {
          injected = true;
          throw new Error("simulated interruption after rename");
        }
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        withLock(join(state.repo.directory, "publish.lock"), () => synchronizeRef(state.repo, ref, state.receiver)),
        /simulated interruption/,
      );
    } finally {
      patch.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(injected);
    await assertRecovered(state);
  });
}

test(
  "a killed publisher preserves its event and requires explicit stale-lock recovery",
  { timeout: 15_000 },
  async (t) => {
    const state = await interruptedPublication(t);
    const storeUrl = new URL("../../src/core/store.ts", import.meta.url).href;
    const repositoryUrl = new URL("../../src/core/repository.ts", import.meta.url).href;
    const publisherUrl = new URL("../../src/core/publisher.ts", import.meta.url).href;
    const script = `
    import fs from "node:fs";
    import { readFile } from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join, sep } from "node:path";
    import { withLock } from ${JSON.stringify(storeUrl)};
    import { repository } from ${JSON.stringify(repositoryUrl)};
    import { synchronizeRef } from ${JSON.stringify(publisherUrl)};
    const identity = { cwd: process.env.TEST_CWD, ref: ${JSON.stringify(ref)}, adapter: "test", session: "b" };
    const repo = await repository(identity.cwd);
    const original = fs.promises.rename;
    fs.promises.rename = async (source, destination) => {
      let value;
      if (typeof destination === "string" && destination.includes(sep + "events" + sep)) value = JSON.parse(await readFile(source, "utf8"));
      await original(source, destination);
      if (value?.previous === process.env.TEST_PREVIOUS && value?.commit === process.env.TEST_COMMIT) process.kill(process.pid, "SIGKILL");
    };
    syncBuiltinESMExports();
    await withLock(join(repo.directory, "publish.lock"), () => synchronizeRef(repo, identity.ref, identity));
    process.exitCode = 3;
  `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
      env: {
        PATH: process.env.PATH,
        HOME: state.root,
        WORKTREE_SYNC_STATE_DIR: stateDirectory(),
        TEST_CWD: state.receiver.cwd,
        TEST_PREVIOUS: state.first,
        TEST_COMMIT: state.second,
      },
      signal: t.signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, "SIGKILL", stderr);
    const lock = join(state.repo.directory, "publish.lock");
    const contents = await readFile(lock, "utf8");
    assert.equal(JSON.parse(contents).pid, child.pid);
    await assert.rejects(
      withLock(lock, () => synchronizeRef(state.repo, ref, state.receiver)),
      /Stale git-relay lock/,
    );
    assert.equal(await readFile(lock, "utf8"), contents);
    // This lock belongs to the exited test child in fixture's private state dir.
    await rm(lock);
    await assertRecovered(state);
  },
);
