import assert from "node:assert/strict";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectRepository, repository } from "../../src/core/repository.ts";
import { hash, stateDirectory } from "../../src/core/store.ts";
import { fixture } from "../helpers.ts";

test("repository inspection preserves missing identity and state without creating locks", async (t) => {
  const f = await fixture(t);
  const empty = await inspectRepository(f.b);
  assert.equal(empty.id, null);
  assert.equal(empty.repository, undefined);
  const identity = "a".repeat(64);
  await writeFile(join(empty.common, ".gitbeacon-id"), `${identity}\n`);
  const observed = await inspectRepository(f.b);
  assert.equal(observed.id, hash([empty.common, identity]));
  assert.equal(observed.repository, undefined);
  await assert.rejects(access(stateDirectory()), { code: "ENOENT" });
  assert.equal(await readFile(join(empty.common, ".gitbeacon-id"), "utf8"), `${identity}\n`);
});

test("repository inspection reads initialized state without recreating identity locks", async (t) => {
  const f = await fixture(t);
  const initialized = await repository(f.b);
  const locks = join(stateDirectory(), "identity-locks");
  await rm(locks, { recursive: true });
  const before = await readdir(stateDirectory());
  const observed = await inspectRepository(f.b);
  assert.deepEqual(observed.repository, initialized);
  assert.deepEqual(await readdir(stateDirectory()), before);
  await assert.rejects(access(locks), { code: "ENOENT" });
  const ready = join(initialized.directory, "identity-ready.json");
  await rm(ready);
  const incomplete = await inspectRepository(f.b);
  assert.equal(incomplete.id, initialized.id);
  assert.equal(incomplete.repository, undefined);
  await assert.rejects(access(ready), { code: "ENOENT" });
});

test("repository inspection rejects damaged ownership without rewriting state", async (t) => {
  const f = await fixture(t);
  const initialized = await repository(f.b);
  const owner = join(initialized.directory, "identity-owner.json");
  const original = await readFile(owner, "utf8");
  const damaged = JSON.stringify({ id: "b".repeat(64) });
  await writeFile(owner, damaged);
  await assert.rejects(inspectRepository(f.b), /Incomplete gitbeacon state initialization/);
  assert.equal(await readFile(owner, "utf8"), damaged);
  await writeFile(owner, original);
});
