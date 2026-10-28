import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sessionKey } from "../../src/core/mailbox.ts";
import { leaveSession } from "../../src/core/sessions.ts";
import {
  hash,
  recoverRepositoryInitialization,
  repository,
  stateDirectory,
  withRepositoryIdentity,
} from "../../src/core/store.ts";
import { fixture, git } from "../helpers.ts";

const exec = promisify(execFile);

test("concurrent processes publish one identity shared across worktrees", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../../src/core/store.ts", import.meta.url).href;
  const source = `import { repository } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await repository(process.argv[1])));`;
  const trees = [f.main, f.a, f.b, f.c];
  const outputs = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      exec(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source, trees[i % trees.length]],
        { env: process.env, timeout: 20_000 },
      ),
    ),
  );
  const repositories = outputs.map(
    ({ stdout }) => JSON.parse(stdout) as { id: string; common: string; directory: string },
  );
  assert.equal(new Set(repositories.map((repo) => repo.id)).size, 1);
  assert.equal(new Set(repositories.map((repo) => repo.common)).size, 1);
  assert.equal(new Set(repositories.map((repo) => repo.directory)).size, 1);
  const marker = await readFile(join(repositories[0].common, ".git-relay-id"), "utf8");
  assert.match(marker, /^[a-f0-9]{64}\n$/);
  const next = await repository(f.b);
  assert.equal(next.id, repositories[0].id);
  assert.equal(await readFile(join(next.common, ".git-relay-id"), "utf8"), marker);
});

test("initialization publishes its owner on the repository state filesystem", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../../src/core/store.ts", import.meta.url).href;
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname } from "node:path";
    const realLink = fs.link;
    fs.link = async (from, to) => {
      if (basename(to) === "identity-owner.json") {
        if (!basename(from).startsWith(".git-relay-owner-") || dirname(from) !== dirname(dirname(to)))
          throw new Error("owner temporary is not in the state filesystem");
        console.log(JSON.stringify({ from, to }));
      }
      return realLink(from, to);
    };
    syncBuiltinESMExports();
    const { repository } = await import(${JSON.stringify(moduleUrl)});
    await repository(process.argv[1]);
  `;
  const { stdout } = await exec(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source, f.main],
    { env: process.env, timeout: 20_000 },
  );
  const paths = JSON.parse(stdout) as { from: string; to: string };
  assert.equal(dirname(paths.from), join(stateDirectory(), "repos"));
  assert.equal(dirname(dirname(paths.to)), dirname(paths.from));
  assert.deepEqual((await readdir(dirname(paths.to))).sort(), [
    "events",
    "identity-owner.json",
    "identity-ready.json",
    "receipts",
    "refs",
    "sessions",
    "trash",
  ]);
});

test("failure writing the initial owner leaves no unowned state directory", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../../src/core/store.ts", import.meta.url).href;
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const realWrite = fs.writeFile;
    fs.writeFile = async (path, ...args) => {
      if (String(path).includes(".git-relay-owner-")) {
        const error = new Error("disk full"); error.code = "ENOSPC"; throw error;
      }
      return realWrite(path, ...args);
    };
    syncBuiltinESMExports();
    const { repository } = await import(${JSON.stringify(moduleUrl)});
    try { await repository(process.argv[1]); process.exitCode = 1; }
    catch (error) { if (error.code !== "ENOSPC") throw error; }
  `;
  await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, f.main], {
    env: process.env,
    timeout: 20_000,
  });
  assert.deepEqual(await readdir(join(stateDirectory(), "repos")), []);
  const repo = await repository(f.main);
  assert.deepEqual(JSON.parse(await readFile(join(repo.directory, "identity-owner.json"), "utf8")), { id: repo.id });
});

