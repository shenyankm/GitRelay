import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export function validateRelease(pkg, lock, plugin, changelog, tag) {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  for (const metadata of [lock, lock.packages[""], plugin]) {
    assert.equal(metadata.name, pkg.name, "Package, lockfile and plugin names must match");
    assert.equal(metadata.version, pkg.version, "Package, lockfile and plugin versions must match");
  }
  assert.ok(changelog.includes("\n## [Unreleased]\n"), "Keep an Unreleased changelog section");
  if (tag) {
    assert.equal(tag, `v${pkg.version}`, "Release tag must match the package version");
    assert.ok(
      changelog.split("\n").some((line) => line.startsWith(`## [${pkg.version}] - `)),
      "Release tag requires dated changelog notes",
    );
  }
}

const scriptPath = await realpath(fileURLToPath(import.meta.url));
if (process.argv[1] && (await realpath(process.argv[1]).catch(() => undefined)) === scriptPath) {
  const read = async (path) => readFile(new URL(`../${path}`, pathToFileURL(scriptPath)), "utf8");
  const [pkg, lock, plugin, changelog] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("package-lock.json").then(JSON.parse),
    read(".codex-plugin/plugin.json").then(JSON.parse),
    read("CHANGELOG.md"),
  ]);
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  validateRelease(pkg, lock, plugin, changelog, tag);
  console.log(`Release metadata is consistent${tag ? ` for ${tag}` : " (no release tag)"}.`);
}
