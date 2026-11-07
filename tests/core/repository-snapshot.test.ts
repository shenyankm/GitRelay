import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { repositorySnapshot } from "../../src/core/repository-snapshot.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sendMessage } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture, git } from "../helpers.ts";

async function fingerprint(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const parts = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(path, entry.name);
    parts.push(
      entry.name,
      entry.isDirectory()
        ? await fingerprint(file)
        : createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
    );
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

test("repository snapshot observes new, dirty and detached repositories without initializing state", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "local.txt"), "keep my changes\n");
  const before = git(f.b, "status", "--porcelain");
  const snapshot = await repositorySnapshot(f.b);
  assert.equal(snapshot.initialized, false);
  assert.equal(snapshot.worktrees.length, 4);
  assert.ok("value" in snapshot.status);
  assert.equal(snapshot.status.value.worktree.dirty, true);
  assert.equal(snapshot.status.value.worktree.branch, "feature/b");
  assert.deepEqual(snapshot.sessions, []);
  assert.equal(snapshot.retainedEvents, 0);
  assert.equal(git(f.b, "status", "--porcelain"), before);
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
  await assert.rejects(access(join(f.main, ".git", ".gitbeacon-id")), { code: "ENOENT" });
  git(f.b, "checkout", "--detach");
  const detached = await repositorySnapshot(f.b);
  assert.ok("error" in detached.status);
  assert.match(detached.status.error, /Detached HEAD/);
  assert.equal(detached.worktrees.length, 4);
});

test("repository snapshot preserves unread messages and reports real delivered and irrelevant receipts", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.b, adapter: "codex", session: "receiver", ref: "refs/heads/main" };
  await consumeMailbox({ ...receiver, async deliver() {} });
  const sent = await sendMessage({
    cwd: f.a,
    adapter: "codex",
    session: "sender",
    text: "<script>window.injected=true</script>",
  });
  const repo = await repository(f.b);
  const before = await fingerprint(repo.directory);
  const summary = await repositorySnapshot(f.b);
  assert.equal(summary.eventsIncluded, false);
  assert.equal(summary.retainedEvents, 1);
  assert.deepEqual(summary.events, []);
  const first = await repositorySnapshot(f.b, undefined, true);
  assert.equal(first.events[0].id, sent.id);
  assert.equal(first.events[0].delivery[0].status, "pending");
  assert.ok(first.events[0].kind === "message");
  assert.equal(first.events[0].text, "<script>window.injected=true</script>");
  assert.equal("activationToken" in first.sessions[0], false);
  assert.equal(await fingerprint(repo.directory), before);
  let delivered = 0;
  await consumeMailbox({
    ...receiver,
    async deliver(batch) {
      delivered += batch.length;
    },
  });
  assert.equal(delivered, 1);
  const second = await repositorySnapshot(f.b, undefined, true);
  assert.equal(second.events[0].delivery[0].status, "delivered");
  assert.ok(second.events[0].delivery[0].at);
  await consumeMailbox({
    ...receiver,
    async deliver() {
      assert.fail("duplicate delivery");
    },
  });
  const unrelated = await sendMessage({
    cwd: f.a,
    adapter: "codex",
    session: "sender",
    text: "unrelated",
    files: ["other.txt"],
  });
  await consumeMailbox({
    ...receiver,
    async deliver() {
      assert.fail("irrelevant message");
    },
  });
  const third = await repositorySnapshot(f.b, undefined, true);
  assert.equal(third.events.find((event) => event.id === unrelated.id)?.delivery[0].status, "irrelevant");
  const receipt = join(repo.directory, "receipts", third.sessions[0].key, `${unrelated.id}.json`);
  await writeFile(receipt, '{"eventId":"corrupt"}');
  await assert.rejects(repositorySnapshot(f.b, undefined, true), /Invalid receipt/);
  assert.equal(await readFile(receipt, "utf8"), '{"eventId":"corrupt"}');
});
