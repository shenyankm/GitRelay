import { parseArgs } from "node:util";
import { parse } from "node:path";
import { git } from "../core/git.ts";

export function parseArguments() {
  return parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      cwd: { type: "string" },
      branch: { type: "string" },
      github: { type: "boolean" },
      repo: { type: "string" },
      watch: { type: "boolean" },
      "auto-sync": { type: "boolean" },
      "no-auto-sync": { type: "boolean" },
      "branch-status": { type: "boolean" },
      format: { type: "string" },
      output: { type: "string" },
      ref: { type: "string", default: process.env.WORKTREE_MAIN_REF ?? "refs/heads/main" },
      session: { type: "string" },
      instance: { type: "string" },
      "acknowledge-history-gap": { type: "boolean" },
      "repository-id": { type: "string" },
      agent: { type: "string", default: "cli" },
      message: { type: "string" },
      file: { type: "string", multiple: true },
      apply: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "retention-days": { type: "string", default: "7" },
      "interval-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
      platform: { type: "string", multiple: true },
      skip: { type: "string", multiple: true },
      "allow-unverified": { type: "boolean" },
      automatic: { type: "boolean" },
    },
  });
}

export type CliValues = ReturnType<typeof parseArguments>["values"];

const commandOptions: Record<string, readonly string[]> = {
  status: [
    "cwd",
    "branch",
    "github",
    "repo",
    "watch",
    "auto-sync",
    "no-auto-sync",
    "format",
    "output",
    "session",
    "instance",
    "agent",
    "ref",
    "interval-ms",
  ],
  check: ["cwd", "ref", "session", "instance", "agent", "acknowledge-history-gap", "apply"],
  watch: ["cwd", "ref", "session", "instance", "agent"],
  send: ["cwd", "ref", "session", "instance", "agent", "message", "file"],
  sessions: ["cwd"],
  join: ["cwd", "ref", "session", "instance", "agent"],
  leave: ["cwd", "ref", "session", "instance", "agent", "repository-id"],
  gc: ["cwd", "apply", "dry-run", "retention-days"],
  daemon: ["interval-ms", "retention-days", "automatic"],
  "daemon status": [],
  hook: ["ref", "branch-status"],
  install: ["platform", "skip", "dry-run", "allow-unverified"],
  uninstall: ["platform", "skip", "dry-run", "allow-unverified"],
  "identity-fresh": ["cwd", "apply"],
  "identity-migrate": ["cwd", "apply"],
  "identity-recover": ["cwd", "apply"],
};

/** Validate explicitly supplied options; parser defaults do not count as user input. */
export function validateCommandOptions(command: string, tokens: ReturnType<typeof parseArguments>["tokens"]): void {
  const allowed = commandOptions[command];
  if (!allowed) return;
  for (const token of tokens) {
    if (token.kind === "option" && token.name !== "help" && !allowed.includes(token.name))
      throw new Error(`--${token.name} is not supported by ${command}.`);
  }
}

export async function validateWatchRef(ref: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await git(parse(process.execPath).root, ["check-ref-format", ref], signal);
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    const cause = (error as Error & { cause?: { code?: unknown; stderr?: Buffer | string } }).cause;
    if (cause?.code === 1 && !cause.stderr?.toString()) throw error;
    return false;
  }
}
