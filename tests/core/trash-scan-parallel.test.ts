import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { synchronizeRef } from "../../src/core/publisher.ts";
import { collectRepository } from "../../src/core/cleanup.ts";
import { hash, withLock } from "../../src/core/store.ts";
import { type Repository } from "../../src/core/repository.ts";

const ref = "refs/heads/main",
  identity = { adapter: "test", session: "scan" };
const ids = Array.from({ length: 9 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "gitbeacon-trash-scan-"));
  t.after(() => (process.env.GITRELAY_KEEP_TEST_FIXTURES ? undefined : rm(base, { recursive: true, force: true })));
  const root = join(base, "repo"),
    template = join(base, "template"),
    state = join(base, "state");
  const keys = Object.keys(process.env).filter(
    (key) => key.startsWith("GIT_") || ["HOME", "PATH", "XDG_CONFIG_HOME"].includes(key),
  );
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    PATH: "/usr/bin:/bin",
    HOME: base,
    XDG_CONFIG_HOME: join(base, "config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (key.startsWith("GIT_") || ["HOME", "PATH", "XDG_CONFIG_HOME"].includes(key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  await mkdir(template);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  execFileSync("git", ["init", "--template", template, root], { env, stdio: "pipe" });
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
      { env, encoding: "utf8" },
    ).trim();
  git("symbolic-ref", "HEAD", ref);
  git("commit", "--allow-empty", "-m", "initial");
  const commit = git("rev-parse", "HEAD");
  for (const name of ["events", "trash", "refs", "sessions", "receipts"])
    await mkdir(join(state, name), { recursive: true });
  const cursor = join(state, "refs", `${hash(ref)}.json`);
  await writeFile(cursor, JSON.stringify({ ref, commit }));
  const repo: Repository = {
    root,
    common: join(root, ".git"),
    directory: state,
    id: "a".repeat(64),
    identity: "b".repeat(64),
    identitySource: "marker",
  };
  const event = (id: string) => ({
    id,
    kind: "message",
    createdAt: new Date(0).toISOString(),
    sender: { ...identity, root },
    recipients: [],
    text: "marker",
    files: [],
  });
  return { state, repo, commit, cursor, event, trash: join(state, "trash"), lock: join(state, "publish.lock") };
}

async function waitUntil(check: () => boolean) {
  for (let tries = 0; tries < 500 && !check(); tries++) await delay(10);
  assert.ok(check(), "expected scan did not start");
}

