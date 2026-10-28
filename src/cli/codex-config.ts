import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "../../vendor/smol-toml/index.js";

const relayCommand =
  /(?:^|[\s"'`;|&()])(?:[^\s"'`;|&()]*\/)?(?:git-relay|worktree-relay|worktree-sync|pi-git-worktree)(?=$|[\s"'`;|&()])|codex-current\.mjs|\bhook\s+codex\b/i;
const staticPrint = /^[ \t]*(?:echo|printf)(?:[ \t]+(?:[\w./:%+=,@-]+|'[^']*'|"[^"$`\\]*"))*[ \t]*$/;
const hookEvents = new Set([
  "PreModelRequest",
  "PostModelRequest",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
]);
const hookMetadata = new Set(["state", "managed_dir", "windows_managed_dir", "managedDir", "windowsManagedDir"]);

export async function checkInlineHooks(home: string, signal?: AbortSignal, clientVersion?: string): Promise<void> {
  const names = await readdir(home);
  const candidates = ["config.toml", ...names.filter((name) => /^[A-Za-z0-9_-]+\.config\.toml$/.test(name))];
  for (const name of candidates) {
    signal?.throwIfAborted();
    const path = join(home, name);
    let config: unknown;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("not a small regular file");
        const data = Buffer.allocUnsafe(2 * 1024 * 1024 + 1);
        let used = 0;
        while (used < data.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(data, used, data.length - used, used);
          if (!bytesRead) break;
          used += bytesRead;
        }
        if (used > 2 * 1024 * 1024) throw new Error("not a small regular file");
        const after = await file.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
          throw new Error("configuration changed during inspection");
        signal?.throwIfAborted();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, used));
        config = parse(text, { integersAsBigInt: "asNeeded", maxDepth: 100 });
      } finally {
        await file.close();
      }
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await lstat(path);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw failure;
        }
      }
      throw new Error(
        `Cannot inspect Codex configuration; existing file was preserved: ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error(`Cannot interpret Codex configuration; existing file was preserved: ${path}`);
    const hooks = (config as { hooks?: unknown }).hooks;
    if (hooks === undefined || hooks === null) continue;
    if (typeof hooks !== "object" || Array.isArray(hooks))
      throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
    for (const [event, groups] of Object.entries(hooks)) {
      if (!hookEvents.has(event)) {
        if (!hookMetadata.has(event) && clientVersion !== "0.164.0")
          throw new Error(
            `Cannot verify unknown Codex hook event ${event} for this client version; existing file was preserved: ${path}`,
          );
        continue;
      }
      if (!Array.isArray(groups))
        throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
      for (const group of groups) {
        if (
          !group ||
          typeof group !== "object" ||
          Array.isArray(group) ||
          ((group as { hooks?: unknown }).hooks !== undefined && !Array.isArray((group as { hooks?: unknown }).hooks))
        )
          throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
        if (
          (group as { matcher?: unknown }).matcher !== undefined &&
          typeof (group as { matcher?: unknown }).matcher !== "string"
        )
          throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
        for (const handler of (group as { hooks?: unknown[] }).hooks ?? []) {
          if (!handler || typeof handler !== "object" || Array.isArray(handler))
            throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
          const type = (handler as { type?: unknown }).type;
          if (typeof type !== "string" || !["command", "mcp_tool", "prompt", "agent"].includes(type))
            throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
          if (type === "command" && typeof (handler as { command?: unknown }).command !== "string")
            throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
          if (
            type === "mcp_tool" &&
            (typeof (handler as { server?: unknown }).server !== "string" ||
              typeof (handler as { tool?: unknown }).tool !== "string")
          )
            throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
          for (const key of ["command", "commandWindows", "command_windows"]) {
            const command = (handler as { [key: string]: unknown })[key];
            if (command !== undefined && typeof command !== "string")
              throw new Error(`Cannot interpret Codex inline hooks; existing file was preserved: ${path}`);
            if (typeof command === "string" && relayCommand.test(command) && !staticPrint.test(command))
              throw new Error(`Codex inline hooks may already contain GitRelay; existing file was preserved: ${path}`);
          }
        }
      }
    }
  }
}
