import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { collectGarbage } from "../../src/core/cleanup.ts";
import { installCodex } from "../../src/cli/install-codex.ts";
import { sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { BusyError, GC_LOCK_TOKEN, readJson, repository, withLock, writeJson } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";
const exec = promisify(execFile);

test("GC busy marker only skips a fresh live matching lock", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-gc-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "publish.lock");
  const attempt = () =>
    withLock(path, async () => assert.fail("must not acquire"), { waitMs: 30, busyToken: GC_LOCK_TOKEN });
  await writeFile(path, JSON.stringify({ pid: process.pid, token: GC_LOCK_TOKEN }));
  await assert.rejects(attempt(), BusyError);
  await assert.rejects(
    withLock(path, async () => {}, { waitMs: 30 }),
    /lock remains busy/,
  );
  const old = new Date(Date.now() - 61_000);
  await utimes(path, old, old);
  await assert.rejects(
    attempt(),
    (error: unknown) =>
      error instanceof Error && !(error instanceof BusyError) && /lock remains busy/.test(error.message),
  );
  await writeFile(path, "{");
  await assert.rejects(
    attempt(),
    (error: unknown) =>
      error instanceof Error && !(error instanceof BusyError) && /lock remains busy/.test(error.message),
  );
  await writeFile(path, JSON.stringify({ pid: 2147483647, token: GC_LOCK_TOKEN }));
  await assert.rejects(
    attempt(),
    (error: unknown) =>
      error instanceof Error && !(error instanceof BusyError) && /Stale git-relay lock/.test(error.message),
  );
  await stat(path); // The stale lock is reported, not stolen.
  await writeFile(path, "");
  const waiting = withLock(path, async () => assert.fail("must not acquire"), {
    waitMs: 1000,
    busyToken: GC_LOCK_TOKEN,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await writeFile(path, JSON.stringify({ pid: process.pid, token: GC_LOCK_TOKEN }));
  await assert.rejects(waiting, BusyError);
});

test("ownerless lock inspection retries when initialization completes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-lock-initializing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.lock");
  await writeFile(path, "");
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe),
    original = prototype.read,
    initial = await probe.stat();
  await probe.close();
  let initialized = false;
  prototype.read = async function (...args: unknown[]) {
    const result = await original.apply(this, args);
    if (!initialized && !result.bytesRead && (await this.stat()).ino === initial.ino) {
      initialized = true;
      await writeFile(path, JSON.stringify({ pid: process.pid }));
    }
    return result;
  };
  try {
    await assert.rejects(
      withLock(path, async () => assert.fail("must not acquire")),
      BusyError,
    );
    assert.equal(initialized, true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
  } finally {
    prototype.read = original;
  }
});

test("ownerless lock inspection remains abortable and preserves the lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-lock-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.lock");
  await writeFile(path, "");
  await assert.rejects(
    withLock(path, async () => assert.fail("must not acquire"), { signal: AbortSignal.timeout(10) }),
    {
      name: "AbortError",
    },
  );
  assert.equal(await readFile(path, "utf8"), "");
});

test(
  "GC busy marker is ignored when the lock path was replaced during inspection",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "git-relay-gc-token-race-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "publish.lock"),
      replacement = join(directory, "replacement");
    await writeFile(path, JSON.stringify({ pid: process.pid, token: GC_LOCK_TOKEN }));
    await writeFile(replacement, JSON.stringify({ pid: process.pid, token: "not-gc" }));
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe),
      original = prototype.read;
    await probe.close();
    let replaced = false;
    prototype.read = async function (...args: unknown[]) {
      const result = await original.apply(this, args);
      if (!replaced && result.bytesRead) {
        replaced = true;
        await rename(replacement, path);
      }
      return result;
    };
    try {
      await assert.rejects(
        withLock(path, async () => assert.fail("must not acquire"), { waitMs: 30, busyToken: GC_LOCK_TOKEN }),
        (error: unknown) =>
          error instanceof Error && !(error instanceof BusyError) && /lock remains busy/.test(error.message),
      );
    } finally {
      prototype.read = original;
    }
    assert.equal(replaced, true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, "not-gc");
  },
);

