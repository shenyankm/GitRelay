import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPlatform, type Platform } from "./platform-detection.ts";
import {
  checkWorkspace,
  ensureWorkspace,
  validateWorkspacePath,
  codexDirectory,
  installCodex,
  uninstallCodex,
  validCodexRecord,
} from "./install-codex.ts";
import { readInstallationRecord } from "./install-record.ts";

const platforms: Platform[] = ["codex"];

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await lstat(path);
      throw new Error(`Cannot resolve existing path: ${path}`);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDirectory(parent), basename(path));
  }
}

export async function install(
  action: "install" | "uninstall",
  selected: string[] = [],
  skipped: string[] = [],
  dryRun = false,
  allowUnverified = false,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  for (const platform of [...selected, ...skipped]) {
    if (!platforms.includes(platform as Platform)) throw new Error(`Unknown platform: ${platform}`);
    if (selected.includes(platform) && skipped.includes(platform))
      throw new Error(`Platform both selected and skipped: ${platform}`);
  }
  const env = process.env;
  const data =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), ".local", "share");
  const root = join(await canonicalDirectory(data), "git-relay");
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const results: object[] = [];
  let failed = false;
  for (const platform of platforms) {
    signal?.throwIfAborted();
    if ((selected.length && !selected.includes(platform)) || skipped.includes(platform)) {
      results.push({ platform, status: "skipped" });
      continue;
    }
    try {
      if (action === "install") {
        const detected = await detectPlatform(platform, env, signal);
        if (detected.status !== "installed" && !(detected.status === "unverified" && allowUnverified)) {
          results.push(detected);
          if (detected.status !== "missing" || selected.includes(platform)) failed = true;
          continue;
        }
        if (dryRun) {
          validateWorkspacePath(root);
          await installCodex({ workspace: root, sourceRoot, signal, clientVersion: detected.version, dryRun: true });

          results.push(detected);
          continue;
        }
        await ensureWorkspace(root);
        await installCodex({ workspace: root, sourceRoot, signal, clientVersion: detected.version });
        results.push({
          ...detected,
          status: "pending-trust",
          action: "Review and trust the hooks through /hooks in Codex.",
        });
      } else {
        const legacy = await lstat(join(root, "codex-install.json")).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (legacy)
          throw new Error(
            "Automatic Codex uninstall is unavailable for the previous plugin installation; existing data was preserved.",
          );
        const exists = await lstat(join(root, "codex-hooks.json")).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (!exists) {
          results.push({ platform, status: "not-managed" });
          continue;
        }
        await checkWorkspace(root);
        const state = await readInstallationRecord(join(root, "codex-hooks.json"), "Codex");
        if (!validCodexRecord(state, join(await codexDirectory(env), "hooks.json"), root))
          throw new Error(`Invalid Codex installation record: ${join(root, "codex-hooks.json")}`);
        if (state.removed === true) {
          results.push({ platform, status: "not-managed" });
          continue;
        }
        if (dryRun) {
          results.push({ platform, status: "would-check-and-remove" });
          continue;
        }
        const archive = await uninstallCodex({ workspace: root, signal });
        results.push({ platform, status: "removed", ...(archive ? { archive } : {}) });
      }
    } catch (error) {
      signal?.throwIfAborted();
      failed = true;
      results.push({ platform, status: "error", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  signal?.throwIfAborted();
  return { workspace: root, results, failed };
}
