import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, git } from "../helpers.ts";
import { addWorktree } from "../../src/core/git.ts";
import { repository } from "../../src/core/repository.ts";
import { coordinationStatus, scanCoordination, trackRepository } from "../../src/core/coordination.ts";
import { enableSession } from "../../src/core/session-lifecycle.ts";
import { mcpIdentity, newSessionToken } from "../../src/core/mcp-mailbox.ts";
import {
  compareRevisions,
  importRefs,
  openObserver,
  worktreeRevisions,
  type Revision,
} from "../../src/core/conflicts.ts";
import { readJson, writeJson } from "../../src/core/store.ts";

async function subscribe(cwd: string) {
  await enableSession({ cwd, ref: "refs/heads/main", ...mcpIdentity(newSessionToken()) });
}
const findings = (report: any) => report.sessions.flatMap((session: any) => session.issues);

async function independent(root: string) {
  const cwd = join(root, "independent");
  await mkdir(cwd);
  git(cwd, "init", "-b", "main");
  await writeFile(join(cwd, "file.txt"), "independent\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  return cwd;
}

test("CRLF receiver snapshots preserve source normalization and never invent shared-file conflicts", async (t) => {
  const f = await fixture(t);
  const receiver = join(f.root, "crlf");
  git(f.root, "clone", "-c", "core.autocrlf=true", f.main, receiver);
  assert.equal(await readFile(join(receiver, "shared.txt"), "utf8"), "base\r\n");
  await writeFile(join(receiver, "other.txt"), "unfinished work\r\n");
  await f.commit(f.a, "shared.txt", "peer change\n");
  git(receiver, "fetch", "origin");
  await subscribe(receiver);
  await trackRepository(receiver);
  const index = await readFile(join(receiver, ".git", "index"));
  const config = await readFile(join(receiver, ".git", "config"));
  await scanCoordination();
  const report = (await coordinationStatus(receiver)).report as any;
  assert.deepEqual(report.errors, []);
  assert.deepEqual(findings(report), []);
  assert.deepEqual(await readFile(join(receiver, ".git", "index")), index);
  assert.deepEqual(await readFile(join(receiver, ".git", "config")), config);
  assert.equal(git(receiver, "diff", "--name-only").trim(), "other.txt");
  git(receiver, "merge", "--no-commit", "--no-ff", "origin/feature/a");
  assert.equal(await readFile(join(receiver, "other.txt"), "utf8"), "unfinished work\r\n");
});

test("case-insensitive receivers diagnose merged file and directory aliases even when Git can merge", async (t) => {
  const f = await fixture(t);
  git(f.main, "config", "core.ignorecase", "true");
  await f.commit(f.a, "Model.ts", "UPPER\n");
  await f.commit(f.b, "model.ts", "lower\n");
  await mkdir(join(f.a, "Components"));
  await f.commit(f.a, "Components/a.ts", "A\n");
  await mkdir(join(f.b, "components"));
  await f.commit(f.b, "components/b.ts", "B\n");
  await subscribe(f.b);
  await trackRepository(f.b);
  await scanCoordination();
  const report = (await coordinationStatus(f.b)).report as any;
  assert.deepEqual(report.errors, []);
  assert.ok(
    findings(report).some(
      (issue: any) =>
        issue.level === "conflict" &&
        /case-insensitive/.test(issue.reason) &&
        issue.files.includes("Model.ts") &&
        issue.files.includes("model.ts"),
    ),
  );
  assert.ok(
    findings(report).some(
      (issue: any) => issue.files.includes("Components/a.ts") && issue.files.includes("components/b.ts"),
    ),
  );
  assert.equal(await readFile(join(f.b, "model.ts"), "utf8"), "lower\n");
  assert.equal(git(f.b, "rev-parse", "HEAD"), git(f.main, "rev-parse", "feature/b"));
});

test("case-colliding incoming trees are rejected even when the update is a fast-forward", async (t) => {
  const f = await fixture(t);
  git(f.main, "config", "core.ignorecase", "true");
  const commit = await f.commit(f.a, "Model.ts", "upper\n");
  const blob = git(f.a, "rev-parse", `${commit}:Model.ts`).trim();
  git(f.a, "-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", "100644", blob, "model.ts");
  git(f.a, "commit", "-m", "case aliases in incoming tree");
  const repo = await repository(f.b);
  const observer = await openObserver(repo.directory);
  await importRefs(observer, repo.common, repo.id);
  const [target] = await worktreeRevisions(observer, f.b, "test");
  const incoming: Revision = {
    id: "incoming",
    kind: "branch",
    repository: "test",
    ref: "feature/a",
    commit: git(f.a, "rev-parse", "HEAD").trim(),
  };
  const result = await compareRevisions(observer, target, incoming);
  assert.equal(result?.level, "conflict");
  assert.deepEqual(result?.files, ["Model.ts", "model.ts"]);
});

test("recursive enrollment inherits source identity but preserves existing GitHub and disabled preferences", async (t) => {
  const f = await fixture(t);
  const root = await trackRepository(f.main, { source: "https://github.com/test/canonical" });
  const repo = await repository(f.main);
  await writeJson(join(repo.directory, "tracking.json"), {
    ...root,
    repository: "https://github.com/test/fork",
    github: true,
  });
  const before = await readFile(join(repo.directory, "tracking.json"));
  const clone = join(f.root, "clone");
  git(f.root, "clone", f.main, clone);
  const child = await trackRepository(clone, { github: false });
  assert.equal(child.source, root.source);
  assert.equal(child.repository, "https://github.com/test/fork");
  assert.deepEqual(await readFile(join(repo.directory, "tracking.json")), before);
  await trackRepository(f.main, { enabled: false });
  const disabled = await readFile(join(repo.directory, "tracking.json"));
  await trackRepository(clone, { github: false });
  assert.deepEqual(await readFile(join(repo.directory, "tracking.json")), disabled);
});

test("one corrupt unrelated registration is quarantined and cannot block an explicitly scoped healthy scan", async (t) => {
  const f = await fixture(t);
  const other = await independent(f.root);
  await subscribe(f.b);
  const tracking = await trackRepository(f.b);
  await trackRepository(other);
  await scanCoordination();
  const bad = await repository(other);
  const path = join(bad.directory, "tracking.json");
  await writeFile(path, '{"version":1,');
  await writeFile(join(f.b, "shared.txt"), "local work\n");
  const commit = await f.commit(f.a, "shared.txt", "peer work\n");
  await scanCoordination(undefined, tracking.source);
  const status = await coordinationStatus(f.b);
  const report = status.report as any;
  assert.deepEqual(report.errors, []);
  assert.ok(report.revisions.some((revision: any) => revision.commit === commit));
  assert.ok(findings(report).some((issue: any) => issue.level === "conflict"));
  assert.match(JSON.stringify(await readJson(join(bad.directory, "coordination-error.json"))), /Registration/);
  assert.equal(await readFile(path, "utf8"), '{"version":1,');
  await assert.rejects(scanCoordination(), /Registration/);
  assert.ok(findings((await coordinationStatus(f.b)).report).some((issue: any) => issue.level === "conflict"));
});

test("corrupt same-source registrations and registrations with unknown ancestry remain explicit coverage gaps", async (t) => {
  const f = await fixture(t);
  await subscribe(f.b);
  const tracking = await trackRepository(f.b);
  const clone = join(f.root, "clone");
  git(f.root, "clone", f.main, clone);
  await trackRepository(clone);
  await scanCoordination();
  const bad = await repository(clone);
  await writeFile(join(bad.directory, "tracking.json"), "{");
  await scanCoordination(undefined, tracking.source);
  assert.ok(((await coordinationStatus(f.b)).report as any).errors.some((error: string) => error.includes(bad.id)));
  await writeFile(join(bad.directory, "coordination-report.json"), "{");
  await scanCoordination(undefined, tracking.source);
  assert.ok(((await coordinationStatus(f.b)).report as any).errors.length > 0);
});

test("SHA-256 sources use a matching observer and retain the old SHA-1 observation store", async (t) => {
  const f = await fixture(t);
  const root = join(f.root, "sha256");
  await mkdir(root);
  git(root, "init", "--object-format=sha256", "-b", "main");
  await writeFile(join(root, "shared.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  const a = await addWorktree(root, join(f.root, "sha-a"), "a", true);
  const b = await addWorktree(root, join(f.root, "sha-b"), "b", true);
  await f.commit(a, "shared.txt", "A\n");
  await f.commit(b, "shared.txt", "B\n");
  await subscribe(b);
  const repo = await repository(b);
  const legacy = await openObserver(repo.directory);
  await writeFile(join(legacy, "legacy-evidence"), "retain this\n");
  await trackRepository(b);
  await scanCoordination();
  const report = (await coordinationStatus(b)).report as any;
  assert.deepEqual(report.errors, []);
  assert.ok(findings(report).some((issue: any) => issue.level === "conflict"));
  assert.equal(git(join(repo.directory, "observer-sha256.git"), "rev-parse", "--show-object-format").trim(), "sha256");
  assert.equal(await readFile(join(legacy, "legacy-evidence"), "utf8"), "retain this\n");
});
