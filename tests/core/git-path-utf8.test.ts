import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeMailbox } from "../../src/core/consumer.ts";
import { eventsIn, readReceipt, sendMessage, sessionKey } from "../../src/core/mailbox.ts";
import { repository } from "../../src/core/store.ts";
import { git as runGit } from "../../src/core/git.ts";
import { fixture, git } from "../helpers.ts";

const ref = "refs/heads/main";
const expected = /Git returned a path or ref that is not valid UTF-8; cannot safely continue/;

test("invalid upstream Git pathname is not confused with a real replacement character", async (t) => {
  const f = await fixture(t);
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "B",
    async deliver() {
      assert.fail("unrepresentable path must not be acknowledged");
    },
  };
  await consumeMailbox(receiver);
  await writeFile(join(f.b, "name_\ufffd"), "local");
  const call = (args: string[], input?: Buffer | string) => execFileSync("git", ["-C", f.main, ...args], { input });
  const blob = call(["hash-object", "-w", "--stdin"], "upstream").toString().trim();
  const entry = Buffer.concat([Buffer.from(`100644 blob ${blob}\tname_`), Buffer.from([255, 0])]);
  const tree = call(["mktree", "-z"], Buffer.concat([call(["ls-tree", "-z", "HEAD"]), entry]))
    .toString()
    .trim();
  const first = call(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", tree, "-p", f.initial],
    "invalid\n",
  )
    .toString()
    .trim();
  const second = call(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", tree, "-p", first],
    "empty\n",
  )
    .toString()
    .trim();
  git(f.main, "update-ref", ref, second);
  await assert.rejects(consumeMailbox(receiver), expected);
  const repo = await repository(f.b),
    key = sessionKey(repo, receiver, ref);
  const events = (await eventsIn(repo)).filter((event) => event.kind === "upstream");
  assert.equal(events.length, 1);
  assert.equal(await readReceipt(repo, key, events[0].id), undefined);
  await assert.rejects(consumeMailbox(receiver), expected);
});

test("a real UTF-8 replacement character is a valid path and produces a diff", async (t) => {
  const f = await fixture(t),
    received: any[] = [];
  const receiver = {
    cwd: f.b,
    ref,
    adapter: "test",
    session: "B",
    async deliver(items: any[]) {
      received.push(...items);
    },
  };
  await consumeMailbox(receiver);
  await writeFile(join(f.b, "name_\ufffd"), "local");
  await f.commit(f.main, "name_\ufffd", "upstream");
  await consumeMailbox(receiver);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].change.files, ["name_\ufffd"]);
  assert.match(received[0].change.patch, /upstream/);
});

for (const category of ["committed", "staged", "unstaged", "others"] as const) {
  test(
    `invalid ${category} path leaves a file-filtered message unread`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await fixture(t),
        received: any[] = [];
      const receiver = {
        cwd: f.b,
        ref,
        adapter: "test",
        session: "B",
        async deliver(items: any[]) {
          received.push(...items);
        },
      };
      await consumeMailbox(receiver);
      const committed = category === "committed" ? await f.commit(f.b, "other.txt", "local commit\n") : f.initial;
      const event = await sendMessage({
        cwd: f.a,
        adapter: "test",
        session: "A",
        text: "marked",
        files: ["name_\ufffd"],
      });
      const repo = await repository(f.b),
        key = sessionKey(repo, receiver, ref);
      const bin = join(f.root, "bin");
      await mkdir(bin);
      const script = `#!/bin/sh\ncase "$*" in\n*'${category === "committed" ? "diff --ignore-submodules=none --name-only --no-renames -z " + f.initial + " " + committed : category === "staged" ? "diff --ignore-submodules=none --name-only --no-renames -z --cached --" : category === "unstaged" ? "diff --name-only --no-renames -z --" : "ls-files --others -z"}'*) printf x > "$GIT_RELAY_TEST_BAD_PATH_MARKER"; printf 'name_\\377\\000'; exit 0 ;;\nesac\nexec /usr/bin/git "$@"\n`;
      await writeFile(join(bin, "git"), script);
      await chmod(join(bin, "git"), 0o755);
      const prior = process.env.PATH,
        priorMarker = process.env.GIT_RELAY_TEST_BAD_PATH_MARKER;
      const marker = join(f.root, "bad-path-injected");
      process.env.PATH = `${bin}:${prior ?? ""}`;
      process.env.GIT_RELAY_TEST_BAD_PATH_MARKER = marker;
      try {
        await assert.rejects(consumeMailbox(receiver), expected);
      } finally {
        if (prior === undefined) delete process.env.PATH;
        else process.env.PATH = prior;
        if (priorMarker === undefined) delete process.env.GIT_RELAY_TEST_BAD_PATH_MARKER;
        else process.env.GIT_RELAY_TEST_BAD_PATH_MARKER = priorMarker;
      }
      assert.equal(await readFile(marker, "utf8"), "x");
      assert.deepEqual(received, []);
      assert.equal(await readReceipt(repo, key, event.id), undefined);
      assert.ok(await readFile(join(repo.directory, "events", `${event.id}.json`)));
    },
  );
}

test("non-path Git output preserves replacement decoding", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t),
    bin = join(f.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\nprintf 'text_\\377'\n");
  await chmod(join(bin, "git"), 0o755);
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior ?? ""}`;
  try {
    assert.equal(await runGit(f.b, ["unrelated-output"]), "text_\ufffd");
  } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
});
