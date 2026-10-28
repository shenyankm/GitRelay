import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { fixture, git } from "../helpers.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

test("watch commands reject permanent input errors before entering their retry loop", async (t) => {
  const f = await fixture(t);
  for (const [args, message] of [
    [["watch", "--session", "x".repeat(513)], /max 512/],
    [["watch", "--session", "s", "--agent", "x".repeat(65)], /max 64/],
    [["watch", "--session", "s", "--instance", "bad"], /64-character ID/],
    [["watch", "--session", "s", "--ref", "not-a-ref"], /full branch ref/],
    [["watch", "--session", "s", "--ref", "refs/heads/bad..name"], /check-ref-format/],
    [["status", "--watch", "--branch", "bad..name", "--interval-ms", "50"], /check-ref-format/],
    [
      ["status", "--watch", "--session", "s", "--ref", "refs/heads/bad..name", "--interval-ms", "50"],
      /check-ref-format/,
    ],
    [["status", "--watch", "--session", "x".repeat(513), "--interval-ms", "50"], /max 512/],
    [["status", "--watch", "--github", "--repo", "invalid", "--interval-ms", "5000"], /--repo must be/],
    [
      ["status", "--watch", "--github", "--repo", "ghe.invalid:65536/owner/repo", "--interval-ms", "5000"],
      /--repo must be/,
    ],
  ] as const) {
    await assert.rejects(
      exec(process.execPath, [cli, ...args, "--cwd", f.b], { timeout: 3000 }),
      (error: Error & { code?: unknown }) => {
        assert.equal(error.code, 1);
        assert.match(error.message, message);
        return true;
      },
    );
  }
});

test(
  "status watch accepts a GitHub host with a port",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "gh-bin"),
      hosts = join(f.root, "hosts");
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'repo') console.log(JSON.stringify({nameWithOwner:'owner/repo',url:'https://ghe.invalid:8443/owner/repo'}));
else { fs.writeFileSync(${JSON.stringify(hosts)}, process.env.GH_HOST || ''); console.log(JSON.stringify([[{ref:'refs/heads/feature/b',object:{type:'commit',sha:${JSON.stringify(f.initial)}}}]])); }
`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [
        cli,
        "status",
        "--cwd",
        f.b,
        "--watch",
        "--github",
        "--repo",
        "ghe.invalid:8443/owner/repo",
        "--interval-ms",
        "5000",
      ],
      { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill("SIGKILL"));
    const exit = once(child, "exit");
    let output = "",
      stderr = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (stderr += data));
    const deadline = Date.now() + 5000;
    while (!output && child.exitCode === null && Date.now() < deadline) await delay(25);
    assert.ok(output, stderr);
    assert.equal(JSON.parse(output).github.matchesLocal, true);
    assert.equal(await readFile(hosts, "utf8"), "ghe.invalid:8443");
    child.kill("SIGTERM");
    assert.deepEqual(await exit, [0, null]);
  },
);

test(
  "watch validates the ref after a transient Git startup failure",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "bin"),
      marker = join(f.root, "tried");
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ ! -f "$WATCH_TEST_MARKER" ]; then /usr/bin/touch "$WATCH_TEST_MARKER"; exit 77; fi\nexec "$WATCH_TEST_GIT" "$@"\n',
    );
    await chmod(join(bin, "git"), 0o755);
    await assert.rejects(
      exec(process.execPath, [cli, "status", "--cwd", f.b, "--watch", "--branch", "bad..name", "--interval-ms", "50"], {
        timeout: 3000,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          WATCH_TEST_MARKER: marker,
          WATCH_TEST_GIT: realGit,
        },
      }),
      (error: Error & { code?: unknown }) => {
        assert.equal(error.code, 1);
        assert.match(error.message, /check-ref-format/);
        return true;
      },
    );
  },
);

test("status watch retries a repository that appears later", { timeout: 10000 }, async (t) => {
  const f = await fixture(t),
    target = join(f.root, "later");
  const child = spawn(
    process.execPath,
    [cli, "status", "--cwd", target, "--watch", "--branch", "main", "--interval-ms", "50"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill("SIGKILL"));
  const exit = once(child, "exit");
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  await delay(200);
  assert.equal(child.exitCode, null);
  await mkdir(target);
  git(target, "init", "-b", "main");
  const deadline = Date.now() + 5000;
  while (!output && Date.now() < deadline) await delay(25);
  assert.equal(JSON.parse(output).local.ref, "refs/heads/main");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});

test(
  "status watch with a session retries transient ref validation failure",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "git-bin"),
      marker = join(f.root, "git-tried");
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ ! -f "$WATCH_TEST_MARKER" ]; then /usr/bin/touch "$WATCH_TEST_MARKER"; exit 77; fi\nexec "$WATCH_TEST_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [cli, "status", "--cwd", f.b, "--watch", "--session", "s", "--interval-ms", "50"],
      {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          WATCH_TEST_MARKER: marker,
          WATCH_TEST_GIT: realGit,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => child.kill("SIGKILL"));
    const exit = once(child, "exit");
    let output = "",
      stderr = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (stderr += data));
    const deadline = Date.now() + 5000;
    while (!output && child.exitCode === null && Date.now() < deadline) await delay(25);
    assert.ok(output, stderr);
    assert.equal(JSON.parse(output).type, "worktree.branch-status");
    child.kill("SIGTERM");
    assert.deepEqual(await exit, [0, null]);
  },
);
