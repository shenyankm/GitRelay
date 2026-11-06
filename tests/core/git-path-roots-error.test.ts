import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { branchStatus } from "../../src/core/branch-status.ts";
import { GitPathOutputError, git, gitPathLine } from "../../src/core/git.ts";
import { readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

const ref = "refs/heads/main";
async function shim(root: string, target: string, value: string) {
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\ncase "$*" in *'${target}'*) printf '${value}'; exit 0 ;; esac\nexec /usr/bin/git "$@"\n`,
  );
  await chmod(join(bin, "git"), 0o755);
  return bin;
}

test(
  "invalid top-level pathname causes consumption error and leaves message unread",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      receiver = { cwd: f.b, adapter: "mcp", session: "B", ref, async deliver() {} };
    await consumeMailbox(receiver);
    const event = await sendMessage({ cwd: f.a, ref, adapter: "test", session: "A", text: "unread" });
    const repo = await repository(f.b),
      key = sessionKey(repo, receiver, ref);
    const bin = await shim(f.root, " rev-parse --show-toplevel", "/invalid_\\377\\n");
    const prior = process.env.PATH;
    process.env.PATH = `${bin}:${prior ?? ""}`;
    try {
      await assert.rejects(
        consumeMailbox({
          ...receiver,
          async deliver() {
            assert.fail("no silent response");
          },
        }),
        GitPathOutputError,
      );
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
    assert.equal(await readReceipt(repo, key, event.id), undefined);
    const out: object[] = [];
    await consumeMailbox({
      ...receiver,
      async deliver(value) {
        out.push(value);
      },
    });
    assert.equal(out.length, 1);
    assert.ok(JSON.stringify(out[0]).includes("unread"));
  },
);

test(
  "invalid common directory path is rejected by repository discovery",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = await shim(f.root, " rev-parse --path-format=absolute --git-common-dir", "/invalid_\\377\\n");
    const prior = process.env.PATH;
    process.env.PATH = `${bin}:${prior ?? ""}`;
    try {
      await assert.rejects(repository(f.b), GitPathOutputError);
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
  },
);

test(
  "status identifiers reject invalid bytes but preserve valid replacement characters",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = await shim(f.root, " status --porcelain=v2", "# branch.head bad_\\377\\000");
    const prior = process.env.PATH;
    process.env.PATH = `${bin}:${prior ?? ""}`;
    try {
      await assert.rejects(branchStatus({ cwd: f.b }), GitPathOutputError);
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
    assert.equal((await branchStatus({ cwd: f.b })).worktree.branch, "feature/b");
  },
);

test(
  "worktree record validates path but not free-text lock reason",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      bin = await shim(f.root, " worktree list --porcelain -z", "worktree /valid\\000locked note_\\377\\000");
    const prior = process.env.PATH;
    process.env.PATH = `${bin}:${prior ?? ""}`;
    try {
      const output = await git(f.b, ["worktree", "list", "--porcelain", "-z"], undefined, "worktree-records");
      assert.ok(output.includes("locked note_\ufffd"));
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
  },
);

test("Git path output requires its own line delimiter and keeps path CR on Unix", () => {
  assert.throws(() => gitPathLine("/unterminated"), GitPathOutputError);
  assert.equal(gitPathLine("/path\n"), "/path");
  assert.equal(gitPathLine("/path\r\n"), process.platform === "win32" ? "/path" : "/path\r");
});
