import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathMatcher, worktreeFiles } from "../../src/core/changes.ts";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { sendMessage } from "../../src/core/mailbox.ts";
import { fixture, git } from "../helpers.ts";

test("path matching respects directory boundaries and normalized case", async (t) => {
  const f = await fixture(t);
  const deep = `${"a/".repeat(200_000)}leaf`;
  const own = new Set(["foo/bar", "foobar/file", "Éclair/😀/file", "Case/", deep]);
  git(f.b, "config", "core.ignorecase", "false");
  const matches = await pathMatcher(f.b, own);
  for (const file of ["foo", "foo/bar", "foo/bar/child", "foobar", "Éclair/😀", "Case/child", "a", deep])
    assert.equal(matches(file), true, file.slice(0, 80));
  for (const file of [".", "foo/", "fo", "foo2", "FOO", "éclair/😀", "Case2/child"])
    assert.equal(matches(file), false, file);
  git(f.b, "config", "core.ignorecase", "true");
  const folded = await pathMatcher(f.b, own);
  assert.equal(folded("FOO"), true);
  assert.equal(folded("éCLAIR/😀"), true);
  assert.equal(folded("CASE/child"), true);
  assert.equal(folded("FOO2"), false);
  const empty = await pathMatcher(f.b, new Set());
  for (const file of [".", "foo/", "foo", "foo/bar", "éCLAIR/😀", deep]) assert.equal(empty(file), false);
});

test("untracked nested repositories remain relevant to upstream and messages", async (t) => {
  const f = await fixture(t);
  const ref = "refs/heads/main";
  const receiver = { cwd: f.b, ref, adapter: "test", session: "nested", async deliver() {} };
  await consumeMailbox(receiver);
  await writeFile(join(f.b, ".gitignore"), "ignored/\n");
  for (const dir of ["nested", "ignored"]) {
    await mkdir(join(f.b, dir));
    git(join(f.b, dir), "init", "-q");
    await writeFile(join(f.b, dir, "file.txt"), "local");
    await mkdir(join(f.main, dir));
  }
  await mkdir(join(f.b, "plain"));
  await writeFile(join(f.b, "plain", "file.txt"), "local");
  const own = await worktreeFiles(f.b, f.initial);
  assert.ok(own.has("nested/"));
  assert.ok(own.has("ignored/"));
  const matches = await pathMatcher(f.b, own);
  assert.equal(matches("nested/file.txt"), true);
  assert.equal(matches("ignored/file.txt"), true);
  assert.equal(matches("plain/file.txt"), true);
  assert.equal(matches("nested"), true);
  assert.equal(matches("nested2/file.txt"), false);
  assert.equal(matches("nested/"), false);
  git(f.b, "config", "core.ignorecase", "true");
  const caseInsensitive = await pathMatcher(f.b, own);
  assert.equal(caseInsensitive("NESTED/file.txt"), true);
  assert.equal(caseInsensitive("NESTED2/file.txt"), false);
  git(f.b, "config", "core.ignorecase", "false");

  const current = await f.commit(f.main, "nested/file.txt", "upstream");
  const upstream = (await consumeMailbox(receiver)).find((item) => item.kind === "upstream");
  assert.equal(upstream?.event.commit, current);
  const message = await sendMessage({
    cwd: f.main,
    adapter: "test",
    session: "sender",
    text: "overlap",
    files: ["ignored/file.txt"],
  });
  assert.ok((await consumeMailbox(receiver)).some((item) => item.event.id === message.id));
  assert.deepEqual(await consumeMailbox(receiver), []);
});
