#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { consumeMailbox } from "../core/consumer.ts";
import {
  formatNotifications,
  listSessions,
  messagePayloadWithinLimit,
  sendMessage,
  validateIdentity,
} from "../core/mailbox.ts";
import { runHook } from "../adapters/hooks.ts";
import { joinSession, leaveSession } from "../core/sessions.ts";
import { sessionActivation } from "../core/activation.ts";
import { collectGarbage } from "../core/cleanup.ts";
import { runDaemon } from "../core/daemon.ts";
import { daemonStatus } from "../core/daemon-state.ts";
import { branchStatus, validateGitHubRepository } from "../core/branch-status.ts";
import { syncBranch } from "../core/branch-sync.ts";
import { git, gitRefLine } from "../core/git.ts";
import { writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { formatBranchStatus } from "../core/status-format.ts";
import { install } from "./install.ts";
import {
  chooseFreshRepository,
  hash,
  recordRepositoryIdentity,
  recoverRepositoryInitialization,
  stateDirectory,
  withRepositoryIdentity,
} from "../core/store.ts";
import { migrateLegacyState } from "../core/identity-migration.ts";
import { join, parse } from "node:path";

const abort = new AbortController();
let stopSignal: "SIGINT" | "SIGTERM" | undefined;
const stop = (signal: "SIGINT" | "SIGTERM") => {
  stopSignal ??= signal;
  abort.abort();
  process.stdin.destroy();
};
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);

// A broken or stalled pipe must not bypass lock cleanup or acknowledge undelivered data.
process.stdout.on("error", () => {});
let diagnosticBlocked = false;
process.stderr.on("error", () => {
  diagnosticBlocked = true;
});
function reportDiagnostic(message: string): void {
  if (diagnosticBlocked) return;
  const high = message.charCodeAt(4095),
    low = message.charCodeAt(4096);
  const end = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 4095 : 4096;
  const bounded = message.length > 4096 ? `${message.slice(0, end)} [diagnostic truncated]` : message;
  try {
    if (!process.stderr.write(`${bounded}\n`)) {
      diagnosticBlocked = true;
      process.stderr.once("drain", () => {
        diagnosticBlocked = false;
      });
    }
  } catch {
    diagnosticBlocked = true;
  }
}