test("interruption after publishing the owner can be recovered without deleting it", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../../src/core/store.ts", import.meta.url).href;
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { basename } from "node:path";
    const realLink = fs.link;
    fs.link = async (from, to) => {
      await realLink(from, to);
      if (basename(to) === "identity-owner.json") {
        const error = new Error("interrupted after owner publication"); error.code = "EIO"; throw error;
      }
    };
    syncBuiltinESMExports();
    const { repository } = await import(${JSON.stringify(moduleUrl)});
    try { await repository(process.argv[1]); process.exitCode = 1; }
    catch (error) { if (error.code !== "EIO") throw error; }
  `;
  await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, f.main], {
    env: process.env,
    timeout: 20_000,
  });
  const pending = await withRepositoryIdentity(f.main, undefined, async (repo) => repo);
  await assert.rejects(repository(f.main), /Incomplete GitRelay state initialization/);
  const { archived } = await recoverRepositoryInitialization(f.main);
  assert.deepEqual(JSON.parse(await readFile(join(archived, "identity-owner.json"), "utf8")), { id: pending.id });
  assert.equal((await repository(f.main)).id, pending.id);
});

test("a failed ready write is archived intact before initialization is retried", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../../src/core/store.ts", import.meta.url).href;
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { basename } from "node:path";
    const realOpen = fs.open;
    fs.open = async (path, ...args) => {
      const file = await realOpen(path, ...args);
      if (basename(String(path)).startsWith("identity-ready.json.") && String(path).endsWith(".tmp")) {
        const write = file.writeFile.bind(file);
        file.writeFile = async () => { await write("partial"); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
      }
      return file;
    };
    syncBuiltinESMExports();
    const { repository } = await import(${JSON.stringify(moduleUrl)});
    try { await repository(process.argv[1]); process.exitCode = 1; }
    catch (error) { if (error.cause?.code !== "ENOSPC") throw error; }
  `;
  await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, f.main], {
    env: process.env,
    timeout: 20_000,
  });
  const pending = await withRepositoryIdentity(f.main, undefined, async (repo) => repo);
  const temporary = (await readdir(pending.directory)).find((name) => name.startsWith("identity-ready.json."));
  assert.ok(temporary);
  await assert.rejects(repository(f.main), /Incomplete GitRelay state initialization/);
  const { archived } = await recoverRepositoryInitialization(f.main);
  assert.equal(await readFile(join(archived, temporary), "utf8"), "partial");
  assert.equal((await repository(f.main)).id, pending.id);
});

test("recovery rejects malformed ready temporaries and symlinks", async (t) => {
  const f = await fixture(t);
  const pending = await withRepositoryIdentity(f.main, undefined, async (repo) => repo);
  await mkdir(pending.directory, { recursive: true });
  await writeFile(join(pending.directory, "identity-owner.json"), JSON.stringify({ id: pending.id }));
  const invalid = join(pending.directory, "identity-ready.json.not-a-uuid.tmp");
  await writeFile(invalid, "keep");
  await assert.rejects(recoverRepositoryInitialization(f.main), /contains data/);
  assert.equal(await readFile(invalid, "utf8"), "keep");
  await rm(invalid);
  const target = join(f.root, "outside");
  await writeFile(target, "outside");
  await symlink(target, join(pending.directory, "identity-ready.json.12345678-1234-4123-8123-123456789abc.tmp"));
  await assert.rejects(recoverRepositoryInitialization(f.main), /contains data/);
  assert.equal(await readFile(target, "utf8"), "outside");
});

