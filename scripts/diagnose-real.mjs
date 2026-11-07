import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, git } from "../tests/helpers.ts";
import { connectMcp } from "../tests/mcp/helpers.ts";
import { addWorktree } from "../src/core/git.ts";
import { repository } from "../src/core/repository.ts";
import { trackRepository } from "../src/core/coordination.ts";
import { observationGit } from "../src/core/conflicts.ts";
import { enableSession } from "../src/core/session-lifecycle.ts";
import { mcpIdentity, newSessionToken } from "../src/core/mcp-mailbox.ts";

const results = [];
const head = git(process.cwd(), "rev-parse", "HEAD").trim();
const start = new Date().toISOString();
const verifyFixes = process.argv.includes("--verify-fixes");
const selected = process.argv.slice(2).filter((arg) => arg !== "--verify-fixes");
async function probe(name, run) {
  if (selected.length && !selected.includes(name)) return;
  const cleanup = [];
  const t = {
    after(fn) {
      cleanup.unshift(fn);
    },
  };
  const started = performance.now();
  try {
    results.push({ name, ...(await run(t)), elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    results.push({ name, probeError: error.message, elapsedMs: Math.round(performance.now() - started) });
  } finally {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch (error) {
        results.push({ name: `${name}/cleanup`, probeError: error.message });
      }
    }
  }
}
async function eventually(read, accept, timeout = 15000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw new Error("Probe timed out");
}
async function subscribe(cwd) {
  const sessionToken = newSessionToken();
  const ref = "refs/heads/main";
  return await enableSession({ cwd, ref, ...mcpIdentity(sessionToken) });
}
const issues = (report) => report.sessions.flatMap((session) => session.issues);
const exists = async (path) =>
  !!(await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return;
    throw error;
  }));

await probe("crlf-false-conflict", async (t) => {
  const f = await fixture(t);
  const receiver = join(f.root, "crlf-clone");
  git(f.root, "clone", "-c", "core.autocrlf=true", f.main, receiver);
  assert.equal(await readFile(join(receiver, "shared.txt"), "utf8"), "base\r\n");
  await writeFile(join(receiver, "other.txt"), "my unfinished change\r\n");
  await f.commit(f.a, "shared.txt", "peer change\n");
  git(receiver, "fetch", "origin");
  const realDirtyFiles = git(receiver, "diff", "--name-only").trim().split("\n");
  assert.deepEqual(realDirtyFiles, ["other.txt"]);
  await subscribe(receiver);
  await trackRepository(receiver);
  const { call } = await connectMcp(t, receiver);
  const report = (await call("scan_repository")).report;
  assert.deepEqual(report.errors, []);
  const falseConflicts = issues(report).filter(
    (issue) => issue.level === "conflict" && issue.files.includes("shared.txt"),
  );
  let actualMerge;
  try {
    actualMerge = { success: true, output: git(receiver, "merge", "--no-commit", "--no-ff", "origin/feature/a") };
  } catch (error) {
    actualMerge = { success: false, error: error.stderr?.toString() ?? error.message };
  }
  const preserved = (await readFile(join(receiver, "other.txt"), "utf8")) === "my unfinished change\r\n";
  return {
    fixed: falseConflicts.length === 0 && actualMerge.success && preserved,
    reproduced: falseConflicts.length > 0 && actualMerge.success,
    severity: "P1",
    realDirtyFiles,
    scannerConflictFiles: [...new Set(falseConflicts.flatMap((issue) => issue.files))],
    actualGitMergeSucceeded: actualMerge.success,
    actualGitMergeError: actualMerge.error?.replaceAll(f.root, "<fixture>"),
    localUnfinishedWorkPreserved: preserved,
  };
});

