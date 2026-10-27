import assert from "node:assert/strict";
import { test } from "node:test";

import { validateRelease } from "../../scripts/check-release.mjs";

test("release metadata rejects mismatched versions and unrecorded tags", () => {
  const pkg = { name: "git-relay", version: "0.1.0" };
  const lock = { ...pkg, packages: { "": pkg } };
  const changelog = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-27\n";
  assert.doesNotThrow(() => validateRelease(pkg, lock, pkg, changelog));
  assert.doesNotThrow(() => validateRelease(pkg, lock, pkg, changelog, "v0.1.0"));
  assert.throws(() => validateRelease(pkg, lock, { ...pkg, version: "0.2.0" }, changelog), /versions must match/);
  assert.throws(
    () => validateRelease(pkg, { ...lock, packages: { "": { ...pkg, version: "0.2.0" } } }, pkg, changelog),
    /versions must match/,
  );
  assert.throws(() => validateRelease(pkg, lock, pkg, changelog, "v0.2.0"), /tag must match/);
  assert.throws(() => validateRelease(pkg, lock, pkg, "\n## [Unreleased]\n", "v0.1.0"), /dated changelog/);
});

test(
  "release validation runs through symlinked script and checkout paths",
  { skip: process.platform === "win32" },
  async (t) => {
    const { mkdtemp, mkdir, cp, symlink, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { spawnSync } = await import("node:child_process");
    const base = await mkdtemp(join(tmpdir(), "git-relay-release-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const repo = join(base, "repo");
    await mkdir(join(repo, "scripts"), { recursive: true });
    await mkdir(join(repo, ".codex-plugin"));
    const script = join(repo, "scripts", "check-release.mjs");
    await cp(fileURLToPath(new URL("../../scripts/check-release.mjs", import.meta.url)), script);
    const pkg = { name: "git-relay", version: "0.1.0" };
    await writeFile(join(repo, "package.json"), JSON.stringify(pkg));
    await writeFile(join(repo, "package-lock.json"), JSON.stringify({ ...pkg, packages: { "": pkg } }));
    await writeFile(join(repo, ".codex-plugin", "plugin.json"), JSON.stringify(pkg));
    await writeFile(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-27\n");
    await symlink(repo, join(base, "link"), "dir");
    await symlink(script, join(base, "release.mjs"));
    const env = { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" };
    for (const path of [script, join(base, "link", "scripts", "check-release.mjs"), join(base, "release.mjs")]) {
      const result = spawnSync(process.execPath, [path], { env, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Release tag must match/);
    }
    const valid = spawnSync(process.execPath, [join(base, "link", "scripts", "check-release.mjs")], {
      env: { ...env, GITHUB_REF_NAME: "v0.1.0" },
      encoding: "utf8",
    });
    assert.equal(valid.status, 0);
    assert.match(valid.stdout, /Release metadata is consistent/);
    await writeFile(join(repo, ".codex-plugin", "plugin.json"), JSON.stringify({ ...pkg, version: "0.2.0" }));
    const mismatch = spawnSync(process.execPath, [join(base, "link", "scripts", "check-release.mjs")], {
      env: { ...env, GITHUB_REF_TYPE: "branch" },
      encoding: "utf8",
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /versions must match/);
    const imported = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`],
      { env, encoding: "utf8" },
    );
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout, "");
    const importedWithArgument = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`, "missing-file"],
      { env, encoding: "utf8", cwd: base },
    );
    assert.equal(importedWithArgument.status, 0);
    assert.equal(importedWithArgument.stdout, "");
  },
);
