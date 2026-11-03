import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventsIn, publishUpstream } from "../../src/core/mailbox.ts";
import { hash, withLock } from "../../src/core/store.ts";
import { repository } from "../../src/core/repository.ts";

test("invalid upstream input never publishes or changes an existing event", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "upstream-input-")),
    template = join(dir, "template"),
    cwd = join(dir, "repo");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousState = process.env.WORKTREE_SYNC_STATE_DIR;
  process.env.WORKTREE_SYNC_STATE_DIR = join(dir, "state");
  t.after(() => {
    if (previousState === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
    else process.env.WORKTREE_SYNC_STATE_DIR = previousState;
  });
  await mkdir(template);
  execFileSync("git", ["init", "--template", template, cwd], { stdio: "pipe" });
  const repo = await repository(cwd),
    id = { adapter: "test", session: "s" },
    ref = "refs/heads/main",
    previous = "a".repeat(40),
    commit = "b".repeat(40),
    key = "c".repeat(64);
  await withLock(join(repo.directory, "publish.lock"), async () => {
    const cases: Array<[unknown, unknown, unknown, unknown, unknown, unknown]> = [
      [id, ref, previous, commit, ["not-an-id"], ""],
      [id, ref, previous, commit, Array(1), ""],
      [id, ref, previous, commit, [key, null], ""],
      [id, ref, previous, commit, "not-array", ""],
      [id, ref, "not-a-commit", commit, [key], ""],
      [id, ref, previous, "not-a-commit", [key], ""],
      [id, null, previous, commit, [key], ""],
      [{ adapter: "", session: "s" }, ref, previous, commit, [key], ""],
      [id, ref, previous, commit, [key], null],
    ];
    const invoke = (args: unknown[]) =>
      (publishUpstream as (...args: unknown[]) => ReturnType<typeof publishUpstream>)(repo, ...args);
    for (const args of cases) await assert.rejects(invoke(args));
    assert.deepEqual(await readdir(join(repo.directory, "events")), []);
    const event = await publishUpstream(repo, id, ref, previous, commit, [key]);
    const path = join(repo.directory, "events", `${event.id}.json`),
      before = await readFile(path);
    for (const args of cases) await assert.rejects(invoke(args));
    await assert.rejects(
      publishUpstream({ ...repo, root: undefined as unknown as string }, id, ref, previous, commit, [key]),
    );
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(join(repo.directory, "events")), [`${event.id}.json`]);
    assert.equal((await eventsIn(repo)).length, 1);
    const trashId = hash(["upstream", ref, previous, commit, "trash"]),
      trash = join(repo.directory, "trash", `${trashId}.json`);
    const discarded = { ...event, id: trashId };
    await writeFile(trash, JSON.stringify(discarded));
    const trashBefore = await readFile(trash);
    await assert.rejects(publishUpstream(repo, id, ref, previous, commit, Array(1), "trash"));
    assert.deepEqual(await readFile(trash), trashBefore);
    assert.deepEqual(await readdir(join(repo.directory, "events")), [`${event.id}.json`]);

    const mutableRepo = { ...repo },
      mutableIdentity = { ...id },
      mutableRecipients = [key];
    const pending = publishUpstream(mutableRepo, mutableIdentity, ref, previous, commit, mutableRecipients, "mutation");
    mutableRepo.root = "changed";
    mutableRepo.directory = join(dir, "outside");
    mutableIdentity.adapter = "";
    mutableRecipients[0] = "invalid";
    const captured = await pending;
    assert.deepEqual(captured.recipients, [key]);
    assert.deepEqual(captured.sender, { ...id, root: repo.root });
    assert.ok((await readdir(join(repo.directory, "events"))).includes(`${captured.id}.json`));
    const extra = "d".repeat(64),
      mutableExtension = [extra];
    const extending = publishUpstream(repo, id, ref, previous, commit, mutableExtension, "mutation");
    mutableExtension[0] = "invalid";
    const extended = await extending;
    assert.deepEqual(extended.recipients, [key, extra]);
    assert.equal((await eventsIn(repo)).length, 2);
    const inherited = Object.create(repo) as typeof repo;
    const fromInherited = await publishUpstream(inherited, id, ref, previous, commit, [key], "inherited");
    assert.equal(fromInherited.sender.root, repo.root);
    assert.equal((await eventsIn(repo)).length, 3);
  });
});