for (const code of ["EPERM", "EACCES", "EOPNOTSUPP", "ENOTSUP", "EXDEV"]) {
  test(`unsupported owner hard link reports ${code} and preserves unowned state`, async (t) => {
    const f = await fixture(t);
    const moduleUrl = new URL("../../src/core/store.ts", import.meta.url).href;
    const source = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { basename } from "node:path";
      const realLink = fs.link;
      fs.link = async (from, to) => {
        if (basename(from).startsWith(".git-relay-owner-") && basename(to) === "identity-owner.json") {
          const error = new Error("hard links unavailable"); error.code = ${JSON.stringify(code)}; throw error;
        }
        return realLink(from, to);
      };
      syncBuiltinESMExports();
      const { repository } = await import(${JSON.stringify(moduleUrl)});
      try { await repository(process.argv[1]); process.exitCode = 1; }
      catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
    `;
    const { stdout } = await exec(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source, f.main],
      { env: process.env, timeout: 20_000 },
    );
    const result = JSON.parse(stdout) as { code: string; message: string };
    assert.equal(result.code, code);
    assert.match(result.message, /hard link.*inspect and preserve/);
    const pending = await withRepositoryIdentity(f.main, undefined, async (repo) => repo);
    assert.deepEqual(await readdir(pending.directory), []);
    await assert.rejects(repository(f.main), /Incomplete GitRelay state initialization/);
    await assert.rejects(recoverRepositoryInitialization(f.main), /ownership/);
    assert.deepEqual(await readdir(pending.directory), []);
  });
}

test(
  "an existing identity remains usable with a read-only common directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const initial = await repository(f.main);
    const markerPath = join(initial.common, ".git-relay-id");
    const marker = await readFile(markerPath);
    const mode = (await stat(initial.common)).mode & 0o777;
    await chmod(initial.common, 0o555);
    try {
      const reopened = await repository(f.b);
      assert.equal(reopened.id, initial.id);
      assert.deepEqual(await readFile(markerPath), marker);
    } finally {
      await chmod(initial.common, mode);
    }
  },
);

test(
  "a read-only repository without a marker fails with a recovery hint",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async (t) => {
    const f = await fixture(t);
    const common = join(f.main, ".git");
    const mode = (await stat(common)).mode & 0o777;
    await chmod(common, 0o555);
    try {
      await assert.rejects(repository(f.main), /read.only|WORKTREE_SYNC_REPOSITORY_IDS/i);
      await assert.rejects(lstat(join(common, ".git-relay-id")), { code: "ENOENT" });
    } finally {
      await chmod(common, mode);
    }
  },
);

test(
  "a read-only repository uses an explicitly assigned identity in every worktree",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const common = join(f.main, ".git"),
      id = "a".repeat(64);
    const previous = process.env.WORKTREE_SYNC_REPOSITORY_IDS;
    process.env.WORKTREE_SYNC_REPOSITORY_IDS = JSON.stringify({ [common]: id });
    const mode = (await stat(common)).mode & 0o777;
    await chmod(common, 0o555);
    try {
      const [main, other] = await Promise.all([repository(f.main), repository(f.b)]);
      assert.equal(main.id, hash([common, id]));
      assert.equal(other.id, main.id);
      assert.equal(main.identitySource, "external");
      await assert.rejects(lstat(join(common, ".git-relay-id")), { code: "ENOENT" });
    } finally {
      await chmod(common, mode);
      if (previous === undefined) delete process.env.WORKTREE_SYNC_REPOSITORY_IDS;
      else process.env.WORKTREE_SYNC_REPOSITORY_IDS = previous;
    }
  },
);

test("an invalid existing identity marker is rejected and preserved", async (t) => {
  const f = await fixture(t);
  const markerPath = join(f.main, ".git", ".git-relay-id");
  const contents = "not-a-git-relay-identity\n";
  await writeFile(markerPath, contents);
  await assert.rejects(repository(f.main));
  assert.equal(await readFile(markerPath, "utf8"), contents);
});

test("invalid falsy migration claims are rejected and preserved", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f.main);
  const claims = join(stateDirectory(), "identity-migration-claims");
  await mkdir(claims);
  const path = join(claims, `${hash(repo.common)}.json`);
  for (const value of [null, false, 0, ""]) {
    const contents = JSON.stringify(value);
    await writeFile(path, contents);
    await assert.rejects(repository(f.main), /Invalid GitRelay migration claim/);
    assert.equal(await readFile(path, "utf8"), contents);
  }
});

test(
  "a symlink identity marker is rejected without changing the link or target",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const markerPath = join(f.main, ".git", ".git-relay-id");
    const target = join(f.root, "marker-target");
    const contents = `${"a".repeat(64)}\n`;
    await writeFile(target, contents);
    await symlink(target, markerPath);
    await assert.rejects(repository(f.main));
    assert.equal((await lstat(markerPath)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), contents);
  },
);

test("unrelated corrupt state cannot block a new repository or erase same-path history", async (t) => {
  const f = await fixture(t);
  const receiver = { cwd: f.main, ref: "refs/heads/main", adapter: "test", session: "original", async deliver() {} };
  await consumeMailbox(receiver);
  const original = await repository(f.main);
  const metadataPath = join(original.directory, "repo.json");
  await writeFile(metadataPath, "{broken");

  const other = join(f.root, "independent");
  git(f.root, "init", "-b", "main", other);
  await writeFile(join(other, "new.txt"), "new\n");
  git(other, "add", ".");
  git(other, "commit", "-m", "initial");
  await consumeMailbox({ ...receiver, cwd: other, session: "independent" });
  assert.notEqual((await repository(other)).id, original.id);

  await rm(join(f.main, ".git"), { recursive: true });
  git(f.main, "init", "-b", "main");
  await f.commit(f.main, "shared.txt", "replacement\n");
  await assert.rejects(repository(f.main), /Earlier GitRelay state exists/);
  assert.equal(await readFile(metadataPath, "utf8"), "{broken");
});

test("owned empty incomplete initialization can be archived and retried", async (t) => {
  const f = await fixture(t);
  const pending = await withRepositoryIdentity(f.main, undefined, async (repo) => repo);
  await mkdir(pending.directory, { recursive: true });
  await writeFile(join(pending.directory, "identity-owner.json"), JSON.stringify({ id: pending.id }));
  for (const folder of ["sessions", "events", "receipts", "refs", "trash"])
    await mkdir(join(pending.directory, folder));
  await assert.rejects(repository(f.main), /Incomplete GitRelay state initialization/);
  const { archived } = await recoverRepositoryInitialization(f.main);
  assert.equal(JSON.parse(await readFile(join(archived, "identity-owner.json"), "utf8")).id, pending.id);
  await assert.rejects(lstat(pending.directory), { code: "ENOENT" });
  assert.equal((await repository(f.main)).id, pending.id);
  assert.equal((await stat(archived)).isDirectory(), true);
});

test("an empty unowned initialization remains in place for manual inspection", async (t) => {
  const f = await fixture(t);
  const pending = await withRepositoryIdentity(f.main, undefined, async (repo) => repo);
  await mkdir(pending.directory, { recursive: true });
  await assert.rejects(repository(f.main), /Incomplete GitRelay state initialization/);
  await assert.rejects(recoverRepositoryInitialization(f.main), /ownership/);
  assert.deepEqual(await readdir(pending.directory), []);
});

for (const hasOwner of [false, true]) {
  test(`${hasOwner ? "nonempty" : "unowned"} incomplete initialization is never moved`, async (t) => {
    const f = await fixture(t);
    const pending = await withRepositoryIdentity(f.main, undefined, async (repo) => repo);
    await mkdir(join(pending.directory, "events"), { recursive: true });
    const eventPath = join(pending.directory, "events", `${"a".repeat(64)}.json`);
    const contents = "preserve unconfirmed event bytes";
    await writeFile(eventPath, contents);
    if (hasOwner) await writeFile(join(pending.directory, "identity-owner.json"), JSON.stringify({ id: pending.id }));
    await assert.rejects(recoverRepositoryInitialization(f.main), hasOwner ? /contains data/ : /ownership/);
    assert.equal(await readFile(eventPath, "utf8"), contents);
    assert.equal((await stat(dirname(eventPath))).isDirectory(), true);
  });
}

for (const state of ["ready", "missing-ready", "migration-incomplete"] as const) {
  test(`leave for a removed worktree handles ${state} state safely`, async (t) => {
    const f = await fixture(t);
    const receiver = { cwd: f.b, ref: "refs/heads/main", adapter: "test", session: "removed", async deliver() {} };
    await consumeMailbox(receiver);
    const repo = await repository(f.b);
    const path = join(repo.directory, "sessions", `${sessionKey(repo, receiver, receiver.ref)}.json`);
    const before = await readFile(path);
    await rm(f.b, { recursive: true });
    if (state === "missing-ready") await rm(join(repo.directory, "identity-ready.json"));
    if (state === "migration-incomplete") {
      const claims = join(stateDirectory(), "identity-migration-claims");
      await mkdir(claims);
      await writeFile(
        join(claims, `${hash(repo.common)}.json`),
        JSON.stringify({ common: repo.common, newId: repo.id }),
      );
    }
    if (state === "ready") {
      assert.ok((await leaveSession(receiver))?.closedAt);
      assert.ok(JSON.parse(await readFile(path, "utf8")).closedAt);
    } else {
      await assert.rejects(
        leaveSession(receiver),
        state === "missing-ready" ? /Incomplete GitRelay state initialization/ : /migration is incomplete/,
      );
      assert.deepEqual(await readFile(path), before);
    }
  });
}
