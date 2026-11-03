import assert from "node:assert/strict";
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { sendMessage } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

for (const mode of ["error", "abort"])
  test(`send settles bounded file inspections before returning ${mode}`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t),
      repo = await repository(f.b),
      original = fs.promises.lstat;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0,
      peak = 0,
      seen = 0,
      settled = false;
    const patch = t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof original>) => {
      const path = String(args[0]);
      if (!path.startsWith(join(f.b, "file-"))) return original(...args);
      active++;
      seen++;
      peak = Math.max(peak, active);
      try {
        if (path === join(f.b, "file-1")) {
          entered();
          await gate;
        }
        if (mode === "error" && path === join(f.b, "file-0"))
          throw Object.assign(new Error("first path denied"), { code: "EACCES" });
        return await original(...args);
      } finally {
        active--;
      }
    });
    syncBuiltinESMExports();
    const controller = new AbortController();
    try {
      const pending = sendMessage({
        cwd: f.b,
        adapter: "test",
        session: "sender",
        text: "preserve",
        files: Array.from({ length: 40 }, (_, i) => `file-${i}`),
        signal: controller.signal,
      });
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started;
      if (mode === "abort") controller.abort(new Error("stop file inspection"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.ok(peak > 1 && peak <= 32);
      assert.equal(seen, 32);
      release();
      await assert.rejects(pending, mode === "error" ? /file-0.*EACCES/ : /stop file inspection/);
      assert.equal(active, 0);
      assert.deepEqual(await readdir(join(repo.directory, "events")), []);
    } finally {
      release();
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  });