test(
  "cancellation during GC lock inspection is not mistaken for a busy skip",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "git-relay-gc-token-cancel-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "publish.lock");
    await writeFile(path, JSON.stringify({ pid: process.pid, token: GC_LOCK_TOKEN }));
    const probe = await open(path, "r"),
      prototype = Object.getPrototypeOf(probe),
      original = prototype.read;
    await probe.close();
    const controller = new AbortController();
    prototype.read = async function (...args: unknown[]) {
      const result = await original.apply(this, args);
      if (result.bytesRead) controller.abort();
      return result;
    };
    try {
      await assert.rejects(
        withLock(path, async () => assert.fail("must not acquire"), {
          waitMs: 1000,
          busyToken: GC_LOCK_TOKEN,
          signal: controller.signal,
        }),
        { name: "AbortError" },
      );
    } finally {
      prototype.read = original;
    }
    assert.ok(controller.signal.aborted);
    await stat(path);
  },
);

test(
  "cancellation after GC owner liveness check is not mistaken for a busy skip",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "git-relay-gc-token-cancel-late-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "publish.lock");
    await writeFile(path, JSON.stringify({ pid: process.pid, token: GC_LOCK_TOKEN }));
    const controller = new AbortController(),
      original = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      const result = original(pid, signal);
      controller.abort();
      return result;
    }) as typeof process.kill;
    try {
      await assert.rejects(
        withLock(path, async () => assert.fail("must not acquire"), {
          waitMs: 1000,
          busyToken: GC_LOCK_TOKEN,
          signal: controller.signal,
        }),
        { name: "AbortError" },
      );
    } finally {
      process.kill = original;
    }
    await stat(path);
  },
);

test("JSON replacement preserves values and cleans temporary files on write or rename failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-json-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  await writeJson(path, { text: "original" });
  await writeJson(path, { text: "更新 🚀" });
  assert.deepEqual(await readJson(path), { text: "更新 🚀" });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(writeJson(path, { unsupported: 1n }), TypeError);
  assert.deepEqual(await readJson(path), { text: "更新 🚀" });
  const blocked = join(directory, "blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, "keep"), "preserved");
  await assert.rejects(writeJson(blocked, { text: "cannot replace a directory" }));
  assert.equal(await readFile(join(blocked, "keep"), "utf8"), "preserved");
  await assert.rejects(writeJson(join(directory, "missing", "state.json"), {}), { code: "ENOENT" });
  assert.deepEqual((await readdir(directory)).sort(), ["blocked", "state.json"]);
});

test("JSON writes preserve colliding, unverified, partial and replaced temporary files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-json-ownership-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  await writeJson(path, { text: "original" });
  const originalOpen = fs.promises.open;
  for (const mode of ["collision", "stat-failure", "partial", "replacement"] as const) {
    let temporary = "",
      displaced = "";
    fs.promises.open = (async (candidate: any, ...args: any[]) => {
      if (!temporary && String(candidate).startsWith(`${path}.`) && String(candidate).endsWith(".tmp")) {
        temporary = String(candidate);
        if (mode === "collision") {
          await writeFile(temporary, "foreign", { flag: "wx" });
          return (originalOpen as any)(candidate, ...args);
        }
        const handle = await (originalOpen as any)(candidate, ...args);
        if (mode === "stat-failure") {
          handle.stat = async () => {
            throw Object.assign(new Error("injected stat error"), { code: "EIO" });
          };
          return handle;
        }
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs: any[]) => {
          if (mode === "partial") {
            await handle.write("partial");
            throw Object.assign(new Error("injected partial write"), { code: "EIO" });
          }
          const result = await originalWrite(...writeArgs);
          displaced = `${temporary}.displaced`;
          await rename(temporary, displaced);
          await writeFile(temporary, "replacement", { flag: "wx" });
          return result;
        };
        return handle;
      }
      return (originalOpen as any)(candidate, ...args);
    }) as typeof fs.promises.open;
    syncBuiltinESMExports();
    try {
      if (mode === "stat-failure")
        await assert.rejects(writeJson(path, { text: mode }), /identity could not be verified; preserved:/);
      else await assert.rejects(writeJson(path, { text: mode }));
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.ok(temporary);
    assert.equal(
      await readFile(temporary, "utf8"),
      mode === "collision" ? "foreign" : mode === "stat-failure" ? "" : mode === "partial" ? "partial" : "replacement",
    );
    if (displaced) assert.equal(await readFile(displaced, "utf8"), JSON.stringify({ text: mode }));
    assert.deepEqual(await readJson(path), { text: "original" });
  }
});

