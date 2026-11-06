import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const docs = fileURLToPath(new URL("../../docs", import.meta.url));

async function* textFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* textFiles(path);
    else if (/\.(md|json|txt)$/.test(entry.name)) yield path;
  }
}

const credentialPatterns = [
  /OPENCODE_SERVER_PASSWORD=(?!<redacted>)\S+/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // The captured OpenCode server password was a bare 48-hex value.
  /\b[0-9a-f]{48}\b/,
];

test("docs contain no credential-like values", async () => {
  for await (const path of textFiles(docs)) {
    const text = await readFile(path, "utf8");
    for (const pattern of credentialPatterns) assert.doesNotMatch(text, pattern, `credential-like value in ${path}`);
  }
});
