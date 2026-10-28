import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/adapters/opencode/index.ts";
import { fixture } from "../helpers.ts";

test(
  "OpenCode automatic enrollment rejects invalid Git root bytes without accepting events",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = join(f.root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      "#!/bin/sh\ncase \"$*\" in *' rev-parse --show-toplevel'*) printf '/private_\\377\\n'; exit 0;; esac\nexec /usr/bin/git \"$@\"\n",
    );
    await chmod(join(bin, "git"), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: unknown) => {
      warnings.push(String(message));
    });
    let prompt!: (event: { sessionID: string; prompt: { text: string } }) => Promise<void>;
    const cleanup = await plugin.setup({
      location: { directory: f.b },
      session: {
        async get() {
          return { location: { directory: f.b }, time: { created: 1 } };
        },
        async hook(_name: string, handler: typeof prompt) {
          prompt = handler;
          return { async dispose() {} };
        },
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          if (!signal.aborted)
            await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
        },
      },
    } as unknown as Plugin.Context);
    try {
      await prompt({ sessionID: "invalid-path", prompt: { text: "fix a bug" } });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /not valid UTF-8/);
      assert.ok(!warnings[0].includes("/private_"));
    } finally {
      await cleanup();
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  },
);
