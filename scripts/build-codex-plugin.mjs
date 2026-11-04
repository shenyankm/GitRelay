import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, ".codex/plugin-build");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"));
if (manifest.name !== pkg.name.split("/").at(-1) || manifest.version !== pkg.version)
  throw new Error("Codex plugin name must match the npm package basename, and versions must match.");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const path of [
  ".codex-plugin",
  "assets",
  "dist",
  "skills",
  "docs",
  "src/adapters/codex/plugin-hooks.json",
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "LICENSE",
]) {
  await cp(join(root, path), join(target, path), {
    recursive: true,
    filter: (source) =>
      source !== join(root, "docs/evidence") &&
      source !== join(root, "docs/acceptance-results.json") &&
      source !== join(root, "docs/optimization-rounds.md") &&
      !source.endsWith(".d.ts"),
  });
}
await writeFile(
  join(target, "package.json"),
  JSON.stringify(
    { name: manifest.name, version: pkg.version, license: pkg.license, type: "module", private: true },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`Codex plugin built at ${target}\n`);
