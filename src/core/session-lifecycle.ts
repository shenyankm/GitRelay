import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { sessionActivation } from "./activation.ts";
import {
  joinSession,
  leaveSession,
  leaveSessionIfRepository,
  preflightLeaveSession,
  type SessionOptions,
  type LeaveOptions,
} from "./sessions.ts";
import type { Session } from "./mailbox.ts";

/** Commit activation and enrollment together; a concurrent disable keeps its priority. */
export async function enableSession(options: SessionOptions): Promise<Session | undefined> {
  options = { ...options };
  const token = randomUUID();
  const disabled = Symbol();
  let joined: Awaited<ReturnType<typeof joinSession>> | undefined;
  await sessionActivation(options, true, undefined, {
    token,
    phase: "begin",
    priorEnabled: await sessionActivation(options),
  });
  try {
    await joinSession(options, async (register, repositoryId, subscriptionKey) => {
      const prepared = await sessionActivation(options, true, undefined, {
        token,
        phase: "prepare",
        repositoryId,
        subscriptionKey,
        run: async () => {
          joined = await register(token);
        },
      });
      if (!prepared) throw disabled;
      if (!joined) throw new Error("gitbeacon subscription was not registered.");
      return joined;
    });
  } catch (error) {
    if (!joined)
      await sessionActivation({ ...options, signal: undefined }, true, undefined, { token, phase: "failure" });
    if (error === disabled) {
      return;
    }
    throw error;
  }
  if (!(await sessionActivation(options))) {
    await leaveSession(options);
    return;
  }
  return joined;
}

/** Persist opt-out before closing enrollment, preserving unread messages and recovery checks. */
export async function disableSession(options: LeaveOptions): Promise<Session | undefined> {
  options = { ...options };
  const checked = await preflightLeaveSession(options);
  await sessionActivation(options, false, checked);
  const session =
    options.repositoryId !== undefined ? await leaveSession(options) : await leaveSessionIfRepository(options, checked);
  if (!checked.root && !session && options.repositoryId === undefined) {
    const exists = await stat(options.cwd).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!exists) throw new Error("Worktree is unavailable; select repositoryId if needed.");
  }
  return session;
}
