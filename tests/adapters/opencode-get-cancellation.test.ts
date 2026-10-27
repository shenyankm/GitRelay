import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/adapters/opencode/index.ts";
import { fixture } from "../helpers.ts";

const deadline = <T>(promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown timed out")), 1000)),
  ]);

for (const phase of ["registration", "scan"] as const) {
  for (const result of ["resolve", "reject"] as const) {
    test(`OpenCode closes while ${phase} lookup is pending and ignores late ${result}`, async (t) => {
      const f = await fixture(t);
      const held = Promise.withResolvers<{ location: { directory: string } }>();
      const started = Promise.withResolvers<void>();
      let hook!: (event: { sessionID: string; prompt?: { text: string } }) => Promise<void>;
      let calls = 0;
      t.mock.method(console, "warn", () => {});
      const session = { location: { directory: f.b }, time: { created: 1 } };
      const ctx = {
        location: { directory: f.b },
        session: {
          async hook(_type: string, fn: typeof hook) {
            hook = fn;
            return { async dispose() {} };
          },
          get() {
            calls++;
            if (phase === "scan" && calls === 1) return Promise.resolve(session);
            started.resolve();
            return held.promise;
          },
          async prompt() {
            assert.fail("a stale lookup must not prompt");
          },
        },
        event: {
          async *subscribe({ signal }: { signal: AbortSignal }) {
            if (!signal.aborted)
              await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          },
        },
      };
      const close = await plugin.setup(ctx as unknown as Plugin.Context);
      const lookup = hook({ sessionID: "held", prompt: { text: "Enable GitRelay" } });
      await deadline(started.promise);
      await deadline(close());
      await deadline(lookup);
      if (result === "resolve") held.resolve(session);
      else held.reject(new Error("late host error"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls, phase === "scan" ? 2 : 1);
    });
  }
}

test("OpenCode deletion releases concurrent pending lookups and allows a new lookup", async (t) => {
  const f = await fixture(t);
  const ready = [
    Promise.withResolvers<{ location: { directory: string } }>(),
    Promise.withResolvers<{ location: { directory: string } }>(),
  ];
  const deleted = Promise.withResolvers<void>();
  const processed = Promise.withResolvers<void>();
  let hook!: (event: { sessionID: string; prompt?: { text: string } }) => Promise<void>;
  let calls = 0;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warnings.push(String(message));
  });
  const ctx = {
    location: { directory: f.b },
    session: {
      async hook(_type: string, fn: typeof hook) {
        hook = fn;
        return { async dispose() {} };
      },
      get() {
        const current = calls++;
        if (current < 2) return ready[current].promise;
        if (current === 2)
          return Promise.reject(Object.assign(new Error("Session.NotFoundError"), { _tag: "SessionNotFoundError" }));
        return Promise.reject(new Error("new lookup"));
      },
      async prompt() {
        assert.fail("an old lookup must not prompt");
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        await deleted.promise;
        yield { type: "session.deleted", data: { sessionID: "same" } };
        processed.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  };
  const close = await plugin.setup(ctx as unknown as Plugin.Context);
  const old = [
    hook({ sessionID: "same", prompt: { text: "Enable GitRelay" } }),
    hook({ sessionID: "same", prompt: { text: "Enable GitRelay" } }),
  ];
  assert.equal(calls, 2);
  deleted.resolve();
  await deadline(processed.promise);
  await deadline(Promise.all(old));
  const beforeNewLookup = calls;
  await deadline(hook({ sessionID: "same", prompt: { text: "Enable GitRelay" } }));
  assert.ok(calls > beforeNewLookup);
  const afterNewLookup = calls;
  assert.ok(warnings.some((message) => message.includes("new lookup")));
  ready[0].resolve({ location: { directory: f.b } });
  ready[1].reject(new Error("late host error"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, afterNewLookup);
  await deadline(close());
});
