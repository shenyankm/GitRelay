import { join } from "node:path";
import { isId, readJson, stateDirectory } from "./store.ts";

export interface DaemonState {
  pid: number;
  token: string;
  intervalMs: number;
  heartbeatAt: string;
}

/** Never kill a process by a persisted PID: this is only a short-lived liveness hint. */
export async function daemonStatus(): Promise<{ running: boolean; state?: DaemonState }> {
  const root = stateDirectory();
  // A lock can be empty between open and write, or left corrupt after a crash.
  const lock = (await readJson(join(root, "daemon.lock")).catch(() => undefined)) as
    { pid?: number; token?: string } | undefined;
  if (!lock) return { running: false };
  const state = (await readJson(join(root, "daemon.json")).catch(() => undefined)) as DaemonState | undefined;
  if (
    !state ||
    !Number.isInteger(state.pid) ||
    state.pid <= 0 ||
    !isId(state.token) ||
    state.pid !== lock.pid ||
    state.token !== lock.token ||
    !Number.isInteger(state.intervalMs) ||
    state.intervalMs < 50 ||
    state.intervalMs > 60_000
  )
    return { running: false };
  if (typeof state.heartbeatAt !== "string") return { running: false };
  const age = Date.now() - Date.parse(state.heartbeatAt);
  if (!Number.isFinite(age) || age < 0 || age > Math.max(15_000, state.intervalMs * 3)) return { running: false };
  try {
    process.kill(state.pid, 0);
  } catch {
    return { running: false };
  }
  return { running: true, state };
}
