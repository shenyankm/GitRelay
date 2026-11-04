import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sendMessage } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { joinSession } from "../../src/core/sessions.ts";
import { fixture } from "../helpers.ts";

test("stable repository metadata is not replaced by poll, join or send; missing and corrupt records recover", async (t) => {
  const f = await fixture(t),
    identity = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "receiver" };
  const poll = () => consumeMailbox({ ...identity, async deliver() {} });
  await poll();
  const repo = await repository(f.b),
    path = join(repo.directory, "repo.json"),
    original = fs.promises.rename;
  const expected = await readFile(path, "utf8");
  let writes = 0;
  const patch = t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof original>) => {
    if (args[1] === path) writes++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await poll();
    await joinSession(identity);
    await sendMessage({ ...identity, text: "metadata control" });
    assert.equal(writes, 0);
    assert.equal(await readFile(path, "utf8"), expected);
    for (const kind of ["missing", "invalid-json", "stale-fields"]) {
      if (kind === "missing") await rm(path);
      else await writeFile(path, kind === "invalid-json" ? "{broken" : '{"id":"old"}');
      await poll();
      assert.equal(await readFile(path, "utf8"), expected);
    }
    assert.equal(writes, 3);
    if (process.platform !== "win32") {
      const target = join(f.root, "foreign.json");
      await writeFile(target, "do not change");
      await rm(path);
      await symlink(target, path);
      await poll();
      assert.equal(await readFile(target, "utf8"), "do not change");
      assert.equal(await readFile(path, "utf8"), expected);
    }
    await rm(path);
    const failure = new Error("metadata publication failed");
    patch.mock.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[1] === path) throw failure;
      return original(...args);
    });
    await assert.rejects(poll(), (error) => error === failure);
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
  }
});
