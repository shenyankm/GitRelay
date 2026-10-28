import { access, copyFile, readdir, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const toml = join(root, "vendor/smol-toml");
await access(join(toml, "index.js"));
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
    // Node does not strip TypeScript inside node_modules, so ship runnable JS for CLI/SDK hosts.
    let code = stripTypeScriptTypes(source).replace(/((?:from\s+|import\s*\(\s*)["']\.[^"']*)\.ts(["'])/g, "$1.js$2");
    if (path === join("cli", "codex-config.ts")) {
      const bundled = code.replace('from "../../vendor/smol-toml/index.js"', 'from "../vendor/smol-toml/index.js"');
      if (bundled === code) throw new Error("Codex TOML parser import was not bundled.");
      code = bundled;
    }
    const target = resolve(root, "dist", path.replace(/\.ts$/, ".js"));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, code, { mode: source.startsWith("#!") ? 0o755 : 0o644 });
  }
}
await build();
const vendor = join(root, "dist/vendor/smol-toml");
await mkdir(vendor, { recursive: true });
for (const name of await readdir(toml)) if (name.endsWith(".js")) await copyFile(join(toml, name), join(vendor, name));
await copyFile(join(toml, "LICENSE"), join(vendor, "LICENSE"));
