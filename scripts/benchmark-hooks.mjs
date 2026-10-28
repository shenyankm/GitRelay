import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const candidate = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const [baseline, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, "Usage: node scripts/benchmark-hooks.mjs [baseline-cli.js]");
const variants = baseline ? { baseline: resolve(baseline), candidate } : { candidate };
const temporary = await realpath(await mkdtemp(join(tmpdir(), "gitrelay-hook-bench-")));
const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const samples = Object.fromEntries(Object.keys(variants).map((name) => [name, []]));
async function fingerprint(cli) {
  const root = dirname(dirname(cli));
  const hash = createHash("sha256");
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(root, file)))
      .update("\0");
  return hash.digest("hex");
}
const builds = Object.fromEntries(
  await Promise.all(Object.entries(variants).map(async ([name, cli]) => [name, await fingerprint(cli)])),
);
try {
  const cwd = join(temporary, "repo"),
    state = join(temporary, "state"),
    bin = join(temporary, "bin");
  const calls = join(temporary, "commands.log"),
    usage = join(temporary, "usage.json");
  const preload = join(temporary, "usage.mjs");
  await mkdir(bin);
  await mkdir(state);
  execFileSync(realGit, ["init", "-b", "main", cwd]);
  execFileSync(realGit, [
    "-C",
    cwd,
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "baseline",
  ]);
  for (const [name, target] of [
    ["git", realGit],
    ["ps", "/bin/ps"],
  ])
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> ${quote(calls)}\nexec ${quote(target)} "$@"\n`,
      { mode: 0o755 },
    );
  await writeFile(
    preload,
    `import {writeFileSync} from 'node:fs'; process.on('exit',()=>writeFileSync(process.env.GITRELAY_USAGE_PATH,JSON.stringify(process.resourceUsage())));\n`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    WORKTREE_SYNC_STATE_DIR: state,
    GITRELAY_USAGE_PATH: usage,
  };
  const token = createHash("sha256").update("benchmark-daemon").digest("hex");
  const run = async (cli, event = "PostToolUse", coverage) => {
    await writeFile(join(state, "daemon.lock"), JSON.stringify({ pid: process.pid, token }));
    await writeFile(
      join(state, "daemon.json"),
      JSON.stringify({ pid: process.pid, token, intervalMs: 5000, heartbeatAt: new Date().toISOString() }),
    );
    await writeFile(calls, "");
    const start = performance.now();
    const child = spawn(process.execPath, ["--import", preload, cli, "hook", "codex", "--branch-status"], {
      cwd,
      env: { ...env, ...(coverage ? { NODE_V8_COVERAGE: coverage } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "benchmark", cwd }));
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `Hook exited ${code}`))));
    });
    const wallMs = performance.now() - start;
    const resources = JSON.parse(await readFile(usage, "utf8"));
    const commands = (await readFile(calls, "utf8")).trim().split("\n");
    return {
      output: JSON.parse(stdout),
      wallMs,
      cpuMs: (resources.userCPUTime + resources.systemCPUTime) / 1000,
      maxRssKiB: resources.maxRSS,
      fsReadBlocks: resources.fsRead,
      fsWriteBlocks: resources.fsWrite,
      gitProcesses: commands.filter((line) => line.startsWith("git ")).length,
      psProcesses: commands.filter((line) => line.startsWith("ps ")).length,
      rootProbes: commands.filter((line) => line.includes("rev-parse --show-toplevel")).length,
    };
  };
  for (const cli of Object.values(variants)) await run(cli, "SessionStart");
  for (let sample = 0; sample < 15; sample++) {
    const order = Object.entries(variants);
    if (sample % 2) order.reverse();
    for (const [name, cli] of order) {
      const result = await run(cli);
      assert.deepEqual(result.output, {}, "Idle hook must not invent a notification");
      const { output: _output, ...metrics } = result;
      samples[name].push(metrics);
    }
  }
  assert.ok(samples.candidate.every((row) => row.psProcesses === 0));
  assert.ok(samples.candidate.every((row) => row.rootProbes === 2));
  const loadedModules = {};
  for (const [name, cli] of Object.entries(variants)) {
    const coverage = join(temporary, `coverage-${name}`);
    await run(cli, "PostToolUse", coverage);
    const modules = new Set();
    for (const file of await readdir(coverage))
      for (const script of JSON.parse(await readFile(join(coverage, file), "utf8")).result)
        if (script.url.includes("/dist/")) modules.add(script.url.split("/dist/")[1]);
    loadedModules[name] = [...modules].sort();
  }
  for (const module of [
    "cli/install.js",
    "core/cleanup.js",
    "core/branch-sync.js",
    "core/identity-migration.js",
    "core/daemon.js",
  ])
    assert.ok(!loadedModules.candidate.includes(module));
  const send = (text) =>
    execFileSync(
      process.execPath,
      [candidate, "send", "--cwd", cwd, "--agent", "cli", "--session", "sender", "--message", text],
      { env },
    );
  send("immediate-hook-message");
  assert.match(JSON.stringify((await run(candidate)).output), /immediate-hook-message/);
  send("stop-hook-message");
  const stop = (await run(candidate, "Stop")).output;
  assert.equal(stop.decision, "block");
  assert.match(JSON.stringify(stop), /stop-hook-message/);
  assert.deepEqual((await run(candidate, "Stop")).output, {});
  for (const [name, cli] of Object.entries(variants))
    assert.equal(await fingerprint(cli), builds[name], "Build changed during benchmark");
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          git: execFileSync(realGit, ["--version"], { encoding: "utf8" }).trim(),
          platform: platform(),
          arch: arch(),
        },
        workload:
          "15 alternating full CLI idle PostToolUse samples per variant; one session, warm filesystem caches, healthy synthetic daemon; wrapper process overhead included",
        limits:
          "Node startup remains per hook. CPU and RSS are per-child OS metrics; block counters are not physical disk bytes. Native host/model latency and cold caches are not measured.",
        baselineCliSha256: baseline
          ? createHash("sha256")
              .update(await readFile(baseline))
              .digest("hex")
          : undefined,
        candidateCliSha256: createHash("sha256")
          .update(await readFile(candidate))
          .digest("hex"),
        medians: Object.fromEntries(
          Object.entries(samples).map(([name, rows]) => [
            name,
            Object.fromEntries(Object.keys(rows[0]).map((metric) => [metric, median(rows.map((row) => row[metric]))])),
          ]),
        ),
        loadedModules,
        buildSha256: builds,
        samples,
        checks: { immediateMessages: true, stopContinuation: true, deduplication: true },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