await probe("case-insensitive-filesystem-collision", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "case-volume-probe"), "case check");
  const caseInsensitive = await exists(join(f.root, "CASE-VOLUME-PROBE"));
  if (!caseInsensitive) return { reproduced: false, skipped: "The actual filesystem is case sensitive" };
  await f.commit(f.a, "Model.ts", "UPPER implementation\n");
  await f.commit(f.b, "model.ts", "lower implementation\n");
  await subscribe(f.b);
  await trackRepository(f.b);
  const { call } = await connectMcp(t, f.b);
  const report = (await call("scan_repository")).report;
  const findings = issues(report);
  let mergeSucceeded = false;
  try {
    git(f.b, "merge", "--no-commit", "--no-ff", "feature/a");
    mergeSucceeded = true;
  } catch {
    /* A checkout collision is also evidence of impact. */
  }
  const upper = await lstat(join(f.b, "Model.ts")).catch(() => undefined);
  const lower = await lstat(join(f.b, "model.ts")).catch(() => undefined);
  return {
    fixed:
      report.errors.length === 0 &&
      findings.some((issue) => issue.level === "conflict" && /case-insensitive/.test(issue.reason)),
    reproduced: findings.length === 0 && report.errors.length === 0,
    severity: "P1",
    caseInsensitive,
    sourceIgnoreCase: git(f.b, "config", "--bool", "core.ignorecase").trim(),
    scannerFindings: findings.length,
    scannerErrors: report.errors,
    actualGitMergeSucceeded: mergeSucceeded,
    indexContainsBothNames: ["Model.ts", "model.ts"].every((file) => git(f.b, "ls-files").split("\n").includes(file)),
    bothNamesResolveToSameInode: !!upper && !!lower && upper.ino === lower.ino,
    upperContent: await readFile(join(f.b, "Model.ts"), "utf8").catch(() => null),
    lowerContent: await readFile(join(f.b, "model.ts"), "utf8").catch(() => null),
  };
});

await probe("sigkill-monitor-owner-failover", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.b, "shared.txt"), "unfinished receiver work\n");
  await trackRepository(f.b);
  const first = await connectMcp(t, f.b);
  const second = await connectMcp(t, f.a);
  await first.call("join_session");
  await second.call("join_session");
  const repo = await repository(f.b);
  await eventually(
    () => first.call("coordination_status"),
    (status) => !!status.report,
  );
  const state = await eventually(
    () => first.call("monitor_status"),
    (status) => status.running,
  );
  const owner = state.state.pid;
  assert.ok([first.transport.pid, second.transport.pid].includes(owner));
  await eventually(
    async () =>
      !(await exists(join(repo.directory, "coordination.lock"))) &&
      !(await exists(join(repo.directory, "publish.lock"))),
    Boolean,
  );
  const survivor = owner === first.transport.pid ? second : first;
  const before = (await survivor.call("coordination_status")).report.checkedAt;
  process.kill(owner, "SIGKILL");
  await f.commit(f.a, "shared.txt", "conflicting peer after owner crash\n");
  await delay(12500);
  const after = await survivor.call("monitor_status");
  const status = await survivor.call("coordination_status");
  const staleDiagnostic = survivor.stderr().includes("Stale git-relay lock");
  const manual = await eventually(async () => {
    try {
      return await survivor.call("scan_repository");
    } catch (error) {
      if (/busy/i.test(error.message)) return null;
      throw error;
    }
  }, Boolean);
  return {
    fixed:
      after.running &&
      after.state.pid === survivor.transport.pid &&
      status.report.checkedAt !== before &&
      issues(status.report).some((issue) => issue.level === "conflict"),
    reproduced: !after.running && staleDiagnostic && status.report.checkedAt === before,
    severity: "P1",
    observationSeconds: 12.5,
    automaticTakeover: after.running,
    reportAdvanced: status.report.checkedAt !== before,
    staleLockDiagnostic: staleDiagnostic,
    manualScanCanStillFindConflict: issues(manual.report).some((issue) => issue.level === "conflict"),
  };
});

