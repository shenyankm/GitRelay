import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { publishUpstream, sessionKey } from "../../src/core/mailbox.ts";
import { readRef, synchronizeRef } from "../../src/core/publisher.ts";
import { hash, withLock } from "../../src/core/store.ts";
import { type Repository } from "../../src/core/repository.ts";

const ref = "refs/heads/main",
  agent = { adapter: "test", session: "receiver" },
  token = hash("test-daemon"),
  previousToken = hash("previous-daemon");
async function fixture(t: TestContext, options: { heartbeat?: boolean; cursorToken?: unknown; age?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gitbeacon-daemon-ref-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const priorState = process.env.GITBEACON_STATE_DIR;
  t.after(() => {
    if (priorState === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = priorState;
  });
  const template = join(directory, "template"),
    raw = join(directory, "repo"),
    state = join(directory, "state");
  await mkdir(template);
  execFileSync("git", ["init", "--template", template, "-b", "main", raw], { stdio: "pipe" });
  const root = await realpath(raw),
    common = await realpath(join(root, ".git"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${template}`,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  await writeFile(join(root, "file"), "first\n");
  git("add", "file");
  git("commit", "-m", "first");
  const first = git("rev-parse", "HEAD");
  await writeFile(join(root, "file"), "second\n");
  git("add", "file");
  git("commit", "-m", "second");
  const second = git("rev-parse", "HEAD");
  const identity = "a".repeat(64),
    id = hash([common, identity]),
    repo: Repository = { root, common, id, directory: join(state, "repos", id), identity, identitySource: "marker" };
  await writeFile(join(common, ".gitbeacon-id"), `${identity}\n`);
  for (const name of ["sessions", "events", "receipts", "refs", "trash"])
    await mkdir(join(repo.directory, name), { recursive: true });
  for (const name of ["identity-ready.json", "identity-owner.json"])
    await writeFile(join(repo.directory, name), JSON.stringify({ id }));
  const key = sessionKey(repo, agent, ref),
    now = new Date().toISOString(),
    cursorPath = join(repo.directory, "refs", `${hash(ref)}.json`);
  await writeFile(
    join(repo.directory, "sessions", `${key}.json`),
    JSON.stringify({ ...agent, key, root, ref, createdAt: now, lastSeen: now, baseline: first }),
  );
  await writeFile(
    cursorPath,
    JSON.stringify({
      ref,
      commit: first,
      checkedAt: new Date(Date.now() - (options.age ?? 0)).toISOString(),
      daemonToken: options.cursorToken,
    }),
  );
  if (options.heartbeat) {
    await writeFile(join(state, "daemon.lock"), JSON.stringify({ pid: process.pid, token }));
    await writeFile(
      join(state, "daemon.json"),
      JSON.stringify({ pid: process.pid, token, intervalMs: 5000, heartbeatAt: now }),
    );
  }
  process.env.GITBEACON_STATE_DIR = state;
  return { root, state, repo, key, first, second, cursorPath };
}
const use = (f: Awaited<ReturnType<typeof fixture>>) =>
  consumeMailbox({
    cwd: f.root,
    ...agent,
    ref,
    async deliver() {
      assert.fail("clean worktree should have no relevant notification");
    },
  });
const locked = <T>(repo: Repository, fn: () => Promise<T>) => withLock(join(repo.directory, "publish.lock"), fn);

test("legacy or foreign daemon heartbeat does not mask a newer ref", async (t) => {
  for (const options of [
    { heartbeat: true },
    { heartbeat: true, cursorToken: previousToken },
    { heartbeat: false, cursorToken: token },
    { heartbeat: true, cursorToken: token, age: 25_000 },
    { heartbeat: true, cursorToken: { opaque: true } },
  ]) {
    const f = await fixture(t, options);
    await use(f);
    const cursor = await readRef(f.repo, ref);
    assert.equal(cursor?.commit, f.second);
    assert.equal(cursor?.daemonToken, undefined, "manual synchronization must not claim daemon ownership");
    assert.equal((await readdir(join(f.repo.directory, "events"))).length, 1);
  }
});

test("matching fresh daemon observation does not suppress a current ref check", async (t) => {
  const f = await fixture(t, { heartbeat: true, cursorToken: token });
  await use(f);
  assert.equal((await readRef(f.repo, ref))?.commit, f.second);
  assert.equal((await readdir(join(f.repo.directory, "events"))).length, 1);
});

test("daemon synchronize stamps its token only after success and recovers a pending event", async (t) => {
  const f = await fixture(t);
  await locked(f.repo, async () => {
    await publishUpstream(f.repo, agent, ref, f.first, f.second, [f.key]);
    await synchronizeRef(f.repo, ref, { adapter: "daemon", session: "test" }, undefined, token);
  });
  const cursor = await readRef(f.repo, ref);
  assert.equal(cursor?.commit, f.second);
  assert.equal(cursor?.daemonToken, token);
  assert.equal((await readdir(join(f.repo.directory, "events"))).length, 1);
});

test("invalid token and cancellation preserve the old ref", async (t) => {
  for (const mode of ["invalid", "abort"] as const) {
    const f = await fixture(t, { cursorToken: previousToken }),
      before = await readFile(f.cursorPath, "utf8"),
      controller = new AbortController();
    if (mode === "abort") controller.abort(new Error("stopped"));
    await assert.rejects(
      locked(f.repo, () => synchronizeRef(f.repo, ref, agent, controller.signal, mode === "invalid" ? "bad" : token)),
      mode === "invalid" ? /Invalid daemon token/ : /stopped/,
    );
    assert.equal(await readFile(f.cursorPath, "utf8"), before);
    assert.deepEqual(await readdir(join(f.repo.directory, "events")), []);
  }
});

// Observe the temp-file boundary without relying on timer scheduling.
test("abort before the ref rename does not claim a daemon observation", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.cursorPath, "utf8"),
    controller = new AbortController();
  const original = fs.promises.lstat;
  let hit = false;
  fs.promises.lstat = (async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (!hit && String(args[0]).startsWith(`${f.cursorPath}.`) && String(args[0]).endsWith(".tmp")) {
      hit = true;
      controller.abort(new Error("stop before ref commit"));
    }
    return result;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      locked(f.repo, () => synchronizeRef(f.repo, ref, agent, controller.signal, token)),
      /stop before ref commit/,
    );
    assert.equal(hit, true);
    assert.equal(await readFile(f.cursorPath, "utf8"), before);
    assert.equal(
      (await readdir(join(f.repo.directory, "events"))).length,
      1,
      "published event is retained for recovery",
    );
  } finally {
    fs.promises.lstat = original;
    syncBuiltinESMExports();
  }
  // The no-delete test harness retains locks; the copy models manual recovery only.
  const recoveredState = `${f.state}-recovered`;
  await cp(f.state, recoveredState, { recursive: true, filter: (path) => !path.endsWith(".lock") });
  const recovered = { ...f.repo, directory: join(recoveredState, "repos", f.repo.id) };
  await locked(recovered, () => synchronizeRef(recovered, ref, agent, undefined, token));
  assert.equal((await readRef(recovered, ref))?.commit, f.second);
  assert.equal((await readRef(recovered, ref))?.daemonToken, token);
  assert.equal((await readdir(join(recovered.directory, "events"))).length, 1);
});

test(
  "failed Git ref observation preserves the prior cursor and events",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, { cursorToken: previousToken });
    const before = await readFile(f.cursorPath, "utf8"),
      bin = join(f.root, "fault-bin"),
      priorPath = process.env.PATH;
    await mkdir(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase \"$*\" in *--verify*) printf 'injected ref failure\\n' >&2; exit 77 ;; esac\nexec ${quotedGit} \"$@\"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${priorPath}`;
    try {
      await assert.rejects(
        locked(f.repo, () => synchronizeRef(f.repo, ref, agent, undefined, token)),
        /injected ref failure/,
      );
      assert.equal(await readFile(f.cursorPath, "utf8"), before);
      assert.deepEqual(await readdir(join(f.repo.directory, "events")), []);
    } finally {
      process.env.PATH = priorPath;
    }
  },
);

for (const scenario of [
  { name: "forward", rewind: false, shift: 60_000 },
  { name: "force reset", rewind: true, shift: -60_000 },
] as const) {
  test(
    `daemon checkedAt precedes a slow scan and cannot hide a ${scenario.name}`,
    { skip: process.platform === "win32", timeout: 20_000 },
    async (t) => {
      const f = await fixture(t),
        initial = scenario.rewind ? f.second : f.first,
        changed = scenario.rewind ? f.first : f.second;
      const git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim();
      git("update-ref", ref, initial);
      await writeFile(f.cursorPath, JSON.stringify({ ref, commit: initial }));
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const bin = join(f.root, "query-bin"),
        marker = join(f.root, "queried"),
        priorPath = process.env.PATH;
      await mkdir(bin);
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\n${quote(realGit)} "$@"\ncode=$?\ncase "$*" in *"rev-parse --verify"*) printf done > ${quote(marker)} ;; esac\nexit "$code"\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}:${priorPath}`;
      const original = fs.promises.readdir,
        release = Promise.withResolvers<void>();
      fs.promises.readdir = (async (...args: Parameters<typeof original>) => {
        if (String(args[0]) === join(f.repo.directory, "events")) await release.promise;
        return original(...args);
      }) as typeof original;
      syncBuiltinESMExports();
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const started = Date.now();
      const pending = locked(f.repo, () => synchronizeRef(f.repo, ref, agent, undefined, token));
      try {
        let observed = false;
        for (let attempt = 0; attempt < 400; attempt++) {
          if (
            await fs.promises.stat(marker).then(
              () => true,
              () => false,
            )
          ) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(observed, "the Git ref query completed");
        git("update-ref", ref, changed, initial);
        t.mock.timers.tick(Math.abs(scenario.shift));
        if (scenario.shift < 0) t.mock.timers.setTime(started + scenario.shift);
        release.resolve();
        await pending;
        const observedRef = await readRef(f.repo, ref);
        assert.equal(observedRef?.commit, initial);
        assert.equal(Date.parse(observedRef!.checkedAt!), started, "freshness starts before Git is queried");
        const recoveredState = `${f.state}-slow-${scenario.name.replaceAll(" ", "-")}`;
        await cp(f.state, recoveredState, { recursive: true, filter: (path) => !path.endsWith(".lock") });
        const recovered = { ...f.repo, directory: join(recoveredState, "repos", f.repo.id) };
        await writeFile(join(recoveredState, "daemon.lock"), JSON.stringify({ pid: process.pid, token }));
        await writeFile(
          join(recoveredState, "daemon.json"),
          JSON.stringify({ pid: process.pid, token, intervalMs: 5000, heartbeatAt: new Date().toISOString() }),
        );
        process.env.GITBEACON_STATE_DIR = recoveredState;
        const received: string[] = [];
        await consumeMailbox({
          cwd: f.root,
          ...agent,
          ref,
          async deliver(batch) {
            received.push(...batch.map((item) => item.event.id));
          },
        });
        assert.equal(
          (await readRef(recovered, ref))?.commit,
          changed,
          "a stale observation cannot suppress the next check",
        );
        if (scenario.rewind) assert.equal(received.length, 1, "the force reset reaches the dirty worktree");
      } finally {
        release.resolve();
        await pending.catch(() => {});
        fs.promises.readdir = original;
        syncBuiltinESMExports();
        process.env.PATH = priorPath;
      }
    },
  );
}
