import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { priorRepositories, type Repository } from "../../src/core/repository.ts";
import { hash, withLock } from "../../src/core/store.ts";

test(
  "prior-state discovery drains bounded probes and preserves the first error before unlock",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "gitbeacon-prior-batches-")),
      previous = process.env.GITBEACON_STATE_DIR;
    process.env.GITBEACON_STATE_DIR = root;
    t.after(async () => {
      if (previous === undefined) delete process.env.GITBEACON_STATE_DIR;
      else process.env.GITBEACON_STATE_DIR = previous;
      await rm(root, { recursive: true, force: true });
    });
    const repo: Repository = {
      root,
      common: root,
      id: hash("current"),
      directory: root,
      identity: hash("identity"),
      identitySource: "external",
    };
    const history = join(root, "identity-history", hash(root)),
      repos = join(root, "repos"),
      first = join(repos, "1".padStart(64, "0")),
      lock = join(root, "identity.lock");
    await mkdir(history, { recursive: true });
    await mkdir(repos);
    const ids = Array.from({ length: 40 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
    for (const id of ids) {
      await writeFile(join(history, id), "");
      await mkdir(join(repos, id));
    }
    const gate = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>(),
      original = fs.promises.lstat;
    let active = 0,
      peak = 0,
      seen = 0,
      settled = false;
    const patch = t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof original>) => {
      const path = String(args[0]);
      if (!path.startsWith(`${repos}${sep}`)) return original(...args);
      active++;
      seen++;
      peak = Math.max(peak, active);
      try {
        if (path === first) throw Object.assign(new Error("first prior denied"), { code: "EACCES" });
        if (path === join(repos, ids[1])) {
          started.resolve();
          await gate.promise;
        }
        return await original(...args);
      } finally {
        active--;
      }
    });
    syncBuiltinESMExports();
    let pending: Promise<string[]> | undefined;
    try {
      pending = withLock(lock, () => priorRepositories(repo));
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(seen, 32);
      assert.ok(peak > 1 && peak <= 32);
      await assert.rejects(
        withLock(lock, async () => {}),
        /busy/i,
      );
      gate.resolve();
      await assert.rejects(pending, /first prior denied/);
      assert.equal(active, 0);
      assert.equal(seen, 32);
    } finally {
      gate.resolve();
      await pending?.catch(() => {});
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
