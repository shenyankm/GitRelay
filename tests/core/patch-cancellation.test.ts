import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { inspectChange } from "../../src/core/changes.ts";
import { fixture, git } from "../helpers.ts";

for (const mode of ["cancel", "timeout"] as const)
  test(
    `${mode} stops a patch's descendants retaining its output pipes`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await fixture(t),
        bin = join(f.root, "bin"),
        started = join(f.root, "started");
      await writeFile(join(f.b, "shared.txt"), "local\n");
      const tip = await f.commit(f.main, "shared.txt", "upstream\n");
      await mkdir(bin);
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\ncase "$*" in *' --unified=3 '*) sleep 5 & echo $! > "$PATCH_STARTED"; wait; exit 1;; esac\nexec /usr/bin/git "$@"\n`,
      );
      await chmod(join(bin, "git"), 0o755);
      const oldPath = process.env.PATH,
        oldStarted = process.env.PATCH_STARTED;
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      process.env.PATCH_STARTED = started;
      const controller = new AbortController(),
        reason = new Error("cancel patch");
      try {
        const realSetTimeout = globalThis.setTimeout;
        if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
        const pending = inspectChange({ root: f.b, ref: "refs/heads/main", commit: f.initial }, tip, controller.signal);
        const deadline = Date.now() + 5000;
        while (
          !(await access(started).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() > deadline) throw new Error("patch did not start");
          await new Promise((resolve) => realSetTimeout(resolve, 10));
        }
        const before = Date.now();
        if (mode === "cancel") controller.abort(reason);
        else t.mock.timers.tick(30_000);
        await assert.rejects(pending, (error: Error) =>
          mode === "cancel" ? error === reason : /timed out/.test(error.message),
        );
        assert.ok(Date.now() - before < 2000, "cancel must not wait for a descendant holding a pipe");
        const pid = Number(await readFile(started, "utf8"));
        await new Promise((resolve) => realSetTimeout(resolve, 100));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldStarted === undefined) delete process.env.PATCH_STARTED;
        else process.env.PATCH_STARTED = oldStarted;
      }
    },
  );

test("comparison does not fetch a missing promisor blob", async (t) => {
  const f = await fixture(t),
    remote = join(f.root, "remote.git");
  await writeFile(join(f.b, "shared.txt"), "local\n");
  const tip = await f.commit(f.main, "shared.txt", "upstream\n");
  const blob = git(f.main, "rev-parse", `${tip}:shared.txt`).trim();
  git(f.root, "clone", "--bare", "--no-hardlinks", f.main, remote);
  git(f.main, "config", "remote.origin.url", pathToFileURL(remote).href);
  git(f.main, "config", "remote.origin.promisor", "true");
  git(f.main, "config", "remote.origin.partialclonefilter", "blob:none");
  const object = join(f.main, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  await rm(object);
  await assert.rejects(inspectChange({ root: f.b, ref: "refs/heads/main", commit: f.initial }, tip));
  await assert.rejects(access(object));
  assert.equal(git(f.main, "cat-file", "-e", blob), "");
});