test(
  "trash scans limit in-flight reads and settle each batch before starting the next",
  { timeout: 15_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    for (const id of ids) await writeFile(join(f.trash, `${id}.json`), JSON.stringify(f.event(id)));
    const gates = Array.from({ length: 3 }, deferred),
      original = fs.promises.open;
    let started = 0,
      active = 0,
      maximum = 0;
    const open = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
      if (typeof args[0] === "string" && args[0].startsWith(`${f.trash}${sep}`)) {
        const wave = Math.floor(started++ / 4);
        active++;
        maximum = Math.max(maximum, active);
        try {
          await gates[wave].promise;
          return await original(...args);
        } finally {
          active--;
        }
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    let pending: Promise<string> | undefined;
    try {
      pending = synchronizeRef(f.repo, ref, identity);
      void pending.catch(() => {});
      for (const [index, expected] of [4, 8, 9].entries()) {
        await waitUntil(() => started >= expected);
        await delay(20);
        assert.equal(started, expected);
        gates[index].release();
      }
      assert.equal(await pending, f.commit);
      assert.equal(maximum, 4);
    } finally {
      for (const gate of gates) gate.release();
      await pending?.catch(() => {});
      open.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test(
  "trash scan cancellation waits for the whole batch while holding the publication lock",
  { timeout: 15_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      names = ids.slice(0, 4).map((id) => `${id}.json`);
    for (const [index, id] of ids.slice(0, 4).entries())
      await writeFile(join(f.trash, `${id}.json`), JSON.stringify(index === 1 ? { id: "invalid" } : f.event(id)));
    const before = await readFile(f.cursor, "utf8"),
      first = deferred(),
      last = deferred(),
      originalOpen = fs.promises.open,
      originalReadDir = fs.promises.readdir,
      originalRm = fs.promises.rm;
    let started = 0,
      settled = false;
    const open = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
      if (typeof args[0] === "string" && args[0].startsWith(`${f.trash}${sep}`)) {
        started++;
        if (args[0] === join(f.trash, names[0])) await first.promise;
        if (args[0] === join(f.trash, names[3])) await last.promise;
      }
      return originalOpen(...args);
    });
    const readdir = t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof originalReadDir>) =>
      args[0] === f.trash ? (names as never) : originalReadDir(...args),
    );
    // Keep the fixture lock after the assertion; ordinary test teardown removes the fixture.
    const remove = t.mock.method(fs.promises, "rm", async (...args: Parameters<typeof originalRm>) =>
      args[0] === f.lock ? undefined : originalRm(...args),
    );
    syncBuiltinESMExports();
    let pending: Promise<string> | undefined;
    try {
      const controller = new AbortController(),
        reason = new Error("test cancellation");
      pending = withLock(f.lock, () => synchronizeRef(f.repo, ref, identity, controller.signal));
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitUntil(() => started === 4);
      controller.abort(reason);
      first.release();
      await delay(20);
      assert.equal(settled, false);
      await assert.rejects(
        withLock(f.lock, async () => {}),
        /busy/i,
      );
      last.release();
      await assert.rejects(pending, (error) => error === reason);
      assert.equal(await readFile(f.cursor, "utf8"), before);
    } finally {
      first.release();
      last.release();
      await pending?.catch(() => {});
      open.mock.restore();
      readdir.mock.restore();
      remove.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test(
  "trash scan preserves first error in directory order and ignores missing or unrelated files",
  { timeout: 15_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      original = fs.promises.readdir;
    for (const id of ids.slice(0, 6))
      await writeFile(
        join(f.trash, `${id}.json`),
        JSON.stringify(id === ids[4] || id === ids[5] ? { id: "invalid" } : f.event(id)),
      );
    const names = [`${ids[6]}.json`, "unrelated.tmp", ...ids.slice(0, 6).map((id) => `${id}.json`)];
    const readdir = t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof original>) =>
      args[0] === f.trash ? (names as never) : original(...args),
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(synchronizeRef(f.repo, ref, identity), new RegExp(`Invalid shared event: ${ids[4]}`));
    } finally {
      readdir.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test(
  "trash directory cancellation cannot bypass non-event entries",
  { timeout: 15_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      original = fs.promises.readdir,
      controller = new AbortController(),
      reason = new Error("readdir cancellation");
    const before = await readFile(f.cursor, "utf8");
    const readdir = t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof original>) => {
      if (args[0] === f.trash) {
        controller.abort(reason);
        return ["unrelated.tmp"] as never;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(synchronizeRef(f.repo, ref, identity, controller.signal), (error) => error === reason);
    } finally {
      readdir.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(f.cursor, "utf8"), before);
  },
);

test(
  "GC settles its four trash reads before failing and releasing the publication lock",
  { timeout: 15_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    for (const id of ids) await writeFile(join(f.trash, `${id}.json`), JSON.stringify(f.event(id)));
    await writeFile(join(f.trash, `${ids[0]}.json`), "{broken");
    const gate = deferred(),
      original = fs.promises.open;
    let started = 0,
      active = 0,
      peak = 0,
      settled = false;
    const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
      if (typeof args[0] !== "string" || !args[0].startsWith(`${f.trash}${sep}`)) return original(...args);
      started++;
      active++;
      peak = Math.max(peak, active);
      try {
        if (args[0] !== join(f.trash, `${ids[0]}.json`)) await gate.promise;
        return await original(...args);
      } finally {
        active--;
      }
    });
    syncBuiltinESMExports();
    let pending: ReturnType<typeof collectRepository> | undefined;
    try {
      pending = collectRepository(f.repo, { apply: true });
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitUntil(() => started === 4);
      assert.equal(settled, false);
      await assert.rejects(
        withLock(f.lock, async () => {}),
        /busy/i,
      );
      gate.release();
      await assert.rejects(pending, SyntaxError);
      assert.equal(started, 4);
      assert.equal(active, 0);
      assert.ok(peak <= 4);
      assert.equal(await readFile(join(f.trash, `${ids[0]}.json`), "utf8"), "{broken");
      for (const id of ids.slice(1))
        assert.equal(JSON.parse(await readFile(join(f.trash, `${id}.json`), "utf8")).id, id);
    } finally {
      gate.release();
      await pending?.catch(() => {});
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test(
  "GC settles ref cursor reads before a malformed cursor releases its publication lock",
  { timeout: 15_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      gate = deferred(),
      original = fs.promises.open;
    const refs = ["refs/heads/one", "refs/heads/two"];
    for (let i = 0; i < refs.length; i++) {
      await writeFile(
        join(f.state, "events", `${ids[i]}.json`),
        JSON.stringify({
          ...f.event(ids[i]),
          kind: "upstream",
          ref: refs[i],
          previous: f.commit,
          commit: "c".repeat(40),
        }),
      );
      await writeFile(
        join(f.state, "refs", `${hash(refs[i])}.json`),
        i ? JSON.stringify({ ref: refs[i], commit: "c".repeat(40) }) : "{broken",
      );
    }
    let entered = false,
      settled = false;
    const second = join(f.state, "refs", `${hash(refs[1])}.json`);
    const patch = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
      if (args[0] === second) {
        entered = true;
        await gate.promise;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    let pending: ReturnType<typeof collectRepository> | undefined;
    try {
      pending = collectRepository(f.repo, { apply: true });
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitUntil(() => entered);
      assert.equal(settled, false);
      await assert.rejects(
        withLock(f.lock, async () => {}),
        /busy/i,
      );
      gate.release();
      await assert.rejects(pending, SyntaxError);
      for (const id of ids.slice(0, 2))
        assert.equal(JSON.parse(await readFile(join(f.state, "events", `${id}.json`), "utf8")).id, id);
    } finally {
      gate.release();
      await pending?.catch(() => {});
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
