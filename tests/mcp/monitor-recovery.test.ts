import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mkdir, readFile, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fixture, git } from "../helpers.ts";
import { connectMcp } from "./helpers.ts";
import { repository } from "../../src/core/repository.ts";
import { trackRepository } from "../../src/core/coordination.ts";
import { addWorktree } from "../../src/core/git.ts";

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 20000): Promise<T> {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  assert.fail("Monitor did not reach the expected state");
}
const exists = async (path: string) =>
  !!(await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return;
    throw error;
  }));

test(
  "SIGKILL of a monitor owner is followed by automatic takeover and a real pushed conflict",
  { timeout: 35000 },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.b, "shared.txt"), "unfinished receiver work\n");
    await trackRepository(f.b);
    const first = await connectMcp(t, f.b);
    const second = await connectMcp(t, f.a);
    const firstJoin = await first.call("join_session");
    const secondJoin = await second.call("join_session");
    await eventually(
      () => first.call("coordination_status"),
      (status) => !!status.report,
    );
    const initial = await eventually(
      () => first.call("monitor_status"),
      (status) => status.running,
    );
    const owner = initial.state.pid;
    assert.ok([first.transport.pid, second.transport.pid].includes(owner));
    const repo = await repository(f.b);
    await eventually(
      async () =>
        !(await exists(join(repo.directory, "coordination.lock"))) &&
        !(await exists(join(repo.directory, "publish.lock"))),
      Boolean,
    );
    const survivor = owner === first.transport.pid ? second : first;
    const notifications: unknown[] = [];
    survivor.client.setNotificationHandler("notifications/resources/updated", async (message) => {
      notifications.push(await survivor.client.readResource({ uri: message.params.uri }));
    });
    await survivor.client.listen({
      resourceSubscriptions: [survivor === first ? firstJoin.inboxUri : secondJoin.inboxUri],
    });
    process.kill(owner, "SIGKILL");
    const commit = await f.commit(f.a, "shared.txt", "peer conflict after crash\n");
    const after = await eventually(
      () => survivor.call("monitor_status"),
      (status) => status.running && status.state.pid === survivor.transport.pid,
    );
    assert.notEqual(after.state.pid, owner);
    await eventually(
      () => survivor.call("coordination_status"),
      (status) => status.report?.revisions.some((revision: any) => revision.commit === commit),
    );
    await eventually(
      async () => notifications.some((message) => JSON.stringify(message).includes("conflict")),
      Boolean,
    );
    assert.equal(await readFile(join(f.b, "shared.txt"), "utf8"), "unfinished receiver work\n");
    assert.equal(git(f.b, "rev-parse", "HEAD").trim(), f.initial);
  },
);

test(
  "a stalled SSH source does not block first or subsequent healthy-source scans",
  { timeout: 40000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const extra = join(f.root, "extra");
    await mkdir(extra);
    git(extra, "init", "-b", "main");
    await writeFile(join(extra, "shared.txt"), "base\n");
    git(extra, "add", ".");
    git(extra, "commit", "-m", "initial");
    const extraPeer = await addWorktree(extra, join(f.root, "extra-peer"), "peer", true);
    const extraReceiver = await addWorktree(extra, join(f.root, "extra-receiver"), "receiver", true);
    const firstRepo = await repository(f.main),
      secondRepo = await repository(extra);
    const slow = firstRepo.id.localeCompare(secondRepo.id) < 0 ? f.main : extra;
    const healthy = slow === f.main ? extraReceiver : f.b;
    const peer = slow === f.main ? extraPeer : f.a;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const previous = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND =
      "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=60";
    t.after(() => {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previous;
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    git(slow, "remote", "add", "origin", `ssh://git@127.0.0.1:${address.port}/unavailable.git`);
    await trackRepository(slow);
    await trackRepository(healthy);
    await writeFile(join(healthy, "shared.txt"), "unfinished healthy work\n");
    const first = await f.commit(peer, "shared.txt", "peer conflict one\n");
    const { call } = await connectMcp(t, healthy);
    await call("join_session");
    await eventually(
      async () => sockets.size,
      (count) => count > 0,
    );
    await eventually(
      () => call("coordination_status"),
      (status) => status.report?.revisions.some((revision: any) => revision.commit === first),
    );
    const second = await f.commit(peer, "shared.txt", "peer conflict two\n");
    const status = await eventually(
      () => call("coordination_status"),
      (status) => status.report?.revisions.some((revision: any) => revision.commit === second),
    );
    assert.ok(sockets.size > 0, "The unrelated SSH handshake must still be stalled");
    assert.ok(
      status.report.sessions.some((session: any) => session.issues.some((issue: any) => issue.level === "conflict")),
    );
    assert.equal((await call("monitor_status")).running, true);
    assert.equal(await readFile(join(healthy, "shared.txt"), "utf8"), "unfinished healthy work\n");
  },
);
