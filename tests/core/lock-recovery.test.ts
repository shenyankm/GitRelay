import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fixture } from "../helpers.ts";
import { BusyError, readJson, withLock, writeJson } from "../../src/core/store.ts";

async function deadPid() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  const pid = child.pid!;
  child.kill("SIGKILL");
  await exited;
  return pid;
}

test("opt-in recovery replaces only a verified dead owner; live/ownerless locks remain protected", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "recovery.lock");
  const pid = await deadPid();
  await writeJson(path, { pid, token: "dead owner" });
  await withLock(path, async () => assert.equal(((await readJson(path)) as any).pid, process.pid), {
    recoverDeadOwner: true,
  });
  await writeJson(path, { pid: process.pid, token: "live owner" });
  await assert.rejects(
    withLock(path, async () => assert.fail("must not steal"), { recoverDeadOwner: true }),
    BusyError,
  );
  assert.equal(((await readJson(path)) as any).token, "live owner");
  await writeFile(path, "{");
  await assert.rejects(
    withLock(path, async () => assert.fail(), { recoverDeadOwner: true }),
    /Cannot read/,
  );
  assert.equal(await readFile(path, "utf8"), "{");
});

test("SIGKILL during recovery cannot leave an unrecoverable recovery mutex", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "recoverer.lock");
  const directory = `${path}.recovery`;
  await writeJson(path, { pid: await deadPid() });
  const source = new URL("../../src/core/store.ts", import.meta.url).href;
  const program = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {withLock} from ${JSON.stringify(source)};
    const path=process.argv[1], rename=fs.renameSync;
    fs.renameSync=(from,to)=>{
      rename(from,to);
      if(String(to).startsWith(path+'.recovery/')){
        fs.writeSync(1,'choosing\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }
    };
    syncBuiltinESMExports();
    await withLock(path,async()=>{}, {recoverDeadOwner:true});
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program, path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await Promise.race([
    once(child.stdout, "data"),
    exited.then(() => {
      throw new Error(stderr || "recovery worker exited before publication");
    }),
  ]);
  child.kill("SIGKILL");
  await exited;
  const records = await readdir(directory);
  assert.equal(records.length, 1);
  assert.deepEqual(await readJson(join(directory, records[0])), { pid: child.pid, ticket: null });
  await withLock(path, async () => {}, { recoverDeadOwner: true });
  assert.deepEqual(await readdir(directory), []);
});

test("live choosing tickets and corrupt recovery records cannot authorize reclamation", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "protected.lock");
  const pid = await deadPid();
  await writeJson(path, { pid });
  const directory = `${path}.recovery`;
  await mkdir(directory);
  const ticket = join(directory, `${"a".repeat(64)}.json`);
  await writeJson(ticket, { pid: process.pid, ticket: null });
  await assert.rejects(
    withLock(path, async () => assert.fail(), { recoverDeadOwner: true, signal: AbortSignal.timeout(60) }),
    /abort/i,
  );
  assert.equal(((await readJson(path)) as any).pid, pid);
  assert.deepEqual(await readdir(directory), [ticket.split("/").at(-1)]);
  await writeFile(ticket, "{");
  await assert.rejects(
    withLock(path, async () => assert.fail(), { recoverDeadOwner: true }),
    SyntaxError,
  );
  assert.equal(await readFile(ticket, "utf8"), "{");
  assert.equal(((await readJson(path)) as any).pid, pid);
});

test(
  "eight real processes contend for one stale lock without overlapping or exposing partial ownership",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const path = join(f.root, "contended.lock");
    const log = join(f.root, "entries.jsonl");
    await writeJson(path, { pid: await deadPid() });
    const source = new URL("../../src/core/store.ts", import.meta.url).href;
    const program = `
    import {withLock,readJson} from ${JSON.stringify(source)};
    import {appendFile} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    const [path,log]=process.argv.slice(1);
    await withLock(path,async()=>{
      if((await readJson(path)).pid!==process.pid)throw Error('wrong owner');
      await appendFile(log,JSON.stringify({type:'enter',pid:process.pid})+'\\n');
      await delay(25);
      await appendFile(log,JSON.stringify({type:'exit',pid:process.pid})+'\\n');
    },{recoverDeadOwner:true,waitMs:10000,signal:AbortSignal.timeout(12000)});
  `;
    const children = Array.from({ length: 8 }, () => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", program, path, log],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`))));
      });
      void done.catch(() => {});
      return { child, done };
    });
    t.after(async () => {
      for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.allSettled(children.map(({ done }) => done));
    });
    let finished = false;
    const done = Promise.allSettled(children.map(({ done }) => done)).then((results) => {
      finished = true;
      return results;
    });
    while (!finished) {
      const value = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return;
        throw error;
      });
      if (value !== undefined) assert.ok(Number.isInteger(JSON.parse(value).pid));
      await delay(1);
    }
    for (const result of await done) if (result.status === "rejected") throw result.reason;
    const entries = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 16);
    for (let index = 0; index < entries.length; index += 2) {
      assert.equal(entries[index].type, "enter");
      assert.equal(entries[index + 1].type, "exit");
      assert.equal(entries[index].pid, entries[index + 1].pid);
    }
  },
);

test("a lock replaced during dead-owner verification is not unlinked by its recoverer", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "handoff.lock");
  const replacement = join(f.root, "replacement");
  const pid = await deadPid();
  await writeJson(path, { pid });
  await writeJson(replacement, { pid: process.pid, token: "replacement" });
  const kill = process.kill.bind(process);
  let probes = 0;
  t.mock.method(process, "kill", ((owner: number, signal?: NodeJS.Signals | number) => {
    if (owner === pid && ++probes === 2) {
      // Replacement happens between the ownership read and its identity recheck.
      renameSync(replacement, path);
    }
    return kill(owner, signal);
  }) as typeof process.kill);
  await assert.rejects(
    withLock(path, async () => assert.fail(), { recoverDeadOwner: true }),
    BusyError,
  );
  assert.equal(((await readJson(path)) as any).token, "replacement");
});
