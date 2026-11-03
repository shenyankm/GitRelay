import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEvent } from "../../src/core/mailbox.ts";

for (const posix of [false, true])
  test(`message paths distinguish parent segments from literal line endings (posix=${posix})`, () => {
    const id = "a".repeat(64);
    const event = (file: string) => ({
      id,
      kind: "message",
      createdAt: "2020-01-01T00:00:00.000Z",
      sender: { adapter: "test", session: "s", root: "/fixture" },
      recipients: [],
      text: "message",
      files: [file],
      ...(posix ? { pathFormat: "posix-v1" } : {}),
    });
    for (const file of ["..\n", "..\r", "..\r\n", "..\u2028", "..\u2029", "dir/..\n", "dir/..x"]) {
      const parsed = validateEvent(event(file), id, posix);
      assert.ok(parsed.kind === "message");
      assert.deepEqual(parsed.files, [file]);
    }
    for (const file of ["..", "../file", "dir/..", "dir/../file", "dir//..", "dir/..//child"])
      assert.throws(() => validateEvent(event(file), id, posix), /without parent traversal/);
    const backslashes = "literal\\..\\child";
    if (posix) {
      const parsed = validateEvent(event(backslashes), id, true);
      assert.ok(parsed.kind === "message");
      assert.deepEqual(parsed.files, [backslashes]);
    } else assert.throws(() => validateEvent(event(backslashes), id, false), /without parent traversal/);
  });
