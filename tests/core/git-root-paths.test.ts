import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sendMessage } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";

for (const suffix of ["\r", "\n", "\r\n"]) {
  test(
    `repository root preserves trailing ${JSON.stringify(suffix)} and old sibling state`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await fixture(t),
        normal = join(f.root, "separate"),
        special = normal + suffix;
      for (const path of [normal, special]) {
        await mkdir(path);
        git(path, "init", "-b", "main");
        await writeFile(join(path, "data"), path);
        git(path, "add", ".");
        git(path, "commit", "-m", "initial");
      }
      const got: string[] = [];
      const victim = {
        ref,
        adapter: "test",
        session: "victim",
        async deliver(batch: any[]) {
          got.push(...batch.map((item) => item.event.text));
        },
      };
      // Represents the indistinguishable old registration in the sibling repository; no state is migrated or erased.
      await consumeMailbox({ ...victim, cwd: normal });
      const old = await sendMessage({
        cwd: normal,
        ref,
        adapter: "test",
        session: "sender",
        text: "old sibling message",
      });
      const normalRepo = await repository(normal),
        oldPath = join(normalRepo.directory, "events", `${old.id}.json`),
        oldBytes = await readFile(oldPath);
      await consumeMailbox({ ...victim, cwd: special });
      const specialRepo = await repository(special);
      assert.notEqual(specialRepo.id, normalRepo.id);
      assert.equal(specialRepo.root, await realpath(special));
      assert.equal(got.length, 0);
      assert.deepEqual(await readFile(oldPath), oldBytes);
      await sendMessage({ cwd: normal, ref, adapter: "test", session: "sender", text: "new sibling message" });
      await consumeMailbox({ ...victim, cwd: special });
      assert.equal(got.length, 0);
      await sendMessage({ cwd: special, ref, adapter: "test", session: "sender", text: "own message" });
      await consumeMailbox({ ...victim, cwd: special });
      assert.deepEqual(got, ["own message"]);
      assert.deepEqual(await readFile(oldPath), oldBytes);
    },
  );
}

test(
  "a Git common directory ending in CR stays distinct for repository discovery",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      normal = join(f.root, "work-normal"),
      special = join(f.root, "work-special"),
      first = join(f.root, "common"),
      second = first + "\r";
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
    };
    t.after(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const select = (cwd: string, common: string) => {
      process.env.GIT_DIR = common;
      process.env.GIT_WORK_TREE = cwd;
      process.env.GIT_COMMON_DIR = common;
    };
    for (const [cwd, common] of [
      [normal, first],
      [special, second],
    ]) {
      await mkdir(cwd);
      for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete process.env[name];
      execFileSync("git", ["init", "--bare", "-b", "main", common]);
      select(cwd, common);
      await writeFile(join(cwd, "file"), cwd);
      git(cwd, "add", ".");
      git(cwd, "commit", "-m", "initial");
    }
    select(normal, first);
    const normalRepo = await repository(normal);
    select(special, second);
    const rec = { cwd: special, ref, adapter: "cli", session: "B", async deliver() {} };
    await consumeMailbox(rec);
    const selected = await repository(special);
    assert.equal(selected.common, await realpath(second));
    assert.notEqual(selected.id, normalRepo.id);
    const event = await sendMessage({ cwd: special, ref, adapter: "test", session: "A", text: "own message" });
    assert.ok(event.recipients.length);
  },
);