test("JSON reads preserve UTF-8, size boundaries, missing files and parse errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  assert.equal(await readJson(path), undefined);
  const value = { text: "跨工作区消息 🚀" };
  await writeFile(path, JSON.stringify(value));
  assert.deepEqual(await readJson(path), value);
  await writeFile(path, '"' + "x".repeat(2 * 1024 * 1024 - 2) + '"');
  assert.equal(((await readJson(path)) as string).length, 2 * 1024 * 1024 - 2);
  await writeFile(path, '"' + "x".repeat(2 * 1024 * 1024 - 1) + '"');
  await assert.rejects(readJson(path), /State file exceeds 2 MiB/);
  await writeFile(path, "{");
  await assert.rejects(readJson(path), SyntaxError);
  // Preserve the previous JSON.parse behavior for a leading UTF-8 BOM.
  await writeFile(path, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
  await assert.rejects(readJson(path), SyntaxError);
  const invalid = Buffer.from([0x22, 0xff, 0x22]);
  await writeFile(path, invalid);
  await assert.rejects(readJson(path), /Invalid UTF-8 in state file/);
  assert.deepEqual(await readFile(path), invalid);
  await assert.rejects(readJson(join(path, "child.json")), { code: "ENOTDIR" });
});

test(
  "JSON reads retry a path published after open reported ENOENT",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "git-relay-json-publish-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const originalOpen = fs.promises.open;
    for (const kind of ["file", "symlink", "fifo"] as const) {
      const path = join(directory, kind);
      let attempts = 0;
      fs.promises.open = (async (candidate: any, ...args: any[]) => {
        if (String(candidate) === path && ++attempts === 1) {
          if (kind === "file") await writeFile(path, '{"value":42}');
          else if (kind === "symlink") {
            await writeFile(join(directory, "target"), '{"value":42}');
            await symlink("target", path);
          } else execFileSync("mkfifo", [path]);
          throw Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
        }
        return (originalOpen as any)(candidate, ...args);
      }) as typeof fs.promises.open;
      syncBuiltinESMExports();
      try {
        if (kind === "fifo") await assert.rejects(readJson(path), /State path is not a regular file/);
        else assert.deepEqual(await readJson(path), { value: 42 });
        assert.equal(attempts, 2);
      } finally {
        fs.promises.open = originalOpen;
        syncBuiltinESMExports();
      }
    }
  },
);

test(
  "JSON read retry stays bounded and returns missing if the path disappears",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "git-relay-json-retry-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "state.json"),
      originalOpen = fs.promises.open,
      originalLstat = fs.promises.lstat;
    let attempts = 0,
      removed = false;
    fs.promises.open = (async (candidate: any, ...args: any[]) => {
      if (String(candidate) === path && ++attempts === 1) {
        await writeFile(path, '{"value":1}');
        throw Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
      }
      return (originalOpen as any)(candidate, ...args);
    }) as typeof fs.promises.open;
    fs.promises.lstat = (async (candidate: any, ...args: any[]) => {
      const result = await (originalLstat as any)(candidate, ...args);
      if (String(candidate) === path && !removed) {
        removed = true;
        await rm(path);
      }
      return result;
    }) as typeof fs.promises.lstat;
    syncBuiltinESMExports();
    try {
      assert.equal(await readJson(path), undefined);
      assert.equal(attempts, 2);
    } finally {
      fs.promises.open = originalOpen;
      fs.promises.lstat = originalLstat;
      syncBuiltinESMExports();
    }

    await symlink("missing-target", path);
    attempts = 0;
    fs.promises.open = (async (candidate: any, ...args: any[]) => {
      if (String(candidate) === path) attempts++;
      return (originalOpen as any)(candidate, ...args);
    }) as typeof fs.promises.open;
    syncBuiltinESMExports();
    try {
      await assert.rejects(readJson(path), /State path exists but cannot be read/);
      assert.equal(attempts, 2);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(await readlink(path), "missing-target");
  },
);

test("JSON reads reject files that grow past the limit after inspection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-json-growth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  await writeFile(path, '"small"');
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let grown = false;
  prototype.read = async function (...args: unknown[]) {
    if (!grown) {
      grown = true;
      await appendFile(path, Buffer.alloc(2 * 1024 * 1024));
    }
    return original.apply(this, args);
  };
  try {
    await assert.rejects(readJson(path), /State file exceeds 2 MiB/);
  } finally {
    prototype.read = original;
  }
  assert.ok(grown);
});