await probe("one-corrupt-tracking-file-blocks-unrelated-source", async (t) => {
  const f = await fixture(t);
  const unrelated = join(f.root, "unrelated");
  await mkdir(unrelated);
  git(unrelated, "init", "-b", "main");
  await writeFile(join(unrelated, "independent.txt"), "independent\n");
  git(unrelated, "add", ".");
  git(unrelated, "commit", "-m", "initial");
  await subscribe(f.b);
  await trackRepository(f.b);
  await trackRepository(unrelated);
  const { call } = await connectMcp(t, f.b);
  const before = await call("scan_repository");
  assert.equal(issues(before.report).length, 0);
  await writeFile(join(f.b, "shared.txt"), "local pending work\n");
  await f.commit(f.a, "shared.txt", "actual healthy-source conflict\n");
  const badRepo = await repository(unrelated);
  const path = join(badRepo.directory, "tracking.json");
  const original = await readFile(path);
  await writeFile(path, '{"version":1,');
  let rejected = false;
  try {
    await call("scan_repository");
  } catch {
    rejected = true;
  }
  const after = await call("coordination_status");
  await writeFile(path, original);
  const recovered = await call("scan_repository");
  return {
    fixed:
      !rejected &&
      after.report.checkedAt !== before.report.checkedAt &&
      issues(after.report).some((issue) => issue.level === "conflict"),
    reproduced:
      rejected && !after.lastScanError && issues(recovered.report).some((issue) => issue.level === "conflict"),
    severity: "P1",
    unrelatedSourceCorruption: true,
    explicitlyScopedHealthyScanRejected: rejected,
    healthyStatusHasLastScanError: !!after.lastScanError,
    healthyReportRemainedOld: after.report.checkedAt === before.report.checkedAt,
    controlAfterRepairFindsConflict: issues(recovered.report).some((issue) => issue.level === "conflict"),
  };
});

await probe("recursive-registration-disables-existing-github-observation", async (t) => {
  const f = await fixture(t);
  const original = join(f.root, "actual-github-clone");
  await observationGit(
    f.root,
    ["clone", "--quiet", "--", "https://github.com/koriym/Koriym.Psr4List.git", original],
    undefined,
    undefined,
    { GIT_ALLOW_PROTOCOL: "https" },
  );
  const before = await trackRepository(original, { github: true });
  assert.equal(before.github, true);
  const clone = join(f.root, "local-clone");
  git(f.root, "clone", original, clone);
  const { call } = await connectMcp(t, clone);
  await call("track_repository", { github: false });
  const root = await call("coordination_status", { cwd: original });
  const child = await call("coordination_status");
  return {
    fixed:
      root.tracking.github === true &&
      child.tracking.github === false &&
      root.tracking.source === child.tracking.source,
    reproduced: root.tracking.github === false,
    severity: "P1",
    authenticGitHubSourceResolution: true,
    authenticGitHubClone: true,
    source: root.tracking.source,
    originalGithubEnabled: before.github,
    originalGithubAfterRegisteringClone: root.tracking.github,
    rootAndCloneStillSameSource: root.tracking.source === child.tracking.source,
  };
});

