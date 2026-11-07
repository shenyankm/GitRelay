import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fixture } from "../helpers.ts";
import { connectMcp } from "./helpers.ts";
import { eventsIn, readReceipt } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";

async function eventually(check: () => Promise<boolean>, milliseconds = 15000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail("Timed out awaiting automatic coordination");
}

test(
  "real stdio processes automatically detect peer conflicts, push the bound inbox, and preserve unread data on disconnect",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const receiver = await connectMcp(t, f.b);
    const observer = await connectMcp(t, f.a);
    const updates: any[] = [];
    receiver.client.setNotificationHandler("notifications/resources/updated", (message) => {
      updates.push(message);
    });
    const joined = await receiver.call("join_session");
    assert.equal(joined.inboxUri, `gitbeacon://inbox/${joined.session.key}`);
    const subscription = await receiver.client.listen({ resourceSubscriptions: [joined.inboxUri] });
    assert.deepEqual(subscription.honoredFilter.resourceSubscriptions, [joined.inboxUri]);
    await observer.call("track_repository");
    await writeFile(join(f.b, "shared.txt"), "my unfinished change\n");
    await f.commit(f.a, "shared.txt", "peer unmerged change\n");
    await eventually(async () => updates.length > 0);
    assert.ok(updates.length > 0);
    assert.ok(updates.every((update) => JSON.stringify(update).includes(joined.inboxUri)));
    const resources = await receiver.client.readResource({ uri: joined.inboxUri });
    assert.match(JSON.stringify(resources), /peer unmerged|conflict/);
    const repo = await repository(f.b);
    const event = (await eventsIn(repo)).find(
      (event) => event.sender.adapter === "gitbeacon" && event.recipients.includes(joined.session.key),
    );
    assert.ok(event);
    assert.equal(await readReceipt(repo, joined.session.key, event.id), undefined);
    await assert.rejects(observer.client.readResource({ uri: joined.inboxUri }));
    await eventually(
      async () =>
        (await observer.call("list_sessions")).sessions.find((session: any) => session.key === joined.session.key)
          ?.online === true,
    );
    await receiver.client.close();
    await eventually(
      async () =>
        (await observer.call("list_sessions")).sessions.find((session: any) => session.key === joined.session.key)
          ?.online === false,
    );
    const resumed = await connectMcp(t, f.b);
    const batch = await resumed.call("receive_messages", { sessionToken: joined.sessionToken });
    assert.ok(batch.notifications.some((notification: any) => notification.event.id === event.id));
    await resumed.call("acknowledge_messages", { sessionToken: joined.sessionToken, deliveryId: batch.deliveryId });
    assert.equal((await readReceipt(repo, joined.session.key, event.id))?.status, "delivered");
  },
);

test("tracking is explicit and unknown/disabled states remain observable", async (t) => {
  const f = await fixture(t);
  const { call } = await connectMcp(t, f.b);
  assert.deepEqual(await call("coordination_status"), { tracking: null, report: null });
  await assert.rejects(call("scan_repository"), /Enable tracking/);
  const result = await call("track_repository");
  assert.equal(result.tracking.enabled, true);
  await call("track_repository", { enabled: false });
  assert.equal((await call("coordination_status")).tracking.enabled, false);
  await assert.rejects(call("scan_repository"), /Enable tracking/);
});
