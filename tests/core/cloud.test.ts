import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, git } from "../helpers.ts";
import { observeGitHub, observeRemotes } from "../../src/core/cloud.ts";
import { importRefs, openObserver } from "../../src/core/conflicts.ts";
import { repository } from "../../src/core/repository.ts";
import { coordinationStatus, scanCoordination, trackRepository } from "../../src/core/coordination.ts";
import { enableSession } from "../../src/core/session-lifecycle.ts";
import { mcpIdentity, newSessionToken, receiveMessages } from "../../src/core/mcp-mailbox.ts";

// Only HTTP metadata/transport are fixtures; all objects, fetches, snapshots and merges use real Git.
test(
  "GitHub source/fork/branch/open-PR discovery routes a real PR conflict and refreshes closed PRs",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const head = await f.commit(f.a, "shared.txt", "PR head\n");
    const base = await f.commit(f.main, "shared.txt", "base branch advanced\n");
    git(f.main, "update-ref", "refs/pull/7/head", head);
    const apiPath = join(f.root, "api.json");
    const responses: Record<string, unknown> = {
      "repos/test/source": { full_name: "test/source", fork: false },
      "repos/test/fork": {
        full_name: "test/fork",
        fork: true,
        parent: { full_name: "test/source" },
        source: { full_name: "test/source" },
      },
      "repos/test/source/forks?per_page=100": [[{ full_name: "test/fork" }]],
      "repos/test/fork/forks?per_page=100": [[]],
      "repos/test/source/branches?per_page=100": [
        [{ name: "main", commit: { sha: base } }],
        [{ name: "feature/a", commit: { sha: head } }],
      ],
      "repos/test/fork/branches?per_page=100": [[{ name: "main", commit: { sha: base } }]],
      "repos/test/source/pulls?state=open&per_page=100": [
        [
          {
            number: 7,
            html_url: "https://fixture.test/test/source/pull/7",
            head: { ref: "feature/a", sha: head, repo: { full_name: "test/source" } },
            base: { ref: "main", sha: base, repo: { full_name: "test/source" } },
          },
        ],
      ],
      "repos/test/fork/pulls?state=open&per_page=100": [[]],
    };
    await writeFile(apiPath, JSON.stringify(responses));
    const bin = join(f.root, "bin");
    await mkdir(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      join(bin, "gh"),
      `#!${process.execPath}\nconst fs=require('node:fs');const data=JSON.parse(fs.readFileSync(${JSON.stringify(apiPath)},'utf8'));const key=process.argv.at(-1);if(!(key in data)){process.stderr.write('unregistered fixture endpoint: '+key);process.exit(1);}process.stdout.write(JSON.stringify(data[key]));\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}\nconst cp=require('node:child_process');let args=process.argv.slice(2);if(args.includes('fetch'))args=args.map(arg=>arg.startsWith('https://fixture.test/')?${JSON.stringify(f.main)}:arg);const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:{...process.env,GIT_ALLOW_PROTOCOL:'file'}});process.exit(result.status??1);\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    t.after(() => {
      process.env.PATH = oldPath;
    });
    git(f.main, "remote", "add", "origin", "https://fixture.test/test/source.git");
    const sessionToken = newSessionToken();
    const options = { cwd: f.a, ref: "refs/heads/main", sessionToken };
    await enableSession({ ...options, ...mcpIdentity(sessionToken) });
    await trackRepository(f.a, { github: true });
    await scanCoordination();
    const status = (await coordinationStatus(f.a)).report as any;
    assert.deepEqual(status.errors, []);
    assert.equal(status.cloud.repositories.length, 2);
    assert.equal(status.cloud.revisions.filter((revision: any) => revision.kind === "pr").length, 1);
    assert.ok(
      status.sessions.some((session: any) =>
        session.issues.some(
          (issue: any) => issue.level === "conflict" && (issue.target.kind === "pr" || issue.incoming.kind === "pr"),
        ),
      ),
    );
    const batch = await receiveMessages(options);
    assert.ok(
      batch.notifications.some(
        (item) => item.kind === "message" && item.event.text.includes("https://fixture.test/test/source/pull/7"),
      ),
    );
    responses["repos/test/source/pulls?state=open&per_page=100"] = [[]];
    await writeFile(apiPath, JSON.stringify(responses));
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 61_000);
    await scanCoordination();
    const refreshed = (await coordinationStatus(f.a)).report as any;
    assert.ok(refreshed.cloud.revisions.every((revision: any) => revision.kind !== "pr"));
    assert.equal(git(f.a, "rev-parse", "HEAD").trim(), head);
    assert.equal(git(f.main, "rev-parse", "main").trim(), base);
    const tracked = await repository(f.a);
    const cached = JSON.parse(await readFile(join(tracked.directory, "cloud-snapshot.json"), "utf8"));
    assert.equal(cached.source, "https://fixture.test/test/source");
  },
);

test("observer remote refresh sees new/deleted branches without fetching user refs; unavailable remotes are errors", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f.b);
  const observer = await openObserver(repo.directory);
  await importRefs(observer, repo.common, repo.id);
  const remote = { url: f.main, source: "https://fixture.test/test/source" };
  const before = git(f.b, "for-each-ref");
  git(f.main, "branch", "new-remote-topic");
  let snapshot = await observeRemotes(observer, [remote]);
  assert.deepEqual(snapshot.errors, []);
  assert.ok(snapshot.revisions.some((revision) => revision.ref === "refs/heads/new-remote-topic"));
  git(f.main, "branch", "-D", "new-remote-topic");
  snapshot = await observeRemotes(observer, [remote]);
  assert.ok(snapshot.revisions.every((revision) => revision.ref !== "refs/heads/new-remote-topic"));
  assert.equal(git(f.b, "for-each-ref"), before);
  const missing = await observeRemotes(observer, [{ url: join(f.root, "missing"), source: "missing remote" }]);
  assert.equal(missing.revisions.length, 0);
  assert.equal(missing.errors.length, 1);
  await assert.rejects(observeGitHub(observer, "file:///not-github"), /Invalid GitHub source/);
});
