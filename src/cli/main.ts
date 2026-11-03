#!/usr/bin/env node
import { parseArguments, validateCommandOptions, validateWatchRef } from "./args.ts";
import { setTimeout as delay } from "node:timers/promises";
import { consumeMailbox } from "../core/consumer.ts";
import { formatNotifications, listSessions, sendMessage, validateIdentity } from "../core/mailbox.ts";
import { runHook } from "../adapters/hooks.ts";
import { enableSession, disableSession } from "../core/session-lifecycle.ts";
import { daemonStatus } from "../core/daemon-state.ts";
import { ensureAutomaticDaemon, runAutomaticDaemon } from "../core/automatic-daemon.ts";
import { git } from "../core/git.ts";
import { writeSync } from "node:fs";
import { hash, stateDirectory } from "../core/store.ts";
import {
  chooseFreshRepository,
  recordRepositoryIdentity,
  recoverRepositoryInitialization,
  withRepositoryIdentity,
} from "../core/repository.ts";
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
  const bounded = (message.length > 4096 ? `${message.slice(0, end)} [diagnostic truncated]` : message).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    " ",
  );
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
let hookDelivered = false;
let installationCommand = false;
let longRunningCommand = false;
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
  const { values, positionals, tokens } = parseArguments();
  const [command, agent] = positionals;
  if (values.automatic && (command !== "daemon" || agent !== undefined))
    throw new Error("--automatic requires daemon.");
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
    await output("git-relay install|uninstall [--platform codex] [--skip PLATFORM] [--dry-run] [--allow-unverified]\n");
    await output("git-relay identity-fresh|identity-migrate|identity-recover --cwd PATH --apply\n");
    await output("git-relay check --session ID [--instance INSTANCE_ID] --acknowledge-history-gap --apply\n");
    return;
  }
  if (values.cwd === "") throw new Error("--cwd must not be empty.");
  let statusRefValidated = true;
  if (
    ["check", "watch", "send", "join", "leave"].includes(command) ||
    (command === "status" && values.watch && values.session)
  ) {
    if (!values.ref.startsWith("refs/heads/") && !values.ref.startsWith("refs/remotes/"))
      throw new Error("The monitored target must be a full branch ref under refs/heads/ or refs/remotes/.");
    if (command === "status") statusRefValidated = await validateWatchRef(values.ref, abort.signal);
    else if (command !== "watch")
      await git(parse(process.execPath).root, ["check-ref-format", values.ref], abort.signal);
  }
  if (values["repository-id"] !== undefined && command !== "leave") throw new Error("--repository-id requires leave.");
  if (values["dry-run"] && !["install", "uninstall", "gc"].includes(command))
    throw new Error("--dry-run requires install, uninstall or gc.");
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
  if ((values.platform || values.skip || values["allow-unverified"]) && !["install", "uninstall"].includes(command))
    throw new Error("--platform, --skip and --allow-unverified require install or uninstall.");
  validateCommandOptions(command === "daemon" && agent === "status" ? "daemon status" : command, tokens);
  if (command === "install" || command === "uninstall") {
    installationCommand = true;
    if (positionals.length !== 1) throw new Error("Unexpected positional arguments.");
    if (command === "uninstall" && values["allow-unverified"]) throw new Error("--allow-unverified requires install.");
    const { install } = await import("./install.ts");
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
  if (command === "identity-fresh" || command === "identity-migrate" || command === "identity-recover") {
    if (positionals.length !== 1 || !values.apply || values["dry-run"])
      throw new Error("Identity changes require --apply; inspect the retained prior state first.");
    const cwd = values.cwd ?? process.cwd();
    if (command === "identity-fresh") await output(await chooseFreshRepository(cwd, abort.signal));
    else if (command === "identity-recover") await output(await recoverRepositoryInitialization(cwd, abort.signal));
    else
      await output(
        await withRepositoryIdentity(cwd, abort.signal, async (repo) => {
          const { migrateLegacyState } = await import("../core/identity-migration.ts");
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
    const { runStatus } = await import("./status.ts");
    await runStatus(
      values,
      { signal: abort.signal, output, reportDiagnostic, outputFailed: () => outputFailed },
      statusRefValidated,
    );
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
    if (["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].includes(input.hook_event_name) && !input.agent_id)
      await ensureAutomaticDaemon("codex", abort.signal).catch((error) =>
        reportDiagnostic(`git-relay: ${String(error)}`),
      );
    const result = await runHook(input, values.ref, output, abort.signal, values["branch-status"]);
    hookDelivered = result?.delivered === true;
    if (result?.diagnostic) reportDiagnostic(`git-relay: ${result.diagnostic}`);
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
    const { collectGarbage } = await import("../core/cleanup.ts");
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
    refValidated = await validateWatchRef(values.ref, abort.signal);
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
    const session = command === "join" ? await enableSession(options) : await disableSession(options);
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
    const { runDaemon } = await import("../core/daemon.ts");
    await (values.automatic ? runAutomaticDaemon : runDaemon)({
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
    if (!refValidated) refValidated = await validateWatchRef(values.ref, abort.signal);
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
        process.exitCode ??= hookDelivered ? 0 : stopSignal === "SIGTERM" ? 143 : 130;
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
