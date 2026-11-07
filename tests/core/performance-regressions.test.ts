import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { onlineSessions } from "../../src/core/connections.ts";
import { coordinationStatus, scanCoordination, trackRepository } from "../../src/core/coordination.ts";
import { newSessionToken, mcpIdentity } from "../../src/core/mcp-mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { enableSession } from "../../src/core/session-lifecycle.ts";
import { hash } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";
async function reader(cwd: string) {
  const sessionToken = newSessionToken();
  const session = await enableSession({ cwd, ref, ...mcpIdentity(sessionToken) });
  assert.ok(session);
  return { sessionToken, session, cwd, ref };
}

test("online presence reads are bounded, deduplicate shared sessions and refresh closures on the next observation", async (t) => {
  const f = await fixture(t),
    enrolled = await reader(f.b),
    repo = await repository(f.b);
  const directory = join(repo.directory, "connections");
  await mkdir(directory);
  for (let n = 0; n < 40; n++) {
    const id = hash(["presence", n]);
    await writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({ connection: id, pid: process.pid, expiresAt: Date.now() + 10000, keys: [enrolled.session.key] }),
    );
  }
  const original = fs.promises.open;
  let active = 0,
    peak = 0,
    sessionReads = 0;
  const patched = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === join(repo.directory, "sessions", `${enrolled.session.key}.json`)) sessionReads++;
    active++;
    peak = Math.max(peak, active);
    try {
      return await original(...args);
    } finally {
      active--;
    }
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await onlineSessions(repo), [enrolled.session.key]);
    assert.ok(peak <= 16, `Opened ${peak} state paths concurrently`);
    assert.ok(sessionReads <= 16, `Repeated ${sessionReads} session reads`);
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
  const path = join(repo.directory, "sessions", `${enrolled.session.key}.json`);
  const session = JSON.parse(await readFile(path, "utf8"));
  session.closedAt = new Date().toISOString();
  await writeFile(path, JSON.stringify(session));
  assert.deepEqual(await onlineSessions(repo), []);
});

test("failed presence observations drain in-flight reads before rejecting", async (t) => {
  const f = await fixture(t),
    repo = await repository(f.b),
    directory = join(repo.directory, "connections");
  await mkdir(directory);
  const ids = [hash("invalid"), hash("slow")];
  await writeFile(join(directory, `${ids[0]}.json`), "{}");
  const slow = join(directory, `${ids[1]}.json`);
  await writeFile(
    slow,
    JSON.stringify({ connection: ids[1], pid: process.pid, expiresAt: Date.now() + 10000, keys: [] }),
  );
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>(),
    original = fs.promises.open;
  const patched = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
    if (args[0] === slow) {
      entered.resolve();
      await gate.promise;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  let settled = false;
  const pending = onlineSessions(repo).finally(() => {
    settled = true;
  });
  pending.catch(() => {});
  try {
    await entered.promise;
    await delay(15);
    assert.equal(settled, false);
    gate.resolve();
    await assert.rejects(pending, /Corrupt connection presence/);
  } finally {
    gate.resolve();
    await pending.catch(() => {});
    patched.mock.restore();
    syncBuiltinESMExports();
  }
});

test(
  "scan-local commit reuse preserves receiver roots and refreshes after worktree changes",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await reader(f.b);
    await reader(f.c);
    await trackRepository(f.b);
    await f.commit(f.a, "shared.txt", "peer edit\n");
    for (const cwd of [f.b, f.c]) await writeFile(join(cwd, "shared.txt"), "same unfinished edit\n");
    await scanCoordination();
    const first = (await coordinationStatus(f.b)).report as {
      sessions: { key: string; issues: { level: string; target: { root: string } }[] }[];
    };
    assert.equal(first.sessions.length, 2);
    const roots = new Set<string>();
    for (const session of first.sessions) {
      assert.ok(session.issues.some((issue) => issue.level === "conflict"));
      for (const issue of session.issues) roots.add(issue.target.root);
    }
    assert.deepEqual(roots, new Set([f.b, f.c]));
    for (const cwd of [f.b, f.c]) await writeFile(join(cwd, "shared.txt"), "base\n");
    await scanCoordination();
    const second = (await coordinationStatus(f.b)).report as typeof first;
    assert.ok(
      second.sessions.every((session) => session.issues.length === 0),
      "A previous scan's conflict survived a fresh snapshot",
    );
  },
);
