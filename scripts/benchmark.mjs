import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { consumeMailbox } from "../dist/core/consumer.js";
import { runDaemon } from "../dist/core/daemon.js";
import { daemonStatus } from "../dist/core/daemon-state.js";
import { sessionKey } from "../dist/core/mailbox.js";
import { hash } from "../dist/core/store.js";
import { repository } from "../dist/core/repository.js";

const [baseline, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, "Usage: node scripts/benchmark.mjs [baseline-dist-directory]");
const variants = {
  ...(baseline
    ? { baseline: (await import(pathToFileURL(join(resolve(baseline), "core/consumer.js")))).consumeMailbox }
    : {}),
  candidate: consumeMailbox,
};
const sampleCount = baseline ? 6 : 3;
const temporary = await mkdtemp(join(tmpdir(), "git-relay-bench-"));
const previousState = process.env.WORKTREE_SYNC_STATE_DIR;
process.env.WORKTREE_SYNC_STATE_DIR = join(temporary, "state");
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
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
const elapsed = async (run) => {
  const start = performance.now();
  await run();
  return Math.round((performance.now() - start) * 10) / 10;
};
try {
  const main = join(temporary, "main");
  git(temporary, "init", "-b", "main", main);
  await writeFile(join(main, "shared.txt"), "base\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "baseline");
  const sessions = [];
  for (let i = 0; i < 3; i++) {
    const cwd = join(temporary, `receiver-${i}`);
    git(main, "worktree", "add", "-b", `receiver-${i}`, cwd);
    const options = {
      cwd,
      ref: "refs/heads/main",
      adapter: "benchmark",
      session: `receiver-${i}`,
      async deliver() {
        assert.fail("idle poll must not deliver");
      },
    };
    await consumeMailbox(options);
    const repo = await repository(cwd);
    sessions.push({ options, repo, key: sessionKey(repo, options, options.ref) });
  }
  const repo = sessions[0].repo;
  const recipients = sessions.map(({ key }) => key);
  const ids = [];
  const at = new Date().toISOString();
  console.log(
    JSON.stringify({
      node: process.version,
      git: git(main, "--version"),
      platform: platform(),
      arch: arch(),
      sessions: 3,
      samples: sampleCount,
      offlineBacklog: 32,
      workload: "retained broadcast messages; setup excluded; warm filesystem cache",
    }),
  );
  for (const count of [100, 1000, 10000]) {
    while (ids.length < count) {
      const writes = [];
      for (let i = 0; i < 100 && ids.length < count; i++) {
        const id = hash(["benchmark", ids.length]);
        ids.push(id);
        const event = {
          id,
          kind: "message",
          createdAt: at,
          sender: { adapter: "benchmark", session: "sender", root: main },
          recipients,
          text: "benchmark",
          files: [],
        };
        writes.push(writeFile(join(repo.directory, "events", `${id}.json`), JSON.stringify(event)));
        for (const key of recipients)
          writes.push(
            writeFile(
              join(repo.directory, "receipts", key, `${id}.json`),
              JSON.stringify({ eventId: id, status: "delivered", at }),
            ),
          );
      }
      await Promise.all(writes);
    }
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
        const samples = Object.fromEntries(Object.keys(variants).map((name) => [name, []]));
        for (const consume of Object.values(variants))
          for (const { options } of sessions) assert.equal((await consume(options)).length, 0);
        for (let i = 0; i < sampleCount; i++) {
          const order = Object.entries(variants);
          if (i % 2) order.reverse();
          for (const [name, consume] of order)
            samples[name].push(
              await elapsed(async () => {
                for (const { options } of sessions) assert.equal((await consume(options)).length, 0);
              }),
            );
        }
        const medians = Object.fromEntries(
          Object.entries(samples).map(([name, rows]) => {
            const sorted = [...rows].sort((a, b) => a - b),
              middle = Math.floor(sorted.length / 2);
            return [name, sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2];
          }),
        );
        const unread = ids.slice(-32);
        const receiver = sessions[0];
        for (const id of unread) await rm(join(repo.directory, "receipts", receiver.key, `${id}.json`));
        const received = [];
        const offlineRecoveryMs = await elapsed(async () => {
          for (let i = 0; i < 4; i++)
            await consumeMailbox({
              ...receiver.options,
              async deliver(batch) {
                received.push(...batch.map((notification) => notification.event.id));
              },
            });
        });
        assert.deepEqual(received.sort(), [...unread].sort());
        assert.equal((await consumeMailbox(receiver.options)).length, 0);
        for (const id of unread)
          assert.equal(
            JSON.parse(await readFile(join(repo.directory, "receipts", receiver.key, `${id}.json`), "utf8")).status,
            "delivered",
          );
        assert.equal((await daemonStatus()).running, daemon);
        console.log(
          JSON.stringify({
            events: count,
            daemon,
            idleThreeSessionsMs: medians.candidate,
            ...(baseline ? { idleByVariantMs: medians, idleSamplesByVariantMs: samples } : {}),
            offlineRecovery32Ms: offlineRecoveryMs,
          }),
        );
      } finally {
        abort.abort();
        await running;
      }
    }
  }
} finally {
  if (previousState === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
  else process.env.WORKTREE_SYNC_STATE_DIR = previousState;
  await rm(temporary, { recursive: true, force: true });
}
