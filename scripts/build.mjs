import { execFileSync } from "node:child_process";
import { readdir, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(join(root, "dist"), { recursive: true, force: true });

async function build(relative = "") {
  for (const entry of await readdir(join(root, "src", relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) {
      await build(path);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const source = await readFile(join(root, "src", path), "utf8");
    // Node does not strip TypeScript inside node_modules, so ship runnable JS for MCP hosts.
    const code = stripTypeScriptTypes(source).replace(/((?:from\s+|import\s*\(\s*)["']\.[^"']*)\.ts(["'])/g, "$1.js$2");
    const target = resolve(root, "dist", path.replace(/\.ts$/, ".js"));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, code, { mode: source.startsWith("#!") ? 0o755 : 0o644 });
  }
}
await build();

execFileSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json")],
  { stdio: "inherit" },
);
