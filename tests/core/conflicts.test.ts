import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, git } from "../helpers.ts";
import {
  compareRevisions,
  importRefs,
  openObserver,
  worktreeRevisions,
  type Revision,
} from "../../src/core/conflicts.ts";
import { repository } from "../../src/core/repository.ts";
import { trackRepository, scanCoordination, coordinationStatus } from "../../src/core/coordination.ts";
import { enableSession } from "../../src/core/session-lifecycle.ts";
import { mcpIdentity, newSessionToken } from "../../src/core/mcp-mailbox.ts";

test("observer merge diagnosis cannot execute a global merge driver selected by repository attributes", async (t) => {
  const f = await fixture(t);
  await f.commit(f.main, ".gitattributes", "*.txt merge=relay-test\n");
  git(f.a, "merge", "--ff-only", "main");
  git(f.b, "merge", "--ff-only", "main");
  const a = await f.commit(f.a, "shared.txt", "A\n");
  const b = await f.commit(f.b, "shared.txt", "B\n");
  const marker = join(f.root, "driver-executed");
  const global = join(f.root, "global-config");
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  await writeFile(global, `[merge "relay-test"]\n\tdriver = touch '${marker}'\n`);
  process.env.GIT_CONFIG_GLOBAL = global;
  t.after(() => {
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
  });
  const repo = await repository(f.a);
  const observer = await openObserver(repo.directory);
  await importRefs(observer, repo.common, repo.id);
  const ours: Revision = { id: "ours", kind: "branch", repository: "test", ref: "feature/a", commit: a };
  const issue = await compareRevisions(observer, ours, { ...ours, id: "theirs", ref: "feature/b", commit: b });
  assert.equal(issue?.level, "conflict");
  await assert.rejects(access(marker), { code: "ENOENT" });
  await assert.rejects(compareRevisions(observer, { ...ours, commit: "--help" }, ours), /Invalid revision/);
});

test(
  "observer initialization rejects symlinked storage instead of writing source Git directories",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const repo = await repository(f.b);
    const path = join(repo.directory, "observer.git");
    await mkdir(path);
    await symlink(join(f.main, ".git", "objects"), join(path, "objects"));
    const config = await readFile(join(f.main, ".git", "config"));
    await assert.rejects(openObserver(repo.directory), /Invalid GitRelay state directory/);
    assert.deepEqual(await readFile(join(f.main, ".git", "config")), config);
  },
);

test("uncommitted submodule contents cannot be mistaken for a clean parent snapshot", async (t) => {
  const f = await fixture(t);
  git(f.b, "-c", "protocol.file.allow=always", "submodule", "add", f.main, "module");
  await writeFile(join(f.b, "module", "shared.txt"), "unfinished child work\n");
  const repo = await repository(f.b);
  const observer = await openObserver(repo.directory);
  await importRefs(observer, repo.common, repo.id);
  await assert.rejects(worktreeRevisions(observer, f.b, "test"), /Uncommitted submodule contents/);
  assert.equal(await readFile(join(f.b, "module", "shared.txt"), "utf8"), "unfinished child work\n");
});

test("dirty sparse worktrees are unknown rather than synthetic deletion conflicts", async (t) => {
  const f = await fixture(t);
  git(f.b, "sparse-checkout", "init", "--cone");
  await writeFile(join(f.b, "shared.txt"), "local sparse work\n");
  const sessionToken = newSessionToken();
  await enableSession({ cwd: f.b, ref: "refs/heads/main", ...mcpIdentity(sessionToken) });
  const status = git(f.b, "status", "--porcelain=v2");
  const index = await readFile(join(f.main, ".git", "worktrees", "b", "index"));
  await trackRepository(f.b);
  await scanCoordination();
  const report = (await coordinationStatus(f.b)).report as any;
  assert.ok(report.errors.some((error: string) => error.includes("Dirty sparse worktrees")));
  assert.equal(git(f.b, "status", "--porcelain=v2"), status);
  assert.deepEqual(await readFile(join(f.main, ".git", "worktrees", "b", "index")), index);
});
