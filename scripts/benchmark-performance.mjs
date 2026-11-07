import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, git } from "../tests/helpers.ts";

// Each invocation compares isolated module trees against the same disposable Git/state fixture.
const [before, after, workload] = process.argv.slice(2);
assert.ok(
  before && after && workload,
  "Usage: node --experimental-strip-types scripts/benchmark-performance.mjs BEFORE AFTER WORKLOAD",
);
const cleanups = [];
const f = await fixture({
  after(fn) {
    cleanups.unshift(fn);
  },
});
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const load = async (root, name) => import(pathToFileURL(join(resolve(root), "src/core", `${name}.ts`)));
const modules = await Promise.all(
  [before, after].map(async (root) =>
    Object.fromEntries(
      await Promise.all(
        [
          "mailbox",
          "mcp-mailbox",
          "repository",
          "session-lifecycle",
          "repository-snapshot",
          "connections",
          "store",
          "git",
          "conflicts",
          "coordination",
        ].map(async (name) => [name, await load(root, name)]),
      ),
    ),
  ),
);
const base = modules[0],
  ref = "refs/heads/main";
const token = digest("benchmark-private-token");
const identity = base["mcp-mailbox"].mcpIdentity(token);
const session = await base["session-lifecycle"].enableSession({ cwd: f.b, ref, ...identity });
const repo = await base.repository.repository(f.b);
const key = session.key;
const scope = { cwd: f.b, ref, sessionToken: token };
const at = "2020-01-01T00:00:00.000Z";
const json = (path, value) => writeFile(path, JSON.stringify(value));
const eventIds = [];
async function events(count, recipients = [key], text = "benchmark", files = []) {
  for (let offset = 0; offset < count; offset += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, count - offset) }, async (_, i) => {
        const n = offset + i,
          id = digest(["event", n]);
        eventIds.push(id);
        await json(join(repo.directory, "events", `${id}.json`), {
          id,
          kind: "message",
          createdAt: new Date(Date.parse(at) + n).toISOString(),
          sender: { adapter: "test", session: "sender", root: f.a },
          recipients,
          text,
          files,
        });
      }),
    );
}
async function sessions(count) {
  const keys = [];
  for (let n = 0; n < count; n++) {
    const other = { adapter: "test", session: `reader-${n}` },
      k = base.mailbox.sessionKey(repo, other, ref);
    keys.push(k);
    await json(join(repo.directory, "sessions", `${k}.json`), {
      ...other,
      key: k,
      root: repo.root,
      ref,
      createdAt: at,
      lastSeen: at,
    });
    await mkdir(join(repo.directory, "receipts", k), { recursive: true });
  }
  return keys;
}
let prepare = async () => {},
  run;
