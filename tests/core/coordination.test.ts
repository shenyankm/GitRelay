import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, git } from "../helpers.ts";
import { trackRepository, scanCoordination, coordinationStatus, normalizeSource } from "../../src/core/coordination.ts";
import { enableSession } from "../../src/core/session-lifecycle.ts";
import { mcpIdentity, newSessionToken, receiveMessages, acknowledgeMessages } from "../../src/core/mcp-mailbox.ts";
import { eventsIn, sessionKey, readSession, publishCoordination } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { compareRevisions, openObserver, importRefs, type Revision } from "../../src/core/conflicts.ts";

async function subscribe(cwd: string) {
  const options = { cwd, ref: "refs/heads/main", sessionToken: newSessionToken() };
  await enableSession({ ...options, ...mcpIdentity(options.sessionToken) });
  return options;
}

function reports(batch: Awaited<ReturnType<typeof receiveMessages>>) {
  return batch.notifications
    .filter((item) => item.kind === "message" && item.event.sender.adapter === "gitbeacon")
    .map((item) =>
      JSON.parse(item.event.kind === "message" ? item.event.text.slice(item.event.text.indexOf("\n") + 1) : "null"),
    );
}

test("tracks all peer branches and dirty worktrees, diagnoses real conflicts without touching user state", async (t) => {
  const f = await fixture(t);
  const receiver = await subscribe(f.b);
  await writeFile(join(f.b, "shared.txt"), "receiver dirty\n");
  const peer = await f.commit(f.a, "shared.txt", "peer unmerged\n");
  const repo = await repository(f.b);
  const head = git(f.b, "rev-parse", "HEAD");
  const index = await readFile(join(f.main, ".git", "worktrees", "b", "index"));
  await trackRepository(f.b);
  await scanCoordination();
  const status = await coordinationStatus(f.b);
  const report = status.report as any;
  assert.ok(
    report.revisions.some((revision: Revision) => revision.ref === "refs/heads/feature/a" && revision.commit === peer),
  );
  const batch = await receiveMessages(receiver);
  const conflicts = reports(batch).flatMap((report) => report.findings);
  assert.ok(conflicts.some((issue) => issue.level === "conflict" && issue.files.includes("shared.txt")));
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "receiver dirty\n");
  assert.equal(git(f.b, "rev-parse", "HEAD"), head);
  assert.deepEqual(await readFile(join(f.main, ".git", "worktrees", "b", "index")), index);
  assert.equal(git(f.main, "rev-parse", "main").trim(), f.initial);
  await acknowledgeMessages({ ...receiver, deliveryId: batch.deliveryId! });
  await scanCoordination();
  assert.deepEqual((await receiveMessages(receiver)).notifications, []);
  assert.equal((await eventsIn(repo)).filter((event) => event.sender.adapter === "gitbeacon").length, 1);
});

test("same-source independent clones route automatic messages but retain separate ordinary mailboxes", async (t) => {
  const f = await fixture(t);
  const clone = joinPath(f.root, "clone");
  git(f.root, "clone", f.main, clone);
  git(clone, "checkout", "-b", "independent");
  const a = await subscribe(f.a);
  const b = await subscribe(clone);
  await f.commit(f.a, "shared.txt", "original\n");
  await f.commit(clone, "shared.txt", "clone\n");
  const first = await trackRepository(f.a);
  const second = await trackRepository(clone);
  assert.equal(first.source, second.source);
  await scanCoordination();
  for (const options of [a, b]) {
    const batch = await receiveMessages(options);
    assert.ok(reports(batch).some((report) => report.findings.some((issue: any) => issue.level === "conflict")));
  }
  assert.notEqual((await repository(f.a)).id, (await repository(clone)).id);
});

const joinPath = join;

test("cleanly mergeable same-file changes are overlap, not conflicts; resolution has a distinct event", async (t) => {
  const f = await fixture(t);
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
  await f.commit(f.main, "shared.txt", lines.join("\n") + "\n");
  git(f.a, "merge", "--ff-only", "main");
  git(f.b, "merge", "--ff-only", "main");
  const options = await subscribe(f.b);
  const mine = [...lines];
  mine[0] = "mine";
  await f.commit(f.b, "shared.txt", mine.join("\n") + "\n");
  const theirs = [...lines];
  theirs[19] = "theirs";
  await f.commit(f.a, "shared.txt", theirs.join("\n") + "\n");
  await trackRepository(f.b);
  await scanCoordination();
  const batch = await receiveMessages(options);
  const report = reports(batch)[0];
  assert.equal(report.status, "overlap");
  assert.ok(report.findings.every((issue: any) => issue.level === "overlap"));
  await acknowledgeMessages({ ...options, deliveryId: batch.deliveryId! });
  git(f.b, "merge", "feature/a", "-m", "resolve overlap");
  await scanCoordination();
  const resolved = await receiveMessages(options);
  assert.equal(reports(resolved)[0].status, "resolved");
  assert.notEqual(resolved.deliveryId, batch.deliveryId);
});