await probe("sha256-git-repository-observer-algorithm", async (t) => {
  const f = await fixture(t);
  const root = join(f.root, "sha256");
  await mkdir(root);
  try {
    git(root, "init", "--object-format=sha256", "-b", "main");
  } catch {
    return { reproduced: false, skipped: "Installed Git does not support SHA-256 repositories" };
  }
  await writeFile(join(root, "shared.txt"), "initial\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  const a = await addWorktree(root, join(f.root, "sha-a"), "feature/a", true);
  const b = await addWorktree(root, join(f.root, "sha-b"), "feature/b", true);
  await f.commit(a, "shared.txt", "A\n");
  await f.commit(b, "shared.txt", "B\n");
  await subscribe(b);
  await trackRepository(b);
  const { call } = await connectMcp(t, b);
  const report = (await call("scan_repository")).report;
  const algorithmMismatch = report.errors.some((error) =>
    /mismatched algorithms|hash algorithm|sha256|SHA-256/.test(error),
  );
  return {
    fixed: report.errors.length === 0 && issues(report).some((issue) => issue.level === "conflict"),
    reproduced: algorithmMismatch && !issues(report).some((issue) => issue.level === "conflict"),
    severity: "P2",
    realObjectIdLength: git(root, "rev-parse", "HEAD").trim().length,
    scannerErrors: report.errors.map((error) => error.replaceAll(f.root, "<fixture>")),
    confirmedConflictDetected: issues(report).some((issue) => issue.level === "conflict"),
  };
});

await probe("slow-remote-blocks-healthy-source-monitoring", async (t) => {
  const f = await fixture(t);
  const extra = join(f.root, "extra");
  await mkdir(extra);
  git(extra, "init", "-b", "main");
  await writeFile(join(extra, "shared.txt"), "base\n");
  git(extra, "add", ".");
  git(extra, "commit", "-m", "initial");
  const extraPeer = await addWorktree(extra, join(f.root, "extra-peer"), "peer", true);
  const extraReceiver = await addWorktree(extra, join(f.root, "extra-receiver"), "receiver", true);
  const firstRepo = await repository(f.main);
  const extraRepo = await repository(extra);
  const slow = firstRepo.id.localeCompare(extraRepo.id) < 0 ? f.main : extra;
  const healthy = slow === f.main ? extraReceiver : f.b;
  const healthyPeer = slow === f.main ? extraPeer : f.a;
  const sockets = new Set();
  let accepted = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    accepted = true;
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const oldSsh = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND =
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20";
  t.after(() => {
    if (oldSsh === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = oldSsh;
  });
  git(slow, "remote", "add", "origin", `ssh://git@127.0.0.1:${server.address().port}/unavailable.git`);
  await trackRepository(slow);
  await trackRepository(healthy);
  await writeFile(join(healthy, "shared.txt"), "healthy receiver local work\n");
  await f.commit(healthyPeer, "shared.txt", "healthy peer conflict\n");
  const { call } = await connectMcp(t, healthy);
  await call("join_session");
  await eventually(async () => accepted, Boolean);
  await delay(8000);
  const whileBlocked = await call("coordination_status");
  const monitor = await call("monitor_status");
  for (const socket of sockets) socket.destroy();
  const afterRelease = await eventually(
    () => call("coordination_status"),
    (status) => !!status.report,
  );
  return {
    fixed:
      !!whileBlocked.report &&
      monitor.running &&
      issues(whileBlocked.report).some((issue) => issue.level === "conflict"),
    reproduced:
      !whileBlocked.report &&
      monitor.running &&
      issues(afterRelease.report).some((issue) => issue.level === "conflict"),
    severity: "P2",
    realSshHandshakeConnection: accepted,
    holdSeconds: 8,
    healthyReportMissingDuringUnrelatedNetworkStall: !whileBlocked.report,
    monitorHeartbeatStillRunning: monitor.running,
    conflictDetectedAfterReleasingUnrelatedConnection: issues(afterRelease.report).some(
      (issue) => issue.level === "conflict",
    ),
  };
});

const summary = {
  startedAt: start,
  finishedAt: new Date().toISOString(),
  commit: head,
  node: process.version,
  git: git(process.cwd(), "--version").trim(),
  remoteWrites: false,
  implementationModified: git(process.cwd(), "status", "--porcelain", "--", "src").trim().length > 0,
  verification: verifyFixes,
  fixed: results.filter((result) => result.fixed === true).length,
  skipped: results.filter((result) => result.skipped).length,
  results,
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (results.some((result) => result.probeError || (verifyFixes && !result.skipped && result.fixed !== true)))
  process.exitCode = 1;
