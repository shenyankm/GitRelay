import { setTimeout as delay } from "node:timers/promises";
import { runDaemon, type DaemonOptions } from "./daemon.ts";
import { BusyError } from "./store.ts";

/** Each connected server can take over when the current shared monitor exits. */
export async function runMonitor(options: DaemonOptions): Promise<void> {
  while (!options.signal.aborted) {
    try {
      await runDaemon(options);
    } catch (error) {
      if (options.signal.aborted) return;
      if (!(error instanceof BusyError))
        await options.onEvent?.({
          type: "monitor.error",
          message: error instanceof Error ? error.message : String(error),
        });
    }
    if (!options.signal.aborted) await delay(1000, undefined, { signal: options.signal }).catch(() => {});
  }
}
