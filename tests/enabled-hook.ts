import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/adapters/hooks.ts";
import { sessionActivation } from "../src/core/activation.ts";

/** Exercise enabled-hook diagnostics without reading or writing the user's state. */
export async function runEnabledHook(...args: Parameters<typeof runHook>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "git-relay-enabled-hook-"));
  const previous = process.env.WORKTREE_SYNC_STATE_DIR;
  process.env.WORKTREE_SYNC_STATE_DIR = directory;
  try {
    const [input, ref, , signal] = args;
    await sessionActivation(
      { cwd: input.cwd as string, ref, adapter: "codex", session: input.session_id as string, signal },
      true,
    );
    await runHook(...args);
  } finally {
    if (previous === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR;
    else process.env.WORKTREE_SYNC_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
