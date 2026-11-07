import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { beforeFixtureCleanup, fixture } from "../helpers.ts";
import { readReceipt } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";

const entry = fileURLToPath(new URL("../../dist/mcp/main.js", import.meta.url));

test(
  "2025 MCP resource subscriptions are explicit, connection-bound and never acknowledge messages",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const client = new Client({ name: "resource-subscription-test", version: "1.0.0" });
    beforeFixtureCleanup(t, () => client.close());
    const updates: string[] = [];
    const logs: unknown[] = [];
    let listChanges = 0;
    client.setNotificationHandler("notifications/resources/list_changed", () => {
      listChanges++;
    });
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      updates.push(notification.params.uri);
    });
    client.setNotificationHandler("notifications/message", (notification) => {
      logs.push(notification);
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry, "--cwd", f.b],
        env: process.env as Record<string, string>,
        stderr: "pipe",
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.structuredContent as Record<string, any>;
    };
    const scanWhenIdle = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await client.callTool({ name: "scan_repository", arguments: {} });
        if (!result.isError) return;
        // The shared monitor can own a scan; busy means this explicit scan never started.
        assert.match(JSON.stringify(result.content), /gitbeacon is busy:.*coordination\.lock/);
        await delay(100);
      }
      assert.fail("Monitor never yielded the coordination scan lock");
    };
    const joined = await call("join_session");
    const uri = joined.inboxUri;
    assert.deepEqual(
      (await client.listResources()).resources.map((resource) => resource.uri),
      [uri],
    );
    await assert.rejects(client.subscribeResource({ uri: `gitbeacon://inbox/${"0".repeat(64)}` }), /not bound/);
    await call("track_repository");
    await writeFile(join(f.b, "shared.txt"), "unfinished receiver change\n");
    await f.commit(f.a, "shared.txt", "peer conflict\n");
    await scanWhenIdle();
    await delay(1200);
    assert.deepEqual(updates, [], "Unsubscribed connections must not receive resource updates");
    await client.subscribeResource({ uri });
    for (let i = 0; i < 30 && !updates.length; i++) await delay(100);
    assert.ok(updates.length > 0);
    assert.ok(updates.every((updated) => updated === uri));
    assert.match(JSON.stringify(await client.readResource({ uri })), /conflict/);
    const batch = await call("receive_messages", { sessionToken: joined.sessionToken });
    assert.ok(batch.notifications.length > 0);
    const repo = await repository(f.b);
    for (const notification of batch.notifications)
      assert.equal(await readReceipt(repo, joined.session.key, notification.event.id), undefined);
    await call("acknowledge_messages", { sessionToken: joined.sessionToken, deliveryId: batch.deliveryId });
    await client.unsubscribeResource({ uri });
    await delay(1100);
    const count = updates.length;
    await f.commit(f.a, "shared.txt", "a different peer conflict\n");
    await scanWhenIdle();
    await delay(1200);
    assert.equal(updates.length, count, "Unsubscribed connections must stop receiving updates");
    assert.deepEqual(logs, [], "Business notices must not use the logging surface");
    await call("leave_session", { sessionToken: joined.sessionToken });
    assert.deepEqual((await client.listResources()).resources, []);
    assert.ok(listChanges >= 2, "Joining and leaving must announce resource-list changes");
    await assert.rejects(client.subscribeResource({ uri }), /not bound/);
  },
);
