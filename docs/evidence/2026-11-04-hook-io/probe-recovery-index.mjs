import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { consumeMailbox } from "../../../dist/core/consumer.js";
import { sessionKey } from "../../../dist/core/mailbox.js";
import { readRef } from "../../../dist/core/publisher.js";
import { repository } from "../../../dist/core/repository.js";
import { withLock, writeJson } from "../../../dist/core/store.js";

const [baseline, ...extra] = process.argv.slice(2);
assert.ok(baseline && !extra.length, "Usage: node probe-recovery-index.mjs /absolute/baseline-dist");
const legacy = await import(pathToFileURL(join(resolve(baseline), "core/mailbox.js")));
const temporary = await mkdtemp(join(tmpdir(), "gitrelay-recovery-index-"));
const previousState = process.env.WORKTREE_SYNC_STATE_DIR;
process.env.WORKTREE_SYNC_STATE_DIR = join(temporary, "state");
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=Probe", "-c", "user.email=probe@example.test", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
try {
  const main = join(temporary, "main"),
    receiver = join(temporary, "receiver");
  git(temporary, "init", "-b", "main", main);
  const commit = async (text) => {
    await writeFile(join(main, "shared.txt"), text);
    git(main, "add", "shared.txt");
    git(main, "commit", "-m", text);
    return git(main, "rev-parse", "HEAD");
  };
  const base = await commit("base");
  git(main, "worktree", "add", "-b", "receiver", receiver);
  await writeFile(join(receiver, "shared.txt"), "local dirty work");
  const received = [];
  const options = {
    cwd: receiver,
    adapter: "probe",
    session: "receiver",
    ref: "refs/heads/main",
    async deliver(batch) {
      received.push(...batch);
    },
  };
  await consumeMailbox(options);
  const repo = await repository(receiver),
    key = sessionKey(repo, options, options.ref);
  const journal = join(temporary, "proposed-empty-journal.json");
  await writeJson(journal, { pending: [] });
  const journalBefore = await readFile(journal);
  const first = await commit("first");
  const pending = await withLock(join(repo.directory, "publish.lock"), () =>
    legacy.publishUpstream(repo, options, options.ref, base, first, [key]),
  );
  await writeJson(join(repo.directory, "receipts", key, `${pending.id}.json`), {
    eventId: pending.id,
    status: "delivered",
    at: new Date().toISOString(),
  });
  assert.deepEqual(await readFile(journal), journalBefore);
  assert.equal((await readRef(repo, options.ref)).commit, base);
  const second = await commit("second");
  await consumeMailbox(options);
  assert.equal(received.length, 1);
  assert.equal(received[0].event.previous, first);
  assert.equal(received[0].event.commit, second);
  assert.equal((await readRef(repo, options.ref)).commit, second);

  const eventDirectory = join(repo.directory, "events");
  const witness = async () => {
    const info = await stat(eventDirectory, { bigint: true });
    return [info.dev, info.ino, info.mtimeNs, info.ctimeNs].map(String);
  };
  const before = await witness();
  await writeFile(join(eventDirectory, `${pending.id}.json`), "{broken");
  assert.deepEqual(await witness(), before, "In-place event changes do not invalidate the directory witness");
  await assert.rejects(consumeMailbox(options), SyntaxError);
  console.log(
    JSON.stringify(
      {
        legacyWriterCanLeavePendingPublicationWithoutNewJournal: true,
        acknowledgedPendingPublicationRecovered: true,
        inPlaceEventChangeLeavesDirectoryWitnessUnchanged: true,
        corruptAcknowledgedEventStillRejected: true,
        decision:
          "Reject journal-absence and directory-timestamp shortcuts; retain full recovery validation and existing storage compatibility.",
      },
      null,
      2,
    ),
  );
} finally {
  if (previousState === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
  else process.env.WORKTREE_SYNC_STATE_DIR = previousState;
  await rm(temporary, { recursive: true, force: true });
}
