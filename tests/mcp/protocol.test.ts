import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { repository } from "../../src/core/repository.ts";
import { mcpIdentity } from "../../src/core/mcp-mailbox.ts";
import { readReceipt, sessionKey, sendMessage } from "../../src/core/mailbox.ts";
import { fixture, git } from "../helpers.ts";
import { connectMcp } from "./helpers.ts";

test("MCP discovers typed tools and reads new/dirty repositories without state writes", async (t) => {
  const f = await fixture(t);
  const { client, call, stderr } = await connectMcp(t, f.b);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 17);
  assert.equal(client.getServerCapabilities()?.logging, undefined);
  assert.equal(client.getServerCapabilities()?.resources?.subscribe, true);
  const removed = [
    "open_console",
    "list_repositories",
    "add_repository",
    "remove_repository",
    "migrate_repository",
    "retire_session",
  ];
  assert.ok(tools.every((tool) => !removed.includes(tool.name)));
  assert.ok(tools.some((tool) => tool.name === "receive_messages" && tool.annotations?.readOnlyHint === false));
  assert.ok(tools.some((tool) => tool.name === "repository_status" && tool.annotations?.readOnlyHint === true));
  assert.ok(tools.some((tool) => tool.name === "sync_branch" && tool.annotations?.destructiveHint === true));
  assert.match(client.getInstructions() ?? "", /does not inject context/);
  assert.deepEqual((await call("list_sessions")).sessions, []);
  const snapshot = await call("repository_status");
  assert.equal(snapshot.initialized, false);
  assert.equal(snapshot.worktrees.length, 4);
  assert.equal(snapshot.status.value.worktree.branch, "feature/b");
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
  await assert.rejects(access(join(f.main, ".git", ".gitbeacon-id")), { code: "ENOENT" });
  assert.equal(stderr(), "");
  await assert.rejects(call("join_session", { ref: "main" }), /full branch ref/);
  await assert.rejects(call("join_session", { ref: "refs/heads/bad..name" }), /check-ref-format/);
  await assert.rejects(call("send_message", { sessionToken: "spoofed", text: "no" }));
  await assert.rejects(call("branch_status", { repo: "owner/repo" }), /requires github/);
  await assert.rejects(call("open_console"));
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
});

test("independent MCP clients keep unread messages across disconnect and explicitly acknowledge them", async (t) => {
  const f = await fixture(t);
  const receiver = await connectMcp(t, f.b);
  const sender = await connectMcp(t, f.a);
  const joined = await receiver.call("join_session");
  const writer = await sender.call("join_session");
  assert.notEqual(joined.sessionToken, writer.sessionToken);
  assert.notEqual(joined.sessionToken, joined.session.session);
  assert.equal("activationToken" in joined.session, false);
  assert.ok((await receiver.call("list_sessions")).sessions.every((session: any) => !("sessionToken" in session)));
  const sent = await sender.call("send_message", { sessionToken: writer.sessionToken, text: "MCP coordination" });
  assert.equal(sent.recipients, 1);
  const batch = await receiver.call("receive_messages", { sessionToken: joined.sessionToken });
  assert.equal(batch.notifications[0].event.id, sent.eventId);
  const repo = await repository(f.b);
  const key = sessionKey(repo, mcpIdentity(joined.sessionToken), "refs/heads/main");
  assert.equal(await readReceipt(repo, key, sent.eventId), undefined);
  await receiver.client.close();
  const resumed = await connectMcp(t, f.b);
  const again = await resumed.call("receive_messages", { sessionToken: joined.sessionToken });
  assert.equal(again.notifications[0].event.id, sent.eventId);
  assert.equal(again.deliveryId, batch.deliveryId);
  const ack = { sessionToken: joined.sessionToken, deliveryId: again.deliveryId };
  assert.deepEqual((await resumed.call("acknowledge_messages", ack)).acknowledged, [sent.eventId]);
  assert.equal((await resumed.call("acknowledge_messages", ack)).alreadyAcknowledged, true);
  assert.equal((await readReceipt(repo, key, sent.eventId))?.status, "delivered");
  assert.deepEqual((await resumed.call("receive_messages", { sessionToken: joined.sessionToken })).notifications, []);
  await resumed.call("leave_session", { sessionToken: joined.sessionToken });
  await assert.rejects(resumed.call("receive_messages", { sessionToken: joined.sessionToken }), /closed/);
  await resumed.call("join_session", { sessionToken: joined.sessionToken });
  assert.deepEqual((await resumed.call("receive_messages", { sessionToken: joined.sessionToken })).notifications, []);
});