test("dangling state links are not mistaken for missing data", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-json-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.json"),
    link = join(directory, "link.json");
  await writeFile(target, '{"value":1}');
  await symlink("target.json", link);
  assert.deepEqual(await readJson(link), { value: 1 });
  await rm(target);
  await assert.rejects(readJson(link), /State path exists but cannot be read/);
  assert.equal(await readlink(link), "target.json");
  const workspace = join(directory, "workspace"),
    agent = join(directory, "agent");
  await mkdir(workspace);
  await mkdir(agent);
  await writeFile(join(workspace, ".git-relay-owner"), "git-relay installer v1\n");
  const home = join(directory, "codex-home"),
    bin = join(directory, "bin");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(join(bin, "codex"), "#!/bin/sh\nprintf '{\"installed\":[]}\\n'\n", { mode: 0o755 });
  const env = { ...process.env, CODEX_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  for (const name of ["codex-install.json", "codex-hooks.json"]) {
    const state = join(workspace, name);
    await symlink("missing-state.json", state);
    await assert.rejects(
      installCodex({ workspace, sourceRoot: directory, env, clientVersion: "0.164.0" }),
      name === "codex-hooks.json" ? /Invalid Codex installation record/ : /State path exists but cannot be read/,
    );
    assert.ok((await lstat(state)).isSymbolicLink());
    assert.equal(await readlink(state), "missing-state.json");
    await assert.rejects(lstat(join(home, "hooks.json")), { code: "ENOENT" });
    await rm(state);
  }
});

test(
  "FIFO state is rejected without hanging check or GC and preserves unread events",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref, adapter: "test", session: "fifo", async deliver() {} };
    await consumeMailbox(receiver);
    const message = await sendMessage({ cwd: f.a, adapter: "test", session: "sender", text: "unread" });
    const repo = await repository(f.b);
    const fifo = join(repo.directory, "events", `${"a".repeat(64)}.json`);
    execFileSync("mkfifo", [fifo]);
    const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    for (const args of [
      ["check", "--cwd", f.b, "--agent", receiver.adapter, "--session", receiver.session],
      ["gc", "--cwd", f.b, "--apply", "--retention-days", "0"],
    ]) {
      await assert.rejects(
        exec(process.execPath, ["--experimental-strip-types", cli, ...args], {
          env: process.env,
          timeout: 3000,
          killSignal: "SIGKILL",
        }),
        (error: unknown) => {
          const result = error as { code?: number | string; stderr?: string };
          return result.code === 1 && /State path is not a regular file/.test(result.stderr ?? "");
        },
      );
    }
    assert.ok((await stat(fifo)).isFIFO());
    assert.ok(await readJson(join(repo.directory, "events", `${message.id}.json`)));
    assert.equal(
      await readJson(join(repo.directory, "receipts", message.recipients[0], `${message.id}.json`)),
      undefined,
    );
    await assert.rejects(stat(join(repo.directory, "publish.lock")), { code: "ENOENT" });
    await assert.rejects(stat(join(repo.directory, "sessions", `${sessionKey(repo, receiver, ref)}.lock`)), {
      code: "ENOENT",
    });
  },
);

test("publish contention waits for send and GC instead of dropping an operation", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f.b);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = withLock(join(repo.directory, "publish.lock"), async () => {
    entered.resolve();
    await release.promise;
  });
  t.after(() => {
    release.resolve();
  });
  await entered.promise;
  const sent = sendMessage({ cwd: f.a, adapter: "cli", session: "A", text: "wait for publication" });
  const gc = collectGarbage(f.b);
  // Give both requests time to observe the occupied lock.
  await new Promise((resolve) => setTimeout(resolve, 100));
  release.resolve();
  await holder;
  await Promise.all([sent, gc]);
  assert.equal(await stat(join(repo.directory, "publish.lock")).catch(() => undefined), undefined);
});

test("lock waits are cancellable and time out visibly without stealing the owner lock", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "test.lock");
  await withLock(path, async () => {
    const before = await readFile(path, "utf8");
    await assert.rejects(
      withLock(path, async () => assert.fail("must not acquire"), { waitMs: 1000, signal: AbortSignal.timeout(30) }),
      /abort/i,
    );
    await assert.rejects(
      withLock(path, async () => assert.fail("must not acquire"), { waitMs: 30 }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof BusyError) &&
        /Retry later; do not remove a live lock/.test(error.message),
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
  assert.equal(await stat(path).catch(() => undefined), undefined);
});

test("lock age never implies a live owner is stale", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, ref, adapter: "test", session: "B", async deliver() {} };
  await consumeMailbox(receiver);
  const repo = await repository(f.b);
  const path = join(repo.directory, "sessions", `${sessionKey(repo, receiver, ref)}.lock`);
  await withLock(path, async () => {
    const old = new Date(Date.now() - 61_000);
    await utimes(path, old, old);
    assert.deepEqual(await consumeMailbox(receiver), []);
    await assert.rejects(
      withLock(path, async () => {}),
      BusyError,
    );
    assert.ok(await stat(path));
  });
});
