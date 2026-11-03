import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { branchStatus } from "../../src/core/branch-status.ts";
import { fixture, git } from "../helpers.ts";

test(
  "unborn status drains both configuration children and keeps the remote error first",
  { timeout: 10_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      empty = join(f.root, "empty"),
      bin = join(f.root, "bin"),
      started = join(f.root, "started"),
      release = join(f.root, "release");
    git(f.root, "init", "-b", "main", empty);
    await mkdir(bin);
    const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
case "$*" in
 *'config --null --get-all branch.main.remote'*) echo 'remote configuration first' >&2; exit 2 ;;
 *'config --null --get-all branch.main.merge'*) : > "$GIT_RELAY_CONFIG_STARTED"; while [ ! -e "$GIT_RELAY_CONFIG_RELEASE" ]; do sleep 0.01; done; printf unterminated; exit 0 ;;
esac
exec "$GIT_RELAY_REAL_GIT" "$@"
`,
      { mode: 0o755 },
    );
    const names = ["PATH", "GIT_RELAY_REAL_GIT", "GIT_RELAY_CONFIG_STARTED", "GIT_RELAY_CONFIG_RELEASE"],
      previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GIT_RELAY_REAL_GIT: actualGit,
      GIT_RELAY_CONFIG_STARTED: started,
      GIT_RELAY_CONFIG_RELEASE: release,
    });
    const controller = new AbortController();
    let pending: ReturnType<typeof branchStatus> | undefined,
      settled = false;
    try {
      pending = branchStatus({ cwd: empty, signal: controller.signal });
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let entered = false;
      for (let i = 0; i < 500 && !entered; i++) {
        entered = await access(started).then(
          () => true,
          () => false,
        );
        if (!entered) await delay(5);
      }
      assert.equal(entered, true);
      assert.equal(settled, false);
      await writeFile(release, "");
      await assert.rejects(pending, /remote configuration first/);
    } finally {
      await writeFile(release, "");
      controller.abort();
      await pending?.catch(() => {});
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