test("one MCP connection selects independent repositories with cwd without a catalog", async (t) => {
  const f = await fixture(t);
  const clone = join(f.root, "clone");
  git(f.root, "clone", f.main, clone);
  const { call } = await connectMcp(t, f.b);
  assert.equal((await call("repository_status", { cwd: clone })).initialized, false);
  const receiver = await call("join_session");
  const other = await call("join_session", { cwd: clone, sessionToken: receiver.sessionToken });
  const sender = await call("join_session", { cwd: f.a });
  assert.notEqual(receiver.session.key, other.session.key);
  const sent = await call("send_message", {
    cwd: f.a,
    sessionToken: sender.sessionToken,
    text: "only this repository",
  });
  const batch = await call("receive_messages", { sessionToken: receiver.sessionToken });
  assert.equal(batch.notifications[0].event.id, sent.eventId);
  assert.deepEqual(
    (await call("receive_messages", { cwd: clone, sessionToken: receiver.sessionToken })).notifications,
    [],
  );
  const summary = await call("repository_status");
  assert.equal(summary.eventsIncluded, false);
  assert.equal(summary.retainedEvents, 1);
  assert.deepEqual(summary.events, []);
  const local = await call("repository_status", { includeEvents: true });
  const remote = await call("repository_status", { cwd: clone });
  assert.equal(local.repository.root, f.b);
  assert.equal(remote.repository.root, clone);
  assert.equal(local.events.length, 1);
  assert.equal(remote.events.length, 0);
  assert.equal(remote.sessions.length, 1);
  await assert.rejects(access(join(f.root, "state", "web-repositories.json")), { code: "ENOENT" });
});

test("MCP pins Unicode branch identities and keeps synchronization explicit", async (t) => {
  const f = await fixture(t);
  const name = "topic\u00a0";
  git(f.a, "branch", "-m", name);
  git(f.main, "tag", name);
  const { call } = await connectMcp(t, f.a);
  const snapshot = await call("branch_status");
  assert.equal(snapshot.local.ref, `refs/heads/${name}`);
  assert.equal(snapshot.worktree.branch, name);
  const sync = await call("sync_branch", { branch: name });
  assert.equal(sync.state, "blocked");
  assert.equal(await readFile(join(f.a, "shared.txt"), "utf8"), "base\n");
  assert.equal(git(f.a, "rev-parse", `refs/heads/${name}`).trim(), f.initial);
});

test("MCP delivers relevant upstream changes without changing dirty work or HEAD", async (t) => {
  const f = await fixture(t);
  const { call } = await connectMcp(t, f.b);
  const { sessionToken } = await call("join_session");
  await writeFile(join(f.b, "shared.txt"), "my unfinished work\n");
  const commit = await f.commit(f.main, "shared.txt", "upstream work\n");
  const batch = await call("receive_messages", { sessionToken });
  assert.equal(batch.notifications.length, 1);
  assert.equal(batch.notifications[0].event.kind, "upstream");
  assert.equal(batch.notifications[0].event.commit, commit);
  assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "my unfinished work\n");
  assert.equal(git(f.b, "rev-parse", "HEAD").trim(), f.initial);
  await call("acknowledge_messages", { sessionToken, deliveryId: batch.deliveryId });
  assert.deepEqual((await call("receive_messages", { sessionToken })).notifications, []);
});

test("large inbox previews stay bounded and details resume across real stdio reconnect before ACK", async (t) => {
  const f = await fixture(t);
  const receiver = await connectMcp(t, f.b);
  const joined = await receiver.call("join_session");
  const text = "😀中文".repeat(2500);
  const event = await sendMessage({ cwd: f.a, adapter: "gitbeacon", session: "fixture", text });
  const resource = await receiver.client.readResource({ uri: joined.inboxUri });
  const content = resource.contents[0];
  assert.ok("text" in content);
  assert.ok(Buffer.byteLength(content.text) < 8192);
  const preview = JSON.parse(content.text);
  assert.equal(preview.previewOnly, true);
  assert.deepEqual(preview.events, [{ id: event.id, kind: "message" }]);
  const batch = await receiver.call("receive_messages", { sessionToken: joined.sessionToken });
  assert.equal(batch.detailsRequired, true);
  const scope = { sessionToken: joined.sessionToken, ref: joined.session.ref, deliveryId: batch.deliveryId };
  await assert.rejects(receiver.call("acknowledge_messages", scope), /Read all/);
  const first = await receiver.call("read_message_details", { ...scope, offset: 0 });
  await receiver.client.close();
  const resumed = await connectMcp(t, f.b);
  await resumed.call("join_session", { sessionToken: joined.sessionToken });
  let offset = first.nextOffset,
    body = first.text;
  for (;;) {
    const part = await resumed.call("read_message_details", { ...scope, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < 8192);
    body += part.text;
    offset = part.nextOffset;
    if (part.complete) break;
  }
  assert.equal(JSON.parse(body)[0].event.text, text);
  assert.deepEqual((await resumed.call("acknowledge_messages", scope)).acknowledged, [event.id]);
});