let outputFailed = false;
let installationCommand = false;
let longRunningCommand = false;
async function validateWatchRef(ref: string): Promise<boolean> {
  try {
    await git(parse(process.execPath).root, ["check-ref-format", ref], abort.signal);
    return true;
  } catch (error) {
    abort.signal.throwIfAborted();
    const cause = (error as Error & { cause?: { code?: unknown; stderr?: Buffer | string } }).cause;
    if (cause?.code === 1 && !cause.stderr?.toString()) throw error;
    return false;
  }
}
async function output(value: object | string): Promise<void> {
  const written = Promise.withResolvers<void>();
  const cancel = () => written.reject(abort.signal.reason);
  abort.signal.addEventListener("abort", cancel, { once: true });
  try {
    abort.signal.throwIfAborted();
    process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`, (error) =>
      error ? written.reject(error) : written.resolve(),
    );
    await written.promise;
  } catch (error) {
    outputFailed = true;
    throw error;
  } finally {
    abort.signal.removeEventListener("abort", cancel);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
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
    },
  });
  const [command, agent] = positionals;
  longRunningCommand =
    command === "watch" ||
    (command === "daemon" && agent !== "status") ||
    (command === "status" && values.watch === true);
  if (values["branch-status"] && !(command === "hook" && agent === "codex"))
    throw new Error("--branch-status requires hook codex.");
  if ((values.format !== undefined || values.output !== undefined) && command !== "status")
    throw new Error("--format and --output require status.");
  const days = values["retention-days"].trim() ? Number(values["retention-days"]) : NaN;
  if (values.help || !command) {
    longRunningCommand = false;
    await output(
      "GitRelay (git-relay; worktree-relay and worktree-sync are compatibility aliases)\n\ngit-relay check|watch --session ID [--instance INSTANCE_ID] [--agent NAME] [--cwd PATH] [--ref refs/heads/main]\ngit-relay send --session ID --agent NAME --message TEXT [--file PATH] [--cwd PATH]\ngit-relay sessions [--cwd PATH]\ngit-relay join|leave --session ID [--agent NAME] [--cwd PATH] [--ref REF]\ngit-relay leave --session ID --cwd MISSING_PATH --repository-id STATE_ID\ngit-relay gc [--cwd PATH] [--apply|--dry-run] [--retention-days 7]\ngit-relay daemon [status] [--interval-ms 5000] [--retention-days 7]\ngit-relay hook codex < hook-input.json\n",
    );
    await output(
      "git-relay status [--branch NAME] [--github [--repo [HOST/]OWNER/REPO]] [--watch] [--auto-sync|--no-auto-sync] [--interval-ms 30000] [--session ID] [--cwd PATH]\n",
    );
    await output(
      "  [--format json|markdown] [--output FILE (single Markdown snapshot)]\ngit-relay hook codex [--branch-status] < hook-input.json\n",
    );
    await output(
      "git-relay install|uninstall [--platform codex|opencode] [--skip PLATFORM] [--dry-run] [--allow-unverified]\n",
    );
    await output("git-relay identity-fresh|identity-migrate|identity-recover --cwd PATH --apply\n");
    await output("git-relay check --session ID [--instance INSTANCE_ID] --acknowledge-history-gap --apply\n");
    return;
  }
  if (values["repository-id"] !== undefined && command !== "leave") throw new Error("--repository-id requires leave.");
  if (values.session === "") throw new Error("--session must not be empty.");
  if (values.instance !== undefined && !values.session) throw new Error("--instance requires --session.");
  if (
    command !== "status" &&
    (values.github ||
      values.repo !== undefined ||
      values.branch !== undefined ||
      values.watch ||
      values["auto-sync"] ||
      values["no-auto-sync"])
  )
    throw new Error("--github, --repo, --branch, --watch and sync flags require the status command.");
  if (values["acknowledge-history-gap"] && (command !== "check" || !values.apply))
    throw new Error(
      "--acknowledge-history-gap requires check --apply; it accepts unreadable history without recovering the diff.",
    );
  if (command === "install" || command === "uninstall") {
    installationCommand = true;
    if (positionals.length !== 1) throw new Error("Unexpected positional arguments.");
    if (command === "uninstall" && values["allow-unverified"]) throw new Error("--allow-unverified requires install.");
    const result = await install(
      command,
      values.platform,
      values.skip,
      values["dry-run"],
      values["allow-unverified"],
      abort.signal,
    );
    await output(result);
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (values.platform || values.skip || values["allow-unverified"])
    throw new Error("--platform, --skip and --allow-unverified require install or uninstall.");
  if (command === "identity-fresh" || command === "identity-migrate" || command === "identity-recover") {
    if (positionals.length !== 1 || !values.apply || values["dry-run"])
      throw new Error("Identity changes require --apply; inspect the retained prior state first.");
    const cwd = values.cwd ?? process.cwd();
    if (command === "identity-fresh") await output(await chooseFreshRepository(cwd, abort.signal));
    else if (command === "identity-recover") await output(await recoverRepositoryInitialization(cwd, abort.signal));
    else
      await output(
        await withRepositoryIdentity(cwd, abort.signal, async (repo) => {
          await recordRepositoryIdentity(repo);
          return migrateLegacyState({
            common: repo.common,
            oldDirectory: join(stateDirectory(), "repos", hash(repo.common)),
            newDirectory: repo.directory,
            newId: repo.id,
            identity: repo.identity,
            identitySource: repo.identitySource,
            signal: abort.signal,
          });
        }),
      );
    return;
  }
  if (command === "status") {
    if (positionals.length !== 1) throw new Error("Expected status without positional arguments.");
    if (values.format !== undefined && !["json", "markdown"].includes(values.format))
      throw new Error("--format must be json or markdown.");
    if (values.output !== undefined && (values.format !== "markdown" || values.watch))
      throw new Error("--output requires --format markdown without --watch.");
    if (values.output === "") throw new Error("--output must not be empty.");
    if (values.repo !== undefined && !values.github) throw new Error("--repo requires --github.");
    if (values.repo === "") throw new Error("--repo must not be empty.");
    if (values.branch === "") throw new Error("--branch must not be empty.");
    if (values["auto-sync"] && values["no-auto-sync"])
      throw new Error("Choose --auto-sync or --no-auto-sync, not both.");
    if (values["auto-sync"] && values.repo)
      throw new Error("--auto-sync uses the configured Git upstream; omit --repo to avoid an ambiguous sync source.");
    const network = values.github || values["auto-sync"];
    const interval = Number(values["interval-ms"] ?? (network ? "30000" : "5000"));
    if (!Number.isInteger(interval) || interval < (network ? 5000 : 50) || interval > 3_600_000)
      throw new Error(`interval-ms must be an integer between ${network ? 5000 : 50} and 3600000.`);
    let branchValidated = !values.watch || values.branch === undefined;
    if (values.watch) {
      if (values.session !== undefined)
        validateIdentity({ adapter: values.agent, session: values.session, instance: values.instance });
      if (values.branch !== undefined) branchValidated = await validateWatchRef(`refs/heads/${values.branch}`);
      if (values.repo) validateGitHubRepository(values.repo);
    }
    const cwd = values.cwd ?? process.cwd();
    let branch = values.branch;
    if (branch === undefined && values["auto-sync"]) {
      // --short can return heads/NAME when a tag has the same name.
      const ref = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"], abort.signal, "paths")
        .then(gitRefLine)
        .catch((error: Error & { cause?: { code?: number } }) => {
          if (error.cause?.code === 1) return "";
          throw error;
        });
      if (!ref.startsWith("refs/heads/"))
        throw new Error("HEAD does not point to a local branch; choose --branch NAME.");
      branch = ref.slice("refs/heads/".length);
    }
    let previous: string | undefined;
    do {
      if (!branchValidated) branchValidated = await validateWatchRef(`refs/heads/${values.branch}`);
      try {
        const sync = values["auto-sync"] ? await syncBranch(cwd, branch!, abort.signal) : undefined;
        const snapshot = {
          ...(await branchStatus({ cwd, branch, github: values.github, repo: values.repo, signal: abort.signal })),
          ...(sync ? { sync } : {}),
        };
        const encoded = JSON.stringify(snapshot);
        if (encoded !== previous) {
          const rendered = values.format === "markdown" ? formatBranchStatus(snapshot) : snapshot;
          const tooLargeToBroadcast =
            previous !== undefined && !!values.session && !messagePayloadWithinLimit(encoded, []);
          const broadcastAttempted = previous !== undefined && !!values.session && !tooLargeToBroadcast;
          let broadcastFailed = false,
            broadcastFailure: unknown;
          const reportBroadcast = (message: string) => reportDiagnostic(`git-relay: ${message}`);
          if (broadcastAttempted) {
            try {
              await sendMessage({
                cwd,
                adapter: values.agent,
                session: values.session!,
                instance: values.instance,
                ref: values.ref,
                text: encoded,
                signal: abort.signal,
              });
            } catch (error) {
              if (abort.signal.aborted) {
                reportBroadcast("status broadcast was interrupted and may have completed; inspect before retrying.");
                abort.signal.throwIfAborted();
              }
              broadcastFailed = true;
              broadcastFailure = error;
            }
          }
          try {
            if (values.output) await writeFile(values.output, rendered as string, "utf8");
            await output(rendered);
          } catch (error) {
            if (tooLargeToBroadcast)
              reportBroadcast(
                "status snapshot exceeds the 64 KiB message limit and was not broadcast; local output failed.",
              );
            else if (broadcastAttempted)
              reportBroadcast("status output failed; the broadcast may have completed. Inspect before retrying.");
            throw error;
          }
          previous = encoded;
          if (tooLargeToBroadcast)
            reportBroadcast(
              "status snapshot exceeds the 64 KiB message limit and was not broadcast; status was printed locally.",
            );
          else if (broadcastFailed) {
            const detail = broadcastFailure instanceof Error ? broadcastFailure.message : String(broadcastFailure);
            reportBroadcast(
              `status broadcast failed; it may have completed and this snapshot will not be retried. Inspect before retrying: ${detail.length > 4096 ? `${detail.slice(0, 4096)} [diagnostic truncated]` : detail}`,
            );
          }
        }
        if (!values.watch && snapshot.github && "error" in snapshot.github) process.exitCode = 1;
        if (!values.watch && (sync?.state === "blocked" || sync?.state === "error")) process.exitCode = 1;
      } catch (error) {
        if (!values.watch || abort.signal.aborted || outputFailed) throw error;
        reportDiagnostic(error instanceof Error ? error.message : String(error));
      }
      if (!values.watch || abort.signal.aborted) break;
      await delay(interval, undefined, { signal: abort.signal }).catch(() => {});
    } while (!abort.signal.aborted);
    return;
  }
  if (command === "hook") {
    if (positionals.length !== 2 || agent !== "codex") throw new Error("Choose hook codex.");
    let data = "";
    let size = 0;
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk);
      if (size <= 16 * 1024 * 1024) data += chunk;
      else data = "";
    }
    abort.signal.throwIfAborted();
    if (size > 16 * 1024 * 1024) {
      reportDiagnostic(
        "git-relay: Hook input exceeds 16 MiB; skipped without acknowledging events. The next hook can retry.",
      );
      await output({});
      return;
    }
    const input = JSON.parse(data);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Hook input must be a JSON object.");
    await runHook(input, values.ref, output, abort.signal, values["branch-status"]);
    return;
  }
  if (command === "daemon" && agent === "status" && positionals.length === 2) {
    await output(await daemonStatus());
    return;
  }
  if (
    !["check", "watch", "send", "sessions", "join", "leave", "gc", "daemon"].includes(command) ||
    positionals.length !== 1
  )
    throw new Error("Expected status, check, watch, send, sessions, join, leave, gc, daemon or hook.");
  const cwd = () => values.cwd ?? process.cwd();
  if (command === "sessions") {
    await output({ sessions: await listSessions(cwd(), abort.signal) });
    return;
  }
  if (command === "gc") {
    if (values.apply && values["dry-run"]) throw new Error("Choose --apply or --dry-run, not both.");
    await output(
      await collectGarbage(cwd(), { apply: values.apply === true, retentionDays: days, signal: abort.signal }),
    );
    return;
  }
  if (command !== "daemon" && !values.session)
    throw new Error("--session ID is required for per-session delivery and deduplication.");
  let refValidated = command !== "watch";
  if (command === "watch") {
    validateIdentity({ adapter: values.agent, session: values.session!, instance: values.instance });
    if (!values.ref.startsWith("refs/heads/") && !values.ref.startsWith("refs/remotes/"))
      throw new Error("The monitored target must be a full branch ref under refs/heads/ or refs/remotes/.");
    refValidated = await validateWatchRef(values.ref);
  }
  if (command === "join" || command === "leave") {
    const options = {
      cwd: cwd(),
      ref: values.ref,
      adapter: values.agent,
      session: values.session!,
      instance: values.instance,
      signal: abort.signal,
      repositoryId: values["repository-id"],
    };
    if (command === "leave") await sessionActivation(options, false);
    const session = command === "join" ? await joinSession(options) : await leaveSession(options);
    if (command === "join") await sessionActivation(options, true);
    await output({ session, left: command === "leave" && session !== undefined });
    return;
  }
  if (command === "send") {
    if (!values.message) throw new Error("--message TEXT is required.");
    const event = await sendMessage({
      cwd: cwd(),
      ref: values.ref,
      adapter: values.agent,
      session: values.session!,
      instance: values.instance,
      text: values.message,
      files: values.file,
      signal: abort.signal,
    });
    await output({ eventId: event.id, recipients: event.recipients.length });
    return;
  }
  const check = () =>
    consumeMailbox({
      cwd: cwd(),
      ref: values.ref,
      session: values.session!,
      instance: values.instance,
      adapter: values.agent,
      signal: abort.signal,
      deliverIndividually: true,
      acknowledgeUnavailableHistory: values["acknowledge-history-gap"],
      async deliver(notifications) {
        for (const notification of notifications) {
          const data = notification.kind === "upstream" ? notification.change : notification.event;
          await output({
            type: notification.kind === "upstream" ? "worktree.upstream-change" : "worktree.agent-message",
            ...data,
            eventId: notification.event.id,
            message: formatNotifications([notification]),
          });
        }
      },
    });
  if (command === "daemon") {
    await runDaemon({
      signal: abort.signal,
      intervalMs: Number(values["interval-ms"] ?? "5000"),
      retentionDays: days,
      onEvent: output,
    });
    return;
  }
  if (command === "check") {
    await check();
    return;
  }
  while (!abort.signal.aborted) {
    if (!refValidated) refValidated = await validateWatchRef(values.ref);
    try {
      await check();
    } catch (error) {
      if (abort.signal.aborted || outputFailed) throw error;
      reportDiagnostic(error instanceof Error ? error.message : String(error));
    }
    if (abort.signal.aborted) break;
    await delay(5000, undefined, { signal: abort.signal }).catch(() => {});
  }
}

main()
  .catch((error) => {
    if (
      abort.signal.aborted &&
      (error === abort.signal.reason || error?.name === "AbortError" || error?.code === "ERR_STREAM_PREMATURE_CLOSE")
    ) {
      if (installationCommand) {
        try {
          writeSync(
            process.stderr.fd,
            "git-relay: cancelled; the operation may have completed. Inspect with git-relay uninstall --dry-run.\n",
          );
        } catch {
          /* A closed stderr must not prevent cleanup. */
        }
        process.exitCode = 130;
      }
      return;
    }
    reportDiagnostic(`git-relay: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    // Node cannot cancel OS pipe writes; all awaited operation/lock cleanup has now completed.
    if (abort.signal.aborted) {
      if (!installationCommand && !longRunningCommand) {
        try {
          writeSync(
            process.stderr.fd,
            "git-relay: interrupted; the operation may have completed. Inspect the result before retrying.\n",
          );
        } catch {
          /* A closed stderr must not prevent cleanup. */
        }
        process.exitCode ??= stopSignal === "SIGTERM" ? 143 : 130;
      }
      process.exit(process.exitCode ?? 0);
    }
    if (outputFailed || process.stderr.writableLength > 0) {
      // Give writable stderr a bounded chance to flush without hanging on a full pipe.
      const flush = new Promise<void>((resolve) => {
        try {
          process.stderr.write("", () => resolve());
        } catch {
          resolve();
        }
      });
      await Promise.race([flush, delay(250)]);
      process.exit(process.exitCode ?? (outputFailed ? 1 : 0));
    }
  });
