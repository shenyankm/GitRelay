import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { consumeMailbox } from "../dist/core/consumer.js";
import { collectRepository } from "../dist/core/cleanup.js";
import { runDaemon } from "../dist/core/daemon.js";
import { daemonStatus } from "../dist/core/daemon-state.js";
import { sessionKey } from "../dist/core/mailbox.js";
import { hash, repository } from "../dist/core/store.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "git-relay-concurrency-bench-"));
const previousState = process.env.WORKTREE_SYNC_STATE_DIR;
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-C",
      temporary,
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const json = (path, value) => writeFile(path, JSON.stringify(value));
const rounded = (value) => Math.round(value * 10) / 10;
try {
  git("init", "-b", "main");
  await writeFile(join(temporary, "shared.txt"), "base\n");
  git("add", "shared.txt");
  git("commit", "-m", "baseline");
  console.log(
    JSON.stringify({
      node: process.version,
      git: git("--version"),
      events: 1000,
      samples: 3,
      workload: "independent CLI processes in one worktree; process startup included; setup excluded; warm caches",
    }),
  );
  for (const count of [1, 4, 8]) {
    process.env.WORKTREE_SYNC_STATE_DIR = join(temporary, `state-${count}`);
    const repo = await repository(temporary);
    const sessions = [];
    for (let i = 0; i < count; i++) {
      const options = {
        cwd: temporary,
        ref: "refs/heads/main",
        adapter: "benchmark",
        session: `receiver-${i}`,
        async deliver() {
          assert.fail("initial poll must be empty");
        },
      };
      await consumeMailbox(options);
      sessions.push({ options, key: sessionKey(repo, options, options.ref) });
    }
    const ids = [];
    const at = new Date().toISOString();
    const recipients = sessions.map(({ key }) => key);
    for (let i = 0; i < 1000; i++) {
      const id = hash(["concurrency-benchmark", i]);
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
    const poll = async (expected = sessions.map(() => []), allowBusy = false) => {
      const start = performance.now();
      const results = await Promise.allSettled(
        sessions.map(async ({ options }, index) => {
          const { stdout } = await exec(
            process.execPath,
            [cli, "check", "--cwd", temporary, "--agent", options.adapter, "--session", options.session],
            { timeout: 30_000 },
          );
          const received = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line).eventId);
          if (!allowBusy || received.length) assert.deepEqual(received.sort(), [...expected[index]].sort());
          return received;
        }),
      );
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return { elapsedMs: rounded(performance.now() - start), delivered: results.map((result) => result.value) };
    };
    for (const daemon of [false, true]) {
      const abort = new AbortController();
      let running;
      try {
        if (daemon) {
          const ready = Promise.withResolvers();
          running = runDaemon({
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
            intervalMs: 60_000,
            onEvent(event) {
              if (event.type === "daemon.error") ready.reject(new Error(event.message));
              if (event.type === "daemon.cleanup") ready.resolve();
            },
          });
          running.catch(ready.reject);
          await Promise.race([
            ready.promise,
            running.then(() => {
              throw new Error("daemon stopped before ready");
            }),
          ]);
        }
        const rounds = [];
        for (let i = 0; i < 3; i++) rounds.push((await poll()).elapsedMs);
        const unread = ids.slice(-8);
        for (const key of recipients)
          for (const id of unread) await rm(join(repo.directory, "receipts", key, `${id}.json`));
        const recoveryMs = (await poll(sessions.map(() => unread))).elapsedMs;
        await poll();
        for (const key of recipients)
          for (const id of unread)
            assert.equal(
              JSON.parse(await readFile(join(repo.directory, "receipts", key, `${id}.json`), "utf8")).status,
              "delivered",
            );
        const start = performance.now();
        const contention = await Promise.allSettled([collectRepository(repo, { apply: true }), poll()]);
        for (const result of contention) if (result.status === "rejected") throw result.reason;
        const report = contention[0].value;
        assert.deepEqual(report.removed, []);
        assert.equal(report.kept.length, ids.length);
        assert(report.kept.every(({ reason }) => reason === "retention" || reason === "busy"));
        const gcAndPollMs = rounded(performance.now() - start);
        assert.equal((await daemonStatus()).running, daemon);
        console.log(
          JSON.stringify({
            processes: count,
            daemon,
            idleRoundsMs: rounds,
            medianIdleMs: [...rounds].sort((a, b) => a - b)[1],
            recoverEightPerProcessMs: recoveryMs,
            gcAndPollMs,
            gcBusy: report.kept.filter(({ reason }) => reason === "busy").length,
          }),
        );
      } finally {
        abort.abort();
        await running;
      }
    }
    const unread = ids.slice(-8);
    for (const key of recipients)
      for (const id of unread) await rm(join(repo.directory, "receipts", key, `${id}.json`));
    const deleting = await Promise.allSettled([
      collectRepository(repo, { apply: true, retentionDays: 0 }),
      poll(
        sessions.map(() => unread),
        true,
      ),
    ]);
    for (const result of deleting) if (result.status === "rejected") throw result.reason;
    const delivered = deleting[1].value.delivered;
    await poll(delivered.map((received) => unread.filter((id) => !received.includes(id))));
    await poll();
    await collectRepository(repo, { apply: true, retentionDays: 0 });
    assert.deepEqual(await readdir(join(repo.directory, "events")), []);
    assert.deepEqual(await readdir(join(repo.directory, "trash")), []);
    for (const key of recipients)
      assert.deepEqual(
        (await readdir(join(repo.directory, "receipts", key))).filter((name) => name !== "delivery-cursor.json"),
        [],
      );
    console.log(
      JSON.stringify({
        processes: count,
        concurrentDeletionVerified: true,
        skippedFirstPoll: delivered.filter((received) => !received.length).length,
      }),
    );
  }
} finally {
  if (previousState === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
  else process.env.WORKTREE_SYNC_STATE_DIR = previousState;
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
