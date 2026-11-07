import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRepository } from "../dist/core/cleanup.js";
import { sessionKey, sessionsIn } from "../dist/core/mailbox.js";
import { hash } from "../dist/core/store.js";
import { repository } from "../dist/core/repository.js";

const temporary = await mkdtemp(join(tmpdir(), "gitbeacon-maintenance-bench-"));
const previousState = process.env.GITBEACON_STATE_DIR;
process.env.GITBEACON_STATE_DIR = join(temporary, "state");
const git = (...args) =>
  execFileSync("git", ["-C", temporary, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (path, value) => writeFile(path, JSON.stringify(value));
const measure = async (run) => {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return Math.round(samples.sort((a, b) => a - b)[1] * 10) / 10;
};
try {
  git("init", "-b", "main");
  const repo = await repository(temporary);
  const at = new Date().toISOString();
  const keys = [];
  console.log(
    JSON.stringify({
      node: process.version,
      git: git("--version"),
      samples: 3,
      recipients: 3,
      workload: "session discovery and retained-event GC; setup excluded; warm filesystem cache",
    }),
  );
  for (const count of [100, 1000]) {
    while (keys.length < count) {
      const identity = { adapter: "benchmark", session: `session-${keys.length}` };
      const key = sessionKey(repo, identity, "refs/heads/main");
      await json(join(repo.directory, "sessions", `${key}.json`), {
        ...identity,
        key,
        root: repo.root,
        ref: "refs/heads/main",
        createdAt: at,
        lastSeen: at,
      });
      keys.push(key);
    }
    const sessionScanMs = await measure(async () =>
      assert.deepEqual((await sessionsIn(repo)).map((session) => session.key).sort(), [...keys].sort()),
    );
    const recipients = keys.slice(0, 3);
    for (const key of recipients) await mkdir(join(repo.directory, "receipts", key), { recursive: true });
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = hash(["maintenance-benchmark", i]);
      ids.push(id);
      await json(join(repo.directory, "events", `${id}.json`), {
        id,
        kind: "message",
        createdAt: at,
        sender: { adapter: "benchmark", session: "sender", root: repo.root },
        recipients,
        text: "benchmark",
        files: [],
      });
      for (const key of recipients)
        await json(join(repo.directory, "receipts", key, `${id}.json`), { eventId: id, status: "delivered", at });
    }
    const retainedGcMs = await measure(async () => {
      const report = await collectRepository(repo, { apply: true });
      assert.deepEqual(report.removed, []);
      assert.deepEqual(report.eligible, []);
      assert.deepEqual(report.kept.map(({ id }) => id).sort(), [...ids].sort());
      assert(report.kept.every(({ reason }) => reason === "retention"));
    });
    await rm(join(repo.directory, "receipts", recipients[0], `${ids[0]}.json`));
    const report = await collectRepository(repo, { apply: true, retentionDays: 0 });
    assert.deepEqual(report.kept, [{ id: ids[0], reason: "unconfirmed" }]);
    assert.deepEqual(report.removed.sort(), ids.slice(1).sort());
    assert.deepEqual(await readdir(join(repo.directory, "events")), [`${ids[0]}.json`]);
    await json(join(repo.directory, "receipts", recipients[0], `${ids[0]}.json`), {
      eventId: ids[0],
      status: "delivered",
      at,
    });
    assert.deepEqual((await collectRepository(repo, { apply: true, retentionDays: 0 })).removed, [ids[0]]);
    assert.deepEqual(await readdir(join(repo.directory, "events")), []);
    assert.deepEqual(await readdir(join(repo.directory, "trash")), []);
    for (const key of recipients) assert.deepEqual(await readdir(join(repo.directory, "receipts", key)), []);
    console.log(JSON.stringify({ sessions: count, events: count, sessionScanMs, retainedGcMs }));
  }
} finally {
  if (previousState === undefined) delete process.env.GITBEACON_STATE_DIR;
  else process.env.GITBEACON_STATE_DIR = previousState;
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
