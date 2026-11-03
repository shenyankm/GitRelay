import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { formatChange } from "../../src/core/changes.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sendMessage, sessionKey, type Notification } from "../../src/core/mailbox.ts";
import { writeJson } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture, git } from "../helpers.ts";

for (const local of ["tracked", "ignored", "uninitialized", "clean", "staged-delete"] as const) {
  test(`submodule updates remain potentially relevant with ${local} local state`, async (t) => {
    const f = await fixture(t),
      source = join(f.root, "sub-source"),
      ref = "refs/heads/main";
    await mkdir(source);
    git(source, "init", "-q", "-b", "main");
    await writeFile(join(source, "file.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "submodule base");
    git(f.main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
    git(f.main, "config", "-f", ".gitmodules", "submodule.sub.ignore", "all");
    git(f.main, "add", ".gitmodules", "sub");
    git(f.main, "commit", "-qm", "add submodule");
    git(f.b, "merge", "--ff-only", "main");
    git(f.b, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");

    const received: Notification[] = [];
    const receiver = {
      cwd: f.b,
      ref,
      adapter: "test",
      session: `sub-${local}`,
      async deliver(batch: Notification[]) {
        received.push(...batch);
      },
    };
    await consumeMailbox(receiver);
    const secret = "PRIVATE_IGNORED_SUBMODULE_CONTENT";
    if (local === "tracked") await writeFile(join(f.b, "sub", "file.txt"), "local edit\n");
    if (local === "ignored") {
      const excludes = join(f.root, "sub-excludes");
      await writeFile(excludes, "secret.local\n");
      git(join(f.b, "sub"), "config", "core.excludesFile", excludes);
      await writeFile(join(f.b, "sub", "secret.local"), secret);
    }
    if (local === "uninitialized") {
      git(f.b, "submodule", "deinit", "-f", "sub");
      await writeFile(join(f.b, "sub", "local.file"), secret);
    }
    if (local === "staged-delete") git(f.b, "-c", "submodule.sub.ignore=none", "rm", "-f", "sub");

    await writeFile(join(source, "file.txt"), "upstream\n");
    git(source, "add", "file.txt");
    git(source, "commit", "-qm", "submodule update");
    const target = git(source, "rev-parse", "HEAD").trim();
    git(join(f.main, "sub"), "-c", "protocol.file.allow=always", "fetch", "-q");
    git(join(f.main, "sub"), "checkout", "-q", target);
    git(f.main, "update-index", "--cacheinfo", `160000,${target},sub`);
    git(f.main, "-c", "submodule.sub.ignore=none", "commit", "-qm", "update gitlink");
    // Exercise the multi-commit history path as well as the individual diff.
    await f.commit(f.main, "other.txt", "unrelated\n");
    await consumeMailbox(receiver);
    const upstream = received.find((item) => item.kind === "upstream");
    assert.ok(upstream && upstream.kind === "upstream");
    assert.deepEqual(upstream.change.files, ["sub"]);
    assert.match(upstream.change.patch, /Subproject commit/);
    assert.doesNotMatch(upstream.change.patch, new RegExp(secret));
    assert.match(formatChange(upstream.change), /potentially relevant even when clean or uninitialized/);

    const sent = await sendMessage({
      cwd: f.main,
      adapter: "test",
      session: "sender",
      text: "submodule work",
      files: ["sub/file.txt"],
    });
    await consumeMailbox(receiver);
    assert.ok(received.some((item) => item.event.id === sent.id));
    assert.deepEqual(await consumeMailbox(receiver), []);
    if (local === "ignored") {
      const missed = await sendMessage({
        cwd: f.main,
        adapter: "test",
        session: "sender",
        text: "previously missed",
        files: ["sub/file.txt"],
      });
      const repo = await repository(f.b),
        key = sessionKey(repo, receiver, ref);
      const path = join(repo.directory, "receipts", key, `${missed.id}.json`);
      await writeJson(path, { eventId: missed.id, status: "irrelevant", at: new Date().toISOString() });
      const before = await readFile(path);
      await consumeMailbox(receiver);
      assert.ok(!received.some((item) => item.event.id === missed.id));
      assert.deepEqual(await readFile(path), before);
    }
  });
}
