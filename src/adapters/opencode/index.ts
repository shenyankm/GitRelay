import type { Plugin } from "@opencode/plugin";
import { setTimeout as delay } from "node:timers/promises";
import { consumeMailbox } from "../../core/consumer.ts";
import { watchRoot } from "../../core/changes.ts";
import { formatNotifications } from "../../core/mailbox.ts";
import { hash } from "../../core/store.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { requestedActivation, sessionActivation } from "../../core/activation.ts";
import { joinSession, leaveSessionIfRepository, preflightLeaveSession } from "../../core/sessions.ts";

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"];

export default {
  id: "git-relay",
  async setup(ctx) {
    let root: string | undefined;
    let rootFailure: string | undefined;
    const warnRoot = (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      if (rootFailure === reason) return;
      rootFailure = reason;
      try {
        console.warn(`[GitRelay] Initialization failed: ${reason}. Will retry after a session prompt.`);
      } catch {}
    };
    const sessions = new Map<
      SessionID,
      { abort: AbortController; instance?: string; rejoin?: boolean; active?: Promise<void> }
    >();
    const optIns = new Set<SessionID>();
    const optOuts = new Map<
      SessionID,
      { instance?: string; known: boolean; trusted: boolean; disabled: boolean; abort: AbortController }
    >();
    const draining = new Set<Promise<void>>();
    const lookups = new Map<SessionID, Set<{ cancelled: boolean; abort: AbortController }>>();
    const deletionChecks = new Map<SessionID, { abort: AbortController; repeat: boolean }>();
    const abort = new AbortController();
    let eventAbort: AbortController | undefined;
    let rootProbe: Promise<string | undefined> | undefined;
    let rootRetryAt = 0,
      rootDelay = 5000;
    const probeRoot = (): Promise<string | undefined> => {
      if (rootProbe) return rootProbe;
      if (performance.now() < rootRetryAt) return Promise.resolve(undefined);
      rootProbe = (async () => {
        try {
          const current = await watchRoot(ctx.location.directory, abort.signal);
          if (root !== undefined && root !== current)
            throw new Error("Git worktree root changed; reload the plugin before resuming");
          root = current;
          rootFailure = undefined;
          rootDelay = 5000;
          rootRetryAt = 0;
          return current;
        } catch (error) {
          if (!abort.signal.aborted) {
            warnRoot(error);
            rootRetryAt = performance.now() + rootDelay;
            rootDelay = Math.min(rootDelay * 2, 60_000);
          }
          return undefined;
        } finally {
          rootProbe = undefined;
        }
      })();
      return rootProbe;
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    const ref = process.env.WORKTREE_MAIN_REF ?? "refs/heads/main";
    const deferred = new Error("Establish baseline without recursively prompting");
    const warn = (error: unknown) => {
      try {
        console.warn(`[GitRelay] ${error instanceof Error ? error.message : String(error)}`);
      } catch {}
    };
    const belongs = (session: Awaited<ReturnType<typeof ctx.session.get>>) =>
      !session.parentID && session.location.directory === ctx.location.directory;
    const instanceOf = (session: Awaited<ReturnType<typeof ctx.session.get>>) => {
      if (!Number.isFinite(session.time?.created) || session.time.created < 0)
        throw new Error(
          "OpenCode session creation time is missing or invalid; subscription preserved without delivery",
        );
      return hash([resolve(process.env.XDG_DATA_HOME || homedir()), session.time.created]);
    };

    function getSession(
      id: SessionID,
      signal: AbortSignal,
      underlying?: (pending: ReturnType<typeof ctx.session.get>) => void,
    ): ReturnType<typeof ctx.session.get> {
      signal.throwIfAborted();
      const pending = ctx.session.get({ sessionID: id }, { signal });
      underlying?.(pending);
      return new Promise((resolve, reject) => {
        const aborted = () => {
          signal.removeEventListener("abort", aborted);
          reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        pending.then(
          (session) => {
            signal.removeEventListener("abort", aborted);
            resolve(session);
          },
          (error) => {
            signal.removeEventListener("abort", aborted);
            reject(error);
          },
        );
        if (signal.aborted) aborted();
      });
    }

    function scan(id: SessionID, initial = false): Promise<void> {
      const state = sessions.get(id);
      if (!state || state.active || abort.signal.aborted) return state?.active ?? Promise.resolve();
      state.active = (async () => {
        const options = {
          cwd: ctx.location.directory,
          ref,
          adapter: "opencode",
          session: id,
          instance: state.instance,
          signal: state.abort.signal,
        };
        if (!(await sessionActivation(options))) {
          state.abort.abort();
          sessions.delete(id);
          maintainTimer();
          return;
        }
        const currentRoot = await probeRoot();
        state.abort.signal.throwIfAborted();
        if (!currentRoot) return;
        const native = await getSession(id, state.abort.signal);
        if (!belongs(native)) return;
        if (instanceOf(native) !== state.instance) {
          state.abort.abort();
          sessions.delete(id);
          await enroll(id);
          return;
        }
        if (state.rejoin) {
          await joinSession({
            cwd: ctx.location.directory,
            ref,
            adapter: "opencode",
            session: id,
            instance: state.instance,
            signal: state.abort.signal,
          });
          state.rejoin = false;
        }
        await consumeMailbox({
          cwd: ctx.location.directory,
          ref,
          adapter: "opencode",
          session: id,
          instance: state.instance,
          signal: state.abort.signal,
          deliverIndividually: true,
          async deliver(notifications, location) {
            if (initial) throw deferred;
            // V2 durably admits queued input; the host handles busy sessions and idle wake-up.
            for (const notification of notifications) {
              state.abort.signal.throwIfAborted();
              if (!(await sessionActivation(options))) return false;
              const target = await getSession(id, state.abort.signal);
              if (!belongs(target) || instanceOf(target) !== state.instance)
                throw new Error("OpenCode session changed before delivery; unread event preserved");
              await ctx.session.prompt(
                {
                  sessionID: id,
                  id: `msg_${hash(["git-relay", location!.repository.id, location!.sessionKey, notification.event.id])}`,
                  text: formatNotifications([notification]),
                  delivery: "queue",
                  metadata: { source: "git-relay" },
                },
                { signal: state.abort.signal },
              );
              const accepted = await getSession(id, state.abort.signal);
              if (!belongs(accepted) || instanceOf(accepted) !== state.instance)
                throw new Error("OpenCode session changed during delivery; outcome unknown and event preserved");
            }
          },
        });
      })()
        .catch((error) => {
          if (error !== deferred && !state.abort.signal.aborted) warn(error);
        })
        .finally(() => {
          state.active = undefined;
        });
      return state.active;
    }

    const retries = new Map<SessionID, number>();
    let lookupSequence = 0;
    const retrying = new Set<SessionID>();
    function maintainTimer() {
      if (!sessions.size && !retries.size && !optIns.size && !optOuts.size) eventAbort?.abort();
      if ((sessions.size || retries.size) && !timer && !abort.signal.aborted) {
        timer = setInterval(() => {
          for (const id of sessions.keys()) void scan(id);
          let started = 0;
          for (const [id, sequence] of retries) {
            if (retrying.has(id)) continue;
            if (retrying.size >= 128) break;
            retries.delete(id);
            retries.set(id, sequence);
            retrying.add(id);
            void enroll(id, true);
            if (++started === 8) break;
          }
        }, 5000);
        timer.unref?.();
      } else if (!sessions.size && !retries.size && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
    async function enroll(id: SessionID, retry = false) {
      const token = { cancelled: false, abort: new AbortController() };
      const sequence = ++lookupSequence;
      let pending: Set<typeof token> | undefined;
      let underlyingStarted = false;
      try {
        if (!sessions.has(id)) {
          pending = lookups.get(id) ?? new Set();
          lookups.set(id, pending);
          pending.add(token);
          const session = await getSession(
            id,
            AbortSignal.any([abort.signal, token.abort.signal]),
            retry
              ? (operation) => {
                  underlyingStarted = true;
                  void operation.then(
                    () => retrying.delete(id),
                    () => retrying.delete(id),
                  );
                }
              : undefined,
          );
          if (abort.signal.aborted || token.cancelled) return;
          const inScope = belongs(session);
          if (inScope || (retries.get(id) ?? 0) <= sequence) retries.delete(id);
          if (!inScope) {
            if ((retries.get(id) ?? 0) <= sequence) optIns.delete(id);
            return;
          }
          const instance = instanceOf(session);
          const options = {
            cwd: ctx.location.directory,
            ref,
            adapter: "opencode",
            session: id,
            instance,
            signal: AbortSignal.any([abort.signal, token.abort.signal]),
          };
          let enabled = await sessionActivation(options);
          if (optIns.has(id) && !enabled) {
            enabled = await sessionActivation(options, true);
          }
          if (!enabled || abort.signal.aborted || token.cancelled) return;
          watchEvents();
          if (!sessions.has(id)) {
            sessions.set(id, { abort: new AbortController(), instance, rejoin: optIns.has(id) });
            optIns.delete(id);
            await scan(id, true);
          }
        }
      } catch (error) {
        if (!abort.signal.aborted && !token.cancelled && optIns.has(id)) {
          if (!retry) warn(error);
          if (!sessions.has(id)) {
            if (retries.has(id) || retries.size < 128) retries.set(id, Math.max(retries.get(id) ?? 0, sequence));
            else warn(new Error("Too many pending OpenCode session lookups; prompt again to retry."));
          }
        }
      } finally {
        if (retry && !underlyingStarted) retrying.delete(id);
        if (pending) {
          pending.delete(token);
          if (!pending.size && lookups.get(id) === pending) lookups.delete(id);
        }
        maintainTimer();
      }
    }
    const registration = await ctx.session.hook("prompt", async (event) => {
      if (abort.signal.aborted || event.metadata?.source === "git-relay" || event.metadata?.source === "worktree-relay")
        return;
      const request = requestedActivation(event.prompt?.text);
      const pendingDeletion = deletionChecks.get(event.sessionID);
      pendingDeletion?.abort.abort();
      deletionChecks.delete(event.sessionID);
      if (request === undefined && pendingDeletion && eventAbort && !eventAbort.signal.aborted)
        verifyDeletion(event.sessionID, AbortSignal.any([abort.signal, eventAbort.signal]));
      if (request === false) {
        if (optOuts.size >= 128 && !optOuts.has(event.sessionID)) {
          warn(new Error("Too many pending opt-outs; retry after another session is resolved."));
          return;
        }
        optIns.delete(event.sessionID);
        retries.delete(event.sessionID);
        for (const token of lookups.get(event.sessionID) ?? []) {
          token.cancelled = true;
          token.abort.abort();
        }
        const state = sessions.get(event.sessionID);
        const previous = optOuts.get(event.sessionID);
        previous?.abort.abort();
        const attempt = {
          instance: state ? state.instance : previous?.instance,
          known: Boolean(state || previous?.known),
          trusted: Boolean(state || previous?.trusted),
          disabled: state ? false : (previous?.disabled ?? false),
          abort: new AbortController(),
        };
        optOuts.set(event.sessionID, attempt);
        watchEvents();
        const signal = AbortSignal.any([abort.signal, attempt.abort.signal]);
        const current = () => !abort.signal.aborted && optOuts.get(event.sessionID) === attempt;
        state?.abort.abort();
        sessions.delete(event.sessionID);
        maintainTimer();
        try {
          let oldClosed = false;
          const oldOptions = {
            cwd: ctx.location.directory,
            ref,
            adapter: "opencode",
            session: event.sessionID,
            instance: attempt.instance,
            signal,
          };
          if (state) {
            if (state.active) {
              const active = state.active;
              draining.add(active);
              void active.finally(() => draining.delete(active));
            }
            const checked = await preflightLeaveSession(oldOptions);
            if (!current()) return;
            await sessionActivation(oldOptions, false);
            if (!current()) return;
            attempt.disabled = true;
            await state.active;
            if (!current()) return;
            await leaveSessionIfRepository(oldOptions, checked);
            if (!current()) return;
            oldClosed = true;
          } else if (attempt.known && attempt.trusted) {
            const checked = await preflightLeaveSession(oldOptions);
            if (!current()) return;
            if (!attempt.disabled) {
              await sessionActivation(oldOptions, false);
              if (!current()) return;
              attempt.disabled = true;
            }
            await leaveSessionIfRepository(oldOptions, checked);
            if (!current()) return;
            oldClosed = true;
          }
          const target = await getSession(event.sessionID, signal);
          if (!current()) return;
          if (!belongs(target)) {
            optOuts.delete(event.sessionID);
            return;
          }
          const options = {
            cwd: ctx.location.directory,
            ref,
            adapter: "opencode",
            session: event.sessionID,
            instance: instanceOf(target),
            signal,
          };
          if (attempt.known && attempt.instance !== options.instance) {
            attempt.instance = options.instance;
            attempt.trusted = false;
            attempt.disabled = false;
            warn(new Error("OpenCode session changed during opt-out; retry for the current session."));
            return;
          }
          if (oldClosed) {
            optOuts.delete(event.sessionID);
            return;
          }
          const checked = await preflightLeaveSession(options);
          if (!current()) return;
          if (!attempt.known && checked.repositoryId) {
            attempt.known = true;
            attempt.instance = options.instance;
            attempt.trusted = false;
            warn(
              new Error("OpenCode session identity could not be verified for opt-out; retry for the current session."),
            );
            return;
          }
          await sessionActivation(options, false);
          if (!current()) return;
          attempt.trusted = true;
          attempt.disabled = true;
          await leaveSessionIfRepository(options, checked);
          if (current()) optOuts.delete(event.sessionID);
        } catch (error) {
          if (current()) warn(error);
        } finally {
          maintainTimer();
        }
        return;
      }
      if (request === true) {
        optOuts.get(event.sessionID)?.abort.abort();
        optOuts.delete(event.sessionID);
        if (optIns.size >= 128 && !optIns.has(event.sessionID)) {
          maintainTimer();
          warn(new Error("Too many pending opt-ins; retry after a session is enrolled."));
          return;
        }
        optIns.add(event.sessionID);
        const state = sessions.get(event.sessionID);
        if (state) {
          state.abort.abort();
          await state.active;
          if (sessions.get(event.sessionID) === state) sessions.delete(event.sessionID);
        }
        if (!optIns.has(event.sessionID)) return;
        watchEvents();
      }
      await enroll(event.sessionID);
    });
    function verifyDeletion(id: SessionID, signal: AbortSignal) {
      const state = sessions.get(id);
      const attempt = optOuts.get(id);
      const pending = lookups.get(id);
      const tokens = [...(pending ?? [])];
      const retry = retries.get(id);
      if (!state && !attempt && !pending && retry === undefined && !optIns.has(id)) return;
      const existing = deletionChecks.get(id);
      if (existing) {
        existing.repeat = true;
        return;
      }
      if (deletionChecks.size >= 128) {
        warn(new Error("Too many pending OpenCode deletion checks; session state preserved."));
        return;
      }
      const check = { abort: new AbortController(), repeat: false };
      deletionChecks.set(id, check);
      const checkSignal = AbortSignal.any([signal, check.abort.signal]);
      const discard = () => {
        if (deletionChecks.get(id) === check) deletionChecks.delete(id);
      };
      checkSignal.addEventListener("abort", discard, { once: true });
      void (async () => {
        try {
          const native = await getSession(id, checkSignal);
          if (!checkSignal.aborted && !belongs(native) && state && sessions.get(id) === state) {
            state.abort.abort();
            sessions.delete(id);
            if (state.active) {
              const active = state.active;
              draining.add(active);
              void active.finally(() => draining.delete(active));
            }
            maintainTimer();
          }
          // A current host session can be a newer instance of the deleted ID.
          return;
        } catch (error) {
          if (checkSignal.aborted) return;
          if (!(
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            error._tag === "SessionNotFoundError"
          )) {
            warn(new Error(`OpenCode deletion could not be verified; session state preserved: ${String(error)}`));
            return;
          }
          if (
            deletionChecks.get(id) !== check ||
            sessions.get(id) !== state ||
            optOuts.get(id) !== attempt ||
            lookups.get(id) !== pending ||
            (pending && (pending.size !== tokens.length || tokens.some((token) => !pending.has(token)))) ||
            retries.get(id) !== retry
          ) {
            check.repeat = true;
            return;
          }
          optIns.delete(id);
          attempt?.abort.abort();
          optOuts.delete(id);
          retries.delete(id);
          for (const token of tokens) {
            token.cancelled = true;
            token.abort.abort();
          }
          if (state) {
            state.abort.abort();
            sessions.delete(id);
            if (state.active) {
              const active = state.active;
              draining.add(active);
              void active.finally(() => draining.delete(active));
            }
          }
          maintainTimer();
        } finally {
          checkSignal.removeEventListener("abort", discard);
          if (deletionChecks.get(id) === check) {
            deletionChecks.delete(id);
            if (check.repeat && !signal.aborted) verifyDeletion(id, signal);
          }
        }
      })();
    }
    function watchEvents() {
      if (eventAbort && !eventAbort.signal.aborted) return;
      eventAbort = new AbortController();
      const signal = AbortSignal.any([abort.signal, eventAbort.signal]);
      const task = (async () => {
        let backoff = 1000;
        while (!signal.aborted) {
          try {
            for await (const event of ctx.event.subscribe({ signal })) {
              if (signal.aborted) break;
              backoff = 1000;
              if (event.type !== "session.deleted") continue;
              verifyDeletion(event.data.sessionID, signal);
            }
          } catch (error) {
            if (!signal.aborted) warn(error);
          }
          if (!signal.aborted) {
            await delay(backoff, undefined, { signal }).catch(() => {});
            backoff = Math.min(backoff * 2, 60_000);
          }
        }
      })();
      draining.add(task);
      void task.finally(() => draining.delete(task));
    }

    return async () => {
      abort.abort();
      if (timer) clearInterval(timer);
      retries.clear();
      optIns.clear();
      for (const attempt of optOuts.values()) attempt.abort.abort();
      optOuts.clear();
      for (const state of sessions.values()) state.abort.abort();
      const results = await Promise.allSettled([
        Promise.resolve().then(() => registration.dispose()),
        ...[...sessions.values()].map((state) => state.active),
        ...draining,
      ]);
      sessions.clear();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
  },
} satisfies Plugin.Plugin;
