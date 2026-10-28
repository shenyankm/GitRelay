import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/adapters/opencode/index.ts";
import { fixture } from "../helpers.ts";

test("failed reporting during a background scan does not reject the timer task", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  let hook!: (event: { sessionID: string; prompt?: { text: string } }) => Promise<void>;
  let tick!: () => void;
  let gets = 0,
    reports = 0;
  const warned = Promise.withResolvers<void>();
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void) => {
    tick = fn;
    return { unref() {} };
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const context = {
    location: { directory: f.b },
    session: {
      async hook(_name: string, handler: typeof hook) {
        hook = handler;
        return { async dispose() {} };
      },
      async get() {
        if (++gets > 2) throw new Error("host query failed");
        return { location: { directory: f.b }, time: { created: 1 } };
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        if (!signal.aborted)
          await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      },
    },
  };
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);
  try {
    await hook({ sessionID: "reporter-test", prompt: { text: "Enable GitRelay" } });
    t.mock.method(console, "warn", () => {
      reports++;
      warned.resolve();
      throw new Error("reporter failure");
    });
    tick();
    await warned.promise;
    await delay(0);
    assert.equal(gets, 3);
    assert.equal(reports, 1);
  } finally {
    try {
      await cleanup();
    } finally {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    }
  }
});

test("failed reporting of an event-stream error does not break cleanup", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  let reports = 0,
    calls = 0;
  let hook!: (event: any) => Promise<void>;
  const warned = Promise.withResolvers<void>();
  t.mock.method(console, "warn", () => {
    reports++;
    warned.resolve();
    throw new Error("reporter failure");
  });
  const context = {
    location: { directory: f.b },
    session: {
      async get() {
        return { location: { directory: f.b }, time: { created: 1 } };
      },
      async hook(_name: string, handler: (event: any) => Promise<void>) {
        hook = handler;
        return { async dispose() {} };
      },
    },
    event: {
      async *subscribe() {
        calls++;
        throw new Error("event stream failed");
      },
    },
  };
  const cleanup = await plugin.setup(context as unknown as Plugin.Context);
  try {
    assert.equal(calls, 1);
    await hook({ sessionID: "enabled", prompt: { text: "Enable GitRelay" } });
    await warned.promise;
    await delay(0);
    assert.equal(reports, 1);
    assert.equal(calls, 1);
  } finally {
    await cleanup();
  }
});
