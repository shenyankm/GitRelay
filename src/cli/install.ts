import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPlatform, type Platform } from "./platform-detection.ts";
import {
  checkWorkspace,
  ensureWorkspace,
  installOpenCode,
  uninstallOpenCode,
  validRecord,
  validateWorkspacePath,
} from "./install-opencode.ts";
import { codexDirectory, installCodex, uninstallCodex, validCodexRecord } from "./install-codex.ts";
import { readInstallationRecord } from "./install-record.ts";
import { readJson } from "../core/store.ts";

const platforms: Platform[] = ["codex", "opencode"];

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
  const config =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  const root = join(await canonicalDirectory(data), "git-relay");
  const sourceDist = fileURLToPath(new URL("../../dist", import.meta.url));
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const results: object[] = [];
  let failed = false;
  const executionOrder: Platform[] =
    action === "install" ? [...platforms.filter((platform) => platform !== "codex"), "codex"] : platforms;
  for (const platform of executionOrder) {
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
          const exists = await lstat(root).then(
            () => true,
            (error) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          );
          if (exists) await checkWorkspace(root);
          if (platform === "codex" && (await readJson(join(root, "codex-install.json"))) !== undefined)
            throw new Error("A previous Codex plugin installation record exists; inspect it before installing hooks.");
          const name = platform === "codex" ? "Codex" : "OpenCode";
          const state = join(root, platform === "codex" ? "codex-hooks.json" : "opencode.json");
          const record = await readInstallationRecord(state, name);
          const valid =
            platform === "codex"
              ? validCodexRecord(record, join(await codexDirectory(env), "hooks.json"), root)
              : validRecord(
                  record,
                  join(await canonicalDirectory(config), "opencode", "plugins", "git-relay.js"),
                  root,
                );
          if (record !== undefined && !valid) throw new Error(`Invalid ${name} installation record: ${state}`);
          if (record && typeof record === "object" && "removing" in record && record.removing)
            throw new Error("An uninstall is incomplete; rerun uninstall before installing.");
          results.push(detected);
          continue;
        }
        if (platform === "opencode") {
          await installOpenCode(root, await canonicalDirectory(config), sourceDist, signal);
          results.push({ ...detected, status: "configured" });
        } else {
          await ensureWorkspace(root);
          await installCodex({ workspace: root, sourceRoot, signal, clientVersion: detected.version });
          results.push({
            ...detected,
            status: "pending-trust",
            action: "Review and trust the hooks through /hooks in Codex.",
          });
        }
      } else {
        if (platform === "codex") {
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
          continue;
        }
        const exists = await lstat(join(root, "opencode.json")).then(
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
        const canonicalConfig = await canonicalDirectory(config);
        const record = await readInstallationRecord(join(root, "opencode.json"), "OpenCode");
        const entry = join(canonicalConfig, "opencode", "plugins", "git-relay.js");
        if (!validRecord(record, entry, root))
          throw new Error(`Invalid OpenCode installation record: ${join(root, "opencode.json")}`);
        if (record.removed === true) {
          results.push({ platform, status: "not-managed" });
          continue;
        }
        const archive = dryRun ? undefined : await uninstallOpenCode(root, canonicalConfig, signal);
        results.push({
          platform,
          status: dryRun ? "would-check-and-remove" : "removed",
          ...(archive ? { archive } : {}),
        });
      }
    } catch (error) {
      signal?.throwIfAborted();
      failed = true;
      results.push({ platform, status: "error", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  signal?.throwIfAborted();
  results.sort(
    (a, b) =>
      platforms.indexOf((a as { platform: Platform }).platform) -
      platforms.indexOf((b as { platform: Platform }).platform),
  );
  return { workspace: root, results, failed };
}