try {
  if (workload.startsWith("receive") || workload.startsWith("pages") || workload === "ack") {
    const large = workload.includes("large") || workload.includes("unicode");
    const text = workload.includes("unicode")
      ? "你好😀".repeat(5000)
      : large
        ? "large note ".repeat(5700)
        : "short note";
    await events(large ? 1 : 8, [key], text);
    const batch = await base["mcp-mailbox"].receiveMessages(scope);
    if (workload.startsWith("pages")) {
      assert.equal(batch.detailsRequired, true);
      const path = join(repo.directory, "receipts", key, "mcp-delivery.json"),
        original = await readFile(path, "utf8");
      prepare = () => writeFile(path, original);
      run = async (api) => {
        let offset = 0,
          body = "";
        for (;;) {
          const part = await api["mcp-mailbox"].readMessageDetails({ ...scope, deliveryId: batch.deliveryId, offset });
          assert.ok(Buffer.byteLength(part.text) <= 2048);
          body += part.text;
          offset = part.nextOffset;
          if (part.complete) break;
        }
        const result = JSON.parse(body);
        assert.equal(result[0].event.text, text);
        return result;
      };
    } else if (workload === "ack") {
      const path = join(repo.directory, "receipts", key, "mcp-delivery.json"),
        original = await readFile(path, "utf8");
      prepare = async () => {
        await writeFile(path, original);
        await Promise.all(
          eventIds.map((id) => rm(join(repo.directory, "receipts", key, `${id}.json`), { force: true })),
        );
      };
      run = async (api) => {
        const result = await api["mcp-mailbox"].acknowledgeMessages({ ...scope, deliveryId: batch.deliveryId });
        assert.equal(result.acknowledged.length, 8);
        return result;
      };
    } else
      run = async (api) => {
        const result = await api["mcp-mailbox"].receiveMessages(scope);
        assert.equal(!!result.detailsRequired, large);
        assert.ok(result.deliveryId);
        return {
          ...result,
          deliveryId: "valid-scoped-delivery",
          notifications: result.notifications.toSorted((a, b) => a.event.id.localeCompare(b.event.id)),
        };
      };
  } else if (workload.startsWith("status")) {
    if (workload !== "status-small") {
      const keys = await sessions(16);
      await events(64, keys);
    }
    run = async (api) => {
      const result = await api["repository-snapshot"].repositorySnapshot(f.b, undefined, workload === "status-history");
      delete result.capturedAt;
      assert.equal(result.retainedEvents, workload === "status-small" ? 0 : 64);
      return result;
    };
  } else if (workload.startsWith("events")) {
    const count = workload === "events-small" ? 32 : 1000;
    await events(
      count,
      [key],
      "hello",
      workload === "events-wide" ? Array.from({ length: 100 }, (_, n) => `src/path-${n}/file.ts`) : [],
    );
    run = async (api) => {
      const result = await api.mailbox.eventsIn(repo);
      assert.equal(result.length, count);
      return result;
    };
  } else if (workload.startsWith("sessions")) {
    const count = workload === "sessions-small" ? 4 : 256;
    await sessions(count);
    run = async (api) => {
      const result = await api.mailbox.sessionsIn(repo);
      assert.equal(result.length, count + 1);
      return result;
    };
  } else if (workload.startsWith("presence")) {
    const count = workload === "presence-small" ? 4 : 128,
      keys = workload === "presence-shared" ? [key] : await sessions(count);
    const directory = join(repo.directory, "connections");
    await mkdir(directory, { recursive: true });
    prepare = async () => {
      for (let start = 0; start < count; start += 32)
        await Promise.all(
          Array.from({ length: Math.min(32, count - start) }, (_, i) => {
            const n = start + i,
              id = digest(["connection", n]);
            return json(join(directory, `${id}.json`), {
              connection: id,
              pid: process.pid,
              expiresAt: Date.now() + 10000,
              keys: [keys[n % keys.length]],
            });
          }),
        );
    };
    run = async (api) => {
      const result = await api.connections.onlineSessions(repo);
      assert.equal(result.length, keys.length);
      return result.sort();
    };
  } else if (workload.startsWith("json")) {
    const value = { text: workload === "json-small" ? "small" : "你好😀".repeat(12000) },
      path = join(f.root, "read.json");
    await json(path, value);
    run = async (api) => {
      let result;
      for (let i = 0; i < 32; i++) result = await api.store.readJson(path, true);
      assert.deepEqual(result, value);
      return result;
    };
  } else if (workload === "git-paths") {
    run = async (api) => {
      const values = [];
      for (let i = 0; i < 12; i++) values.push(await api.git.git(f.b, ["ls-files", "-z"], undefined, "paths"));
      return values;
    };
  } else if (workload.startsWith("branch")) {
    if (workload === "branch-many")
      for (let start = 0; start < 2000; start += 100) {
        const input = Array.from(
          { length: 100 },
          (_, i) => `update refs/heads/topic/child-${start + i} ${f.initial}\n`,
        ).join("");
        const { execFileSync } = await import("node:child_process");
        execFileSync("git", ["-C", f.b, "update-ref", "--stdin"], { input });
      }
    // Branch names containing a prefix directory cannot coexist with that exact branch.
    const apis = await Promise.all([before, after].map((root) => load(root, "branch-status")));
    run = async (api) =>
      apis[api === modules[0] ? 0 : 1].branchStatus({
        cwd: f.b,
        ...(workload === "branch-many" ? { branch: "topic" } : {}),
      });
  } else if (workload.startsWith("compare") || workload.startsWith("worktree")) {
    if (workload === "compare-wide") {
      for (const [cwd, prefix] of [
        [f.a, "own"],
        [f.b, "peer"],
      ]) {
        await mkdir(join(cwd, prefix));
        await Promise.all(Array.from({ length: 800 }, (_, n) => writeFile(join(cwd, prefix, `${n}.txt`), "content\n")));
        git(cwd, "add", ".");
        git(cwd, "commit", "-m", "wide snapshot");
      }
    } else if (workload.startsWith("compare")) {
      await f.commit(f.a, "shared.txt", "A\n");
      await f.commit(f.b, "shared.txt", "B\n");
    }
    if (workload === "worktree-dirty") await writeFile(join(f.b, "other.txt"), "unfinished\n");
    const observer = await base.conflicts.openObserver(repo.directory);
    await base.conflicts.importRefs(observer, repo.common, repo.id);
    const target = {
        id: "ours",
        kind: "branch",
        repository: "fixture",
        ref: "feature/a",
        commit: git(f.a, "rev-parse", "HEAD").trim(),
      },
      incoming = { ...target, id: "theirs", ref: "feature/b", commit: git(f.b, "rev-parse", "HEAD").trim() };
    if (workload.startsWith("compare"))
      run = async (api) => {
        const issue = await api.conflicts.compareRevisions(observer, target, incoming);
        assert.equal(issue?.level, workload === "compare-wide" ? undefined : "conflict");
        return issue ?? null;
      };
    else run = async (api) => api.conflicts.worktreeRevisions(observer, f.b, "fixture");
  } else if (workload.startsWith("report")) {
    const issues = Array.from(
      { length: workload === "report-small" ? 1 : workload === "report-empty" ? 0 : 200 },
      (_, n) => ({
        level: "conflict",
        target: { id: `ours-${n}` },
        incoming: { id: `peer-${n}` },
        files: Array.from({ length: 100 }, (_, i) =>
          workload === "report-unicode"
            ? `src/目录😀-${n}/带引号\"的文件-${i}.ts`
            : `src/component-${n}/some-long-file-name-${i}.ts`,
        ),
        reason: "content conflict",
      }),
    );
    run = async (api) => {
      const text = api.coordination.benchmarkNotification("fixture", issues, []);
      assert.ok(Buffer.byteLength(text) < 64 * 1024);
      const report = JSON.parse(text.slice(text.indexOf("\n") + 1));
      assert.equal(report.totalFindings, issues.length);
      if (workload === "report-empty") {
        assert.equal(issues.length, 0);
        assert.equal(report.status, "resolved");
      }
      return text;
    };
  } else if (workload.startsWith("scan")) {
    await base.coordination.trackRepository(f.b);
    await f.commit(f.a, "shared.txt", "A\n");
    await writeFile(join(f.b, "shared.txt"), "unfinished\n");
    if (workload === "scan-many") await sessions(7);
    run = async (api) => {
      await api.coordination.scanCoordination();
      const report = JSON.parse(await readFile(join(repo.directory, "coordination-report.json"), "utf8"));
      delete report.checkedAt;
      if (report.remotes) delete report.remotes.checkedAt;
      assert.ok(report.sessions.length >= 1);
      return report;
    };
  } else throw new Error(`Unknown workload ${workload}`);
  const rows = [],
    expected = new Set();
  // One warm-up per variant, six order-balanced samples. Fixture setup/reset and output hashing are excluded.
  for (let sample = -1; sample < 6; sample++)
    for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      await prepare();
      const usage = process.resourceUsage(),
        start = performance.now();
      const result = await run(modules[index]);
      const ms = performance.now() - start,
        resource = process.resourceUsage();
      const hash = digest(result);
      expected.add(hash);
      assert.equal(expected.size, 1, "Variants returned different observable results");
      if (sample >= 0)
        rows.push({
          sample,
          variant: index ? "after" : "before",
          ms,
          cpuMs: (resource.userCPUTime + resource.systemCPUTime - usage.userCPUTime - usage.systemCPUTime) / 1000,
          maxRssKiB: resource.maxRSS,
          outputHash: hash,
        });
    }
  const median = (xs) => {
    const s = xs.toSorted((a, b) => a - b),
      m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const medians = Object.fromEntries(
    ["before", "after"].map((variant) => [
      variant,
      Object.fromEntries(
        ["ms", "cpuMs"].map((metric) => [
          metric,
          median(rows.filter((r) => r.variant === variant).map((r) => r[metric])),
        ]),
      ),
    ]),
  );
  console.log(
    JSON.stringify({
      workload,
      medians,
      gainPercent: 100 * (1 - medians.after.ms / medians.before.ms),
      rows,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      limits:
        "Warm-cache local synthetic fixture; independently loaded module trees in one process; alternating order; Node CPU excludes Git children; process peak RSS is shared, not a per-variant memory measurement. No network/provider/GUI latency claim.",
    }),
  );
} finally {
  for (const cleanup of cleanups) await cleanup();
}
