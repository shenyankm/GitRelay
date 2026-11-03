import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { branchStatus, validateGitHubRepository } from "../core/branch-status.ts";
import { git, gitRefLine } from "../core/git.ts";
import { formatBranchStatus } from "../core/status-format.ts";
import { messagePayloadWithinLimit, sendMessage, validateIdentity } from "../core/mailbox.ts";
import { validateWatchRef, type CliValues } from "./args.ts";

export async function runStatus(
  values: CliValues,
  io: {
    signal: AbortSignal;
    output(value: object | string): Promise<void>;
    reportDiagnostic(message: string): void;
    outputFailed(): boolean;
  },
  statusRefValidated = true,
): Promise<void> {
  if (values.format !== undefined && !["json", "markdown"].includes(values.format))
    throw new Error("--format must be json or markdown.");
  if (values.output !== undefined && (values.format !== "markdown" || values.watch))
    throw new Error("--output requires --format markdown without --watch.");
  if (values.output === "") throw new Error("--output must not be empty.");
  if (values.repo !== undefined && !values.github) throw new Error("--repo requires --github.");
  if (values.repo === "") throw new Error("--repo must not be empty.");
  if (values.branch === "") throw new Error("--branch must not be empty.");
  if (values["auto-sync"] && values["no-auto-sync"]) throw new Error("Choose --auto-sync or --no-auto-sync, not both.");
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
    if (values.branch !== undefined) branchValidated = await validateWatchRef(`refs/heads/${values.branch}`, io.signal);
    if (values.repo) validateGitHubRepository(values.repo);
  }
  const cwd = values.cwd ?? process.cwd();
  let branch = values.branch;
  if (branch === undefined && values["auto-sync"]) {
    // --short can return heads/NAME when a tag has the same name.
    const ref = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"], io.signal, "paths")
      .then(gitRefLine)
      .catch((error: Error & { cause?: { code?: number } }) => {
        if (error.cause?.code === 1) return "";
        throw error;
      });
    if (!ref.startsWith("refs/heads/")) throw new Error("HEAD does not point to a local branch; choose --branch NAME.");
    branch = ref.slice("refs/heads/".length);
  }
  let previous: string | undefined;
  do {
    if (!statusRefValidated) {
      statusRefValidated = await validateWatchRef(values.ref, io.signal);
      if (!statusRefValidated) {
        io.reportDiagnostic("git-relay: Could not validate the monitored ref; retrying.");
        await delay(interval, undefined, { signal: io.signal }).catch(() => {});
        continue;
      }
    }
    if (!branchValidated) branchValidated = await validateWatchRef(`refs/heads/${values.branch}`, io.signal);
    try {
      const sync = values["auto-sync"]
        ? await (await import("../core/branch-sync.ts")).syncBranch(cwd, branch!, io.signal)
        : undefined;
      const snapshot = {
        ...(await branchStatus({ cwd, branch, github: values.github, repo: values.repo, signal: io.signal })),
        ...(sync ? { sync } : {}),
      };
      const encoded = JSON.stringify(snapshot).replace(
        /[\x7f-\x9f]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      if (encoded !== previous) {
        const rendered = values.format === "markdown" ? formatBranchStatus(snapshot) : `${encoded}\n`;
        const tooLargeToBroadcast =
          previous !== undefined && !!values.session && !messagePayloadWithinLimit(encoded, []);
        const broadcastAttempted = previous !== undefined && !!values.session && !tooLargeToBroadcast;
        let broadcastFailed = false,
          broadcastFailure: unknown;
        const reportBroadcast = (message: string) => io.reportDiagnostic(`git-relay: ${message}`);
        if (broadcastAttempted) {
          try {
            await sendMessage({
              cwd,
              adapter: values.agent,
              session: values.session!,
              instance: values.instance,
              ref: values.ref,
              text: encoded,
              signal: io.signal,
            });
          } catch (error) {
            if (io.signal.aborted) {
              reportBroadcast("status broadcast was interrupted and may have completed; inspect before retrying.");
              io.signal.throwIfAborted();
            }
            broadcastFailed = true;
            broadcastFailure = error;
          }
        }
        try {
          if (values.output) await writeFile(values.output, rendered as string, "utf8");
          await io.output(rendered);
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
      if (!values.watch || io.signal.aborted || io.outputFailed()) throw error;
      io.reportDiagnostic(error instanceof Error ? error.message : String(error));
    }
    if (!values.watch || io.signal.aborted) break;
    await delay(interval, undefined, { signal: io.signal }).catch(() => {});
  } while (!io.signal.aborted);
  return;
}
