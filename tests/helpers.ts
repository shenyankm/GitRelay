import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree } from "../src/core/git.ts";

const fixtureCleanups = new WeakMap<object, (() => Promise<void>)[]>();

export function beforeFixtureCleanup(t: { after(fn: () => Promise<void>): void }, cleanup: () => Promise<void>) {
  const callbacks = fixtureCleanups.get(t);
  if (callbacks) callbacks.push(cleanup);
  else t.after(cleanup);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

export async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const temp = await mkdtemp(join(tmpdir(), "gitbeacon-"));
  if (!fixtureCleanups.has(t)) fixtureCleanups.set(t, []);
  t.after(async () => {
    const callbacks = fixtureCleanups.get(t)!;
    await Promise.all(callbacks.splice(0).map((cleanup) => cleanup()));
    await rm(temp, { recursive: true, force: true });
  });
  const root = await realpath(temp);
  const previousState = process.env.GITBEACON_STATE_DIR;
  process.env.GITBEACON_STATE_DIR = join(root, "state");
  t.after(() => {
    if (previousState === undefined) delete process.env.GITBEACON_STATE_DIR;
    else process.env.GITBEACON_STATE_DIR = previousState;
  });
  const main = join(root, "main");
  git(root, "init", "-b", "main", main);
  await writeFile(join(main, "shared.txt"), "base\n");
  await writeFile(join(main, "other.txt"), "other\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  const initial = git(main, "rev-parse", "HEAD").trim();
  const a = await addWorktree(main, join(root, "a"), "feature/a", true);
  const b = await addWorktree(main, join(root, "b"), "feature/b", true);
  const c = await addWorktree(main, join(root, "c"), "feature/c", true);
  const commit = async (cwd: string, file: string, content: string) => {
    await writeFile(join(cwd, file), content);
    git(cwd, "add", "--", file);
    git(cwd, "commit", "-m", `update ${file}`);
    return git(cwd, "rev-parse", "HEAD").trim();
  };
  return { root, main, a, b, c, initial, commit };
}
