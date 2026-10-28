import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { commandOutputs } from "./command-output.ts";

const clients = {
  codex: { command: "codex", verified: "0.164.0" },
  opencode: { command: "opencode", verified: "2.1.2" },
} as const;

export type Platform = keyof typeof clients;
export type Detection =
  | { platform: Platform; status: "missing" }
  | { platform: Platform; status: "unavailable"; reason: string }
  | {
      platform: Platform;
      status: "installed" | "incompatible" | "unverified";
      version: string;
      previouslyTested: boolean;
    };

export async function detectPlatform(
  platform: Platform,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<Detection> {
  signal?.throwIfAborted();
  const { command, verified } = clients[platform];
  if (env.PATH === undefined) return { platform, status: "unavailable", reason: "PATH is not set" };
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  let output: { stdout: string; stderr: string } | undefined;
  let inaccessible: string | undefined;
  let failedSpawn: Error | undefined;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      signal?.throwIfAborted();
      const candidate = join(directory || ".", command + extension);
      try {
        const info = await stat(candidate);
        signal?.throwIfAborted();
        if (!info.isFile()) {
          inaccessible ??= candidate;
          continue;
        }
        await access(candidate, constants.X_OK);
        signal?.throwIfAborted();
        try {
          output = await commandOutputs(candidate, ["--version"], env, 5000, 64 * 1024, signal);
          signal?.throwIfAborted();
          break;
        } catch (error) {
          signal?.throwIfAborted();
          const failure = error as NodeJS.ErrnoException;
          if ((failure.code === "ENOENT" || failure.code === "EACCES") && failure.syscall === `spawn ${candidate}`) {
            failedSpawn ??= failure;
            continue;
          }
          return { platform, status: "unavailable", reason: `Version check failed: ${(error as Error).message}` };
        }
      } catch (error) {
        signal?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          try {
            await lstat(candidate);
            signal?.throwIfAborted();
            inaccessible ??= candidate;
          } catch (entryError) {
            signal?.throwIfAborted();
            if (!["ENOENT", "ENOTDIR"].includes((entryError as NodeJS.ErrnoException).code ?? ""))
              inaccessible ??= candidate;
          }
        } else {
          inaccessible ??= candidate;
        }
      }
    }
    if (output) break;
  }
  signal?.throwIfAborted();
  if (!output)
    return failedSpawn
      ? { platform, status: "unavailable", reason: `Version check failed: ${failedSpawn.message}` }
      : inaccessible
        ? { platform, status: "unavailable", reason: `Cannot execute ${inaccessible}` }
        : { platform, status: "missing" };
  try {
    const { stdout, stderr } = output;
    const semver =
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;
    // A version attached to a wrapper name can still make stdout ambiguous.
    const stderrClaims = stderr.matchAll(
      new RegExp(
        `^\\s*${command}(?:-cli)?(?:\\s+(?:version\\s+)?|-)v?(\\d+\\.\\d+\\.\\d+[\\w.+-]*)(?![\\w.+/\\\\-])`,
        "gim",
      ),
    );
    const allVersions = new Set([
      ...[...stdout.matchAll(/v?(\d+\.\d+\.\d+[\w.+-]*)/g)].map((match) => match[1]),
      ...[...stderrClaims].map((match) => match[1]).filter((candidate) => semver.test(candidate)),
    ]);
    const matches = [...stdout.matchAll(/(?:^|[^\w.+-])(v?)(\d+\.\d+\.\d+[\w.+-]*)/g)];
    const versions = new Set(matches.map((match) => match[2]));
    if (allVersions.size > 1)
      return { platform, status: "unavailable", reason: "Ambiguous version output: multiple distinct versions" };
    const version = versions.values().next().value;
    if (!version || matches.some((match) => match[1].length + match[2].length > 256) || !semver.test(version)) {
      return { platform, status: "unavailable", reason: "Unrecognized version output" };
    }
    const previouslyTested = version === verified;
    const versionWithoutBuild = version.split("+", 1)[0];
    const [major, minor, patch] = versionWithoutBuild.split("-", 1)[0].split(".").map(Number);
    if (![major, minor, patch].every(Number.isSafeInteger)) {
      return { platform, status: "unavailable", reason: "Unrecognized version output" };
    }
    const prerelease = versionWithoutBuild.includes("-");
    const supportedOpenCode =
      platform === "opencode" && major === 2 && !prerelease && (minor > 1 || (minor === 1 && patch >= 2));
    const status =
      platform === "opencode" && major < 2
        ? "incompatible"
        : previouslyTested || supportedOpenCode
          ? "installed"
          : "unverified";
    return { platform, status, version, previouslyTested };
  } catch (error) {
    signal?.throwIfAborted();
    return { platform, status: "unavailable", reason: `Version check failed: ${(error as Error).message}` };
  }
}