test("observation includes staged-only changes without changing the user's index", async (t) => {
  const f = await fixture(t);
  const options = await subscribe(f.b);
  await writeFile(join(f.b, "shared.txt"), "staged only\n");
  git(f.b, "add", "shared.txt");
  await writeFile(join(f.b, "shared.txt"), "base\n");
  await f.commit(f.a, "shared.txt", "peer\n");
  await trackRepository(f.b);
  await scanCoordination();
  const batch = await receiveMessages(options);
  assert.ok(
    reports(batch)
      .flatMap((report) => report.findings)
      .some((issue: any) => issue.target.kind === "index" && issue.level === "conflict"),
  );
  assert.equal(git(f.b, "show", ":shared.txt"), "staged only\n");
});

test("unknown history is not reported as clean and disabling tracking preserves state", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f.b);
  const observer = await openObserver(repo.directory);
  await importRefs(observer, repo.common, repo.id);
  const revision: Revision = { id: "ours", kind: "branch", repository: "test", ref: "main", commit: f.initial };
  const result = await compareRevisions(observer, revision, { ...revision, id: "missing", commit: "f".repeat(40) });
  assert.equal(result?.level, "unknown");
  const options = await subscribe(f.b);
  const tracking = await trackRepository(f.b);
  const session = await readSession(repo, sessionKey(repo, mcpIdentity(options.sessionToken), options.ref));
  assert.ok(session);
  await trackRepository(f.a, { enabled: false });
  assert.equal((await coordinationStatus(f.b)).tracking?.enabled, false);
  await publishCoordination(repo, session, tracking.source, "stale disabled scan", true);
  await trackRepository(f.b, { source: "https://example.invalid/unrelated" });
  await publishCoordination(repo, session, tracking.source, "stale old-source scan", true);
  assert.deepEqual(await eventsIn(repo), []);
});

test("nested local clones discover their intermediate repositories and share the original source", async (t) => {
  const f = await fixture(t);
  const first = joinPath(f.root, "first");
  const second = joinPath(f.root, "second");
  git(f.root, "clone", f.main, first);
  git(f.root, "clone", first, second);
  await trackRepository(second);
  const root = (await coordinationStatus(f.main)).tracking;
  assert.equal((await coordinationStatus(first)).tracking?.source, root?.source);
  assert.equal((await coordinationStatus(second)).tracking?.source, root?.source);
  await scanCoordination();
  assert.equal(((await coordinationStatus(second)).report as any).repositories.length, 3);
});

test("an unavailable related clone becomes unknown without blocking healthy members", async (t) => {
  const f = await fixture(t);
  const clone = joinPath(f.root, "clone");
  const absent = joinPath(f.root, "temporarily-absent");
  git(f.root, "clone", f.main, clone);
  await subscribe(f.b);
  await trackRepository(clone);
  await rename(clone, absent);
  try {
    await scanCoordination();
    const report = (await coordinationStatus(f.b)).report as any;
    assert.ok(report.errors.length > 0);
    assert.ok(report.revisions.some((revision: Revision) => revision.ref === "refs/heads/main"));
  } finally {
    await rename(absent, clone);
  }
  await scanCoordination();
  assert.deepEqual(((await coordinationStatus(f.b)).report as any).errors, []);
});

test("file/directory conflicts are confirmed by Git, and corrupt publication cursors fail closed", async (t) => {
  const f = await fixture(t);
  const options = await subscribe(f.b);
  git(f.b, "rm", "shared.txt");
  await mkdir(joinPath(f.b, "shared.txt"));
  await f.commit(f.b, "shared.txt/nested.txt", "nested file\n");
  await f.commit(f.a, "shared.txt", "peer file\n");
  await trackRepository(f.b);
  await scanCoordination();
  const batch = await receiveMessages(options);
  assert.ok(
    reports(batch)
      .flatMap((report) => report.findings)
      .some((issue: any) => issue.level === "conflict"),
  );
  const repo = await repository(f.b);
  const key = sessionKey(repo, mcpIdentity(options.sessionToken), options.ref);
  const cursor = joinPath(repo.directory, "receipts", key, "coordination.json");
  await writeFile(cursor, '{"digest":"corrupt"}');
  await assert.rejects(scanCoordination(), /Corrupt coordination cursor/);
  assert.equal(await readFile(cursor, "utf8"), '{"digest":"corrupt"}');
});

test("normalizes SSH/HTTPS/local source identities and rejects credential-bearing URLs", async (t) => {
  const f = await fixture(t);
  assert.equal(await normalizeSource("git@github.com:Owner/Repo.git", f.main), "https://github.com/owner/repo");
  assert.equal(await normalizeSource("https://github.com/Owner/Repo.git", f.main), "https://github.com/owner/repo");
  assert.equal(await normalizeSource(f.main, f.main), pathToFileURL(joinPath(f.main, ".git")).href);
  await assert.rejects(normalizeSource("https://user:secret@github.com/owner/repo", f.main), /credentials/);
  await assert.rejects(normalizeSource("ext::danger", f.main), /Unsupported/);
  const cycle = joinPath(f.root, "cycle");
  git(f.root, "clone", f.main, cycle);
  git(f.main, "remote", "add", "origin", cycle);
  assert.equal(await normalizeSource(f.main, f.root), await normalizeSource(cycle, f.root));
});
