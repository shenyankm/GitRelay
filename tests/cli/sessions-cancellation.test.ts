import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "../helpers.ts";

const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`sessions cancels repository discovery on ${signal}`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    const bin = join(f.root, "bin"),
      log = join(f.root, "git.log");
    await mkdir(bin);
    await writeFile(join(bin, "git"), '#!/bin/sh\nprintf "%s\\n" "$$" >> "$TEST_GIT_LOG"\nexec /bin/sleep 30\n', {
      mode: 0o755,
    });
    const child = spawn(process.execPath, [cli, "sessions", "--cwd", f.b], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_GIT_LOG: log },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "",
      forced = false;
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    try {
      const deadline = performance.now() + 10_000;
      while (!(await stat(log).catch(() => undefined))) {
        assert.ok(performance.now() < deadline, "Git did not start");
        await delay(10);
      }
      child.kill(signal);
      const force = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 8000);
      try {
        assert.equal(await exited, exitCode, stderr);
        assert.match(await readFile(log, "utf8"), /^\d+\n$/);
      } finally {
        clearTimeout(force);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        forced = true;
        child.kill("SIGKILL");
      }
      await exited;
      for (const pid of (forced ? await readFile(log, "utf8").catch(() => "") : "").trim().split("\n")) {
        if (pid)
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            /* Already stopped. */
          }
      }
    }
  });
}
