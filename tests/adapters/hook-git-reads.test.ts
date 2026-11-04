import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runHook } from "../../src/adapters/hooks.ts";
import { resolveMain, watchRoot } from "../../src/core/changes.ts";
import { sessionsIn } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture, git } from "../helpers.ts";

for (const explicitWorkTree of [false, true])
  test(
    `hooks reuse their discovered root with explicit worktree selection ${explicitWorkTree}`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await fixture(t),
        nested = join(f.main, "nested"),
        ref = "refs/heads/main";
      await mkdir(nested);
      git(nested, "init", "-b", "main");
      const executable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const bin = join(f.root, "bin"),
        calls = join(f.root, "calls");
      await mkdir(bin);
      await writeFile(
        join(bin, "git"),
        `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
process.exit(cp.spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' }).status ?? 1);
`,
        { mode: 0o755 },
      );
      const previous = {
        PATH: process.env.PATH,
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      };
      try {
        process.env.PATH = `${bin}:${previous.PATH ?? ""}`;
        if (explicitWorkTree) {
          process.env.GIT_DIR = join(f.main, ".git");
          process.env.GIT_WORK_TREE = f.main;
        }
        const cwd = explicitWorkTree ? nested : f.main;
        const output: object[] = [];
        await runHook({ hook_event_name: "PostToolUse", cwd, session_id: "receiver" }, ref, async (value) => {
          output.push(value);
        });
        assert.deepEqual(output, [{}]);
        const commands = (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        assert.equal(commands.filter((args) => args.includes("--show-toplevel")).length, 1);
        assert.equal(commands.length, 3);
        await assert.rejects(resolveMain(f.main, "refs/heads/bad..ref"), /check-ref-format/);
        assert.ok(!commands.some((args) => args.includes("check-ref-format")));
        const repo = await repository(f.main);
        assert.equal(repo.common, join(f.main, ".git"));
        assert.deepEqual(
          (await sessionsIn(repo)).map((session) => session.root),
          [f.main],
        );
        await assert.rejects(
          runHook(
            { hook_event_name: "PostToolUse", cwd, session_id: "receiver" },
            "refs/heads/bad..ref",
            async () => {},
          ),
          /check-ref-format/,
        );
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

test("root reuse preserves relative GIT_DIR common-directory selection", async (t) => {
  const f = await fixture(t),
    nested = join(f.main, "nested");
  await mkdir(nested);
  git(nested, "init", "-b", "main");
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = ".git";
    process.env.GIT_WORK_TREE = f.main;
    const expected = await repository(nested);
    const selected = await repository(nested, undefined, true, await watchRoot(nested));
    assert.deepEqual(selected, expected);
    assert.equal(selected.common, join(f.main, ".git"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
