import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { observeGitHub, resolveGitHubSource } from "../dist/core/cloud.js";
import { openObserver, observationGit } from "../dist/core/conflicts.js";
import { repository } from "../dist/core/repository.js";
import { eventsIn, readReceipt } from "../dist/core/mailbox.js";

// Read-only GitHub calls. Test modifications, Git objects and coordination state stay in a disposable local directory.
const source = process.argv[2] ?? "https://github.com/koriym/Koriym.Psr4List";
const project = fileURLToPath(new URL("../", import.meta.url));
const temp = await realpath(await mkdtemp(join(tmpdir(), "gitrelay-live-")));
const previousState = process.env.WORKTREE_SYNC_STATE_DIR;
process.env.WORKTREE_SYNC_STATE_DIR = join(temp, "state");
const summary = {
  startedAt: new Date().toISOString(),
  node: process.version,
  git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
  remoteWrites: false,
  passed: false,
};
let client;
try {
  const canonical = await resolveGitHubSource(source);
  const observer = await openObserver(temp);
  const snapshot = await observeGitHub(observer, canonical);
  assert.deepEqual(snapshot.errors, [], "Live GitHub inventory must be complete");
  const pull = snapshot.revisions.find((revision) => revision.kind === "pr");
  assert.ok(pull?.base, "Choose a source with an accessible open PR; none is available now");
  summary.github = {
    source: canonical,
    repositories: snapshot.repositories,
    branches: snapshot.revisions.filter((revision) => revision.kind === "remote").length,
    pullRequests: snapshot.revisions.filter((revision) => revision.kind === "pr").map((revision) => revision.url),
  };
  const root = join(temp, "work");
  await mkdir(root);
  await observationGit(root, ["init", "-q", "-b", "main"]);
  await observationGit(root, ["fetch", "-q", "--", observer, pull.base], undefined, undefined, {
    GIT_ALLOW_PROTOCOL: "file",
  });
  await observationGit(root, ["checkout", "-q", "-B", "main", pull.base]);
  await observationGit(root, ["remote", "add", "origin", `${canonical}.git`]);
  const names = (
    await observationGit(
      observer,
      ["diff", "--name-only", "--no-renames", "-z", pull.base, pull.commit, "--"],
      undefined,
      "paths",
    )
  )
    .split("\0")
    .filter(Boolean);
  let file;
  for (const candidate of names) {
    const path = resolve(root, candidate);
    if (!path.startsWith(root + sep) || candidate.split("/").includes("..")) continue;
    const parents = candidate.split("/").slice(0, -1);
    let parent = root;
    let safe = true;
    for (const part of parents) {
      parent = join(parent, part);
      const info = await lstat(parent).catch(() => undefined);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) safe = false;
    }
    const info = await lstat(path).catch(() => undefined);
    if (!safe || (info && (!info.isFile() || info.isSymbolicLink()))) continue;
    file = candidate;
    break;
  }
  assert.ok(file, "No safe regular changed file exists for a real conflict probe");
  await mkdir(dirname(join(root, file)), { recursive: true });
  const content = "GitRelay live acceptance: incompatible local modification\n";
  await writeFile(join(root, file), content);
  const refs = await observationGit(root, ["for-each-ref"]);
  const index = await readFile(join(root, ".git", "index"));
  const pushed = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(project, "dist/mcp/main.js"), "--cwd", root],
    env: process.env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-8192);
  });
  client = new Client({ name: "gitrelay-live-acceptance", version: "1.0.0" });
  client.setNotificationHandler("notifications/message", (message) => {
    pushed.push(message);
  });
  const updates = [];
  client.setNotificationHandler("notifications/resources/updated", (message) => {
    updates.push(message);
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };
  const joined = await call("join_session");
  await call("track_repository", { github: true });
  const deadline = performance.now() + 120_000;
  let report;
  while (performance.now() < deadline) {
    if (pushed.some((message) => JSON.stringify(message).includes("conflict"))) {
      report = (await call("coordination_status")).report;
      if (
        report?.sessions.some((session) =>
          session.issues.some((issue) => issue.level === "conflict" && issue.incoming.url === pull.url),
        )
      )
        break;
    }
    await delay(1000);
  }
  assert.ok(
    report?.sessions.some((session) =>
      session.issues.some((issue) => issue.level === "conflict" && issue.incoming.url === pull.url),
    ),
    `No actual PR conflict notification arrived. ${diagnostics}`,
  );
  assert.deepEqual(report.errors, []);
  assert.ok(updates.length > 0);
  const resource = await client.readResource({ uri: joined.inboxUri });
  assert.ok(JSON.stringify(resource).includes(pull.url));
  const repo = await repository(root);
  const event = (await eventsIn(repo)).find(
    (event) => event.sender.adapter === "git-relay" && event.kind === "message" && event.text.includes(pull.url),
  );
  assert.ok(event);
  assert.equal(await readReceipt(repo, joined.session.key, event.id), undefined);
  const batch = await call("receive_messages", { sessionToken: joined.sessionToken });
  await call("acknowledge_messages", { sessionToken: joined.sessionToken, deliveryId: batch.deliveryId });
  assert.equal((await readReceipt(repo, joined.session.key, event.id))?.status, "delivered");
  assert.equal(await readFile(join(root, file), "utf8"), content);
  assert.equal(await observationGit(root, ["for-each-ref"]), refs);
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  summary.endToEnd = {
    pullRequest: pull.url,
    file,
    realGitConflict: true,
    automaticPush: true,
    resourceUpdate: true,
    explicitAcknowledgement: true,
    userRefsIndexAndWorkPreserved: true,
  };
  summary.passed = true;
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  await client?.close();
  await rm(temp, { recursive: true, force: true });
  if (previousState === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
  else process.env.WORKTREE_SYNC_STATE_DIR = previousState;
  summary.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
