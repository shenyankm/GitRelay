import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { eventsIn, type SharedEvent, type UpstreamEvent } from "../../src/core/mailbox.ts";
import { hash, repository, withLock, writeJson } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

test("repeated transitions preserve causal order with bounded hashing, messages and receipt filtering", async (t) => {
  const f = await fixture(t),
    repo = await repository(f.b),
    key = hash("receiver");
  const receipts = join(repo.directory, "receipts", key);
  await mkdir(receipts);
  const events: SharedEvent[] = [],
    chains = new Map<string, UpstreamEvent[]>();
  const sender = { adapter: "test", session: "sender", root: f.main };
  const commits = ["a".repeat(40), "b".repeat(40)];
  for (const ref of ["refs/heads/main", "refs/heads/other"]) {
    const chain: UpstreamEvent[] = [];
    for (let index = 0; index < 65; index++) {
      const previous = chain.at(-1)?.commit ?? "c".repeat(40);
      const commit = index && index % 7 === 0 ? previous : commits[index % 2];
      // The first ordinary publication follows migration even without its ID as salt.
      const salt = index === 0 ? `migration:${key}` : index === 1 ? "" : chain.at(-1)!.id;
      chain.push({
        id: hash(["upstream", ref, previous, commit, salt]),
        kind: "upstream",
        ref,
        previous,
        commit,
        createdAt: new Date(1_700_000_000_000 - index * 2).toISOString(),
        sender,
        recipients: [key],
      });
    }
    chains.set(ref, chain);
    events.push(...chain);
  }
  for (const index of [0, 20, 40, 60])
    events.push({
      id: hash(["message", index]),
      kind: "message",
      text: "independent",
      files: [],
      createdAt: new Date(1_700_000_000_000 - index * 2 - 1).toISOString(),
      sender,
      recipients: [key],
    });
  for (const event of events)
    await writeFile(join(repo.directory, "events", `${event.id}.json`), JSON.stringify(event));
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const scan = () => withLock(join(repo.directory, "sessions", `${key}.lock`), () => eventsIn(repo, key));
  let hashes = 0;
  const createHash = crypto.createHash;
  const counted = t.mock.method(crypto, "createHash", (...args: Parameters<typeof createHash>) => {
    hashes++;
    return createHash(...args);
  });
  syncBuiltinESMExports();
  try {
    const ordered = await scan();
    for (const [ref, chain] of chains)
      assert.deepEqual(
        ordered.filter((event) => event.kind === "upstream" && event.ref === ref),
        chain,
      );
    const slots = (items: SharedEvent[]) => items.map((event) => (event.kind === "message" ? event.id : "upstream"));
    assert.deepEqual(slots(ordered), slots(sorted), "Reordering upstream events must not move messages");
    assert.ok(hashes < events.length * 8, `Repeated transitions used ${hashes} hashes for ${events.length} events`);
  } finally {
    counted.mock.restore();
    syncBuiltinESMExports();
  }
  for (const chain of chains.values())
    for (const event of chain.slice(0, 8))
      await writeJson(join(receipts, `${event.id}.json`), {
        eventId: event.id,
        status: "delivered",
        at: event.createdAt,
      });
  const remaining = await scan();
  for (const [ref, chain] of chains)
    assert.deepEqual(
      remaining.filter((event) => event.kind === "upstream" && event.ref === ref),
      chain.slice(8),
    );
  assert.equal((await readdir(join(repo.directory, "events"))).length, events.length);
  assert.equal((await readdir(receipts)).length, 16, "Scanning must not create receipts");
});
