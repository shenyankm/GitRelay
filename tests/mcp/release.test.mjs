import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRelease } from "../../scripts/check-release.mjs";

test("MCP release metadata rejects inconsistent package/lock versions and unrecorded tags", () => {
  const pkg = { name: "@sistine29/git-relay", version: "0.2.0" };
  const lock = { ...pkg, packages: { "": pkg } };
  const changelog = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-05\n";
  assert.doesNotThrow(() => validateRelease(pkg, lock, changelog));
  assert.doesNotThrow(() => validateRelease(pkg, lock, changelog, "v0.2.0"));
  assert.throws(() => validateRelease(pkg, { ...lock, version: "0.1.2" }, changelog), /versions must match/);
  assert.throws(
    () => validateRelease(pkg, { ...lock, packages: { "": { ...pkg, version: "0.1.2" } } }, changelog),
    /versions must match/,
  );
  assert.throws(() => validateRelease(pkg, { ...lock, name: "git-relay" }, changelog), /names must match/);
  assert.throws(() => validateRelease(pkg, lock, changelog, "v0.1.2"), /tag must match/);
  assert.throws(() => validateRelease(pkg, lock, "\n## [Unreleased]\n", "v0.2.0"), /dated changelog/);
});

test(
  "release validation resolves symlinked entry points without any plugin manifest",
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
    const script = join(repo, "scripts", "check-release.mjs");
    await cp(fileURLToPath(new URL("../../scripts/check-release.mjs", import.meta.url)), script);
    const pkg = { name: "@sistine29/git-relay", version: "0.2.0" };
    await writeFile(join(repo, "package.json"), JSON.stringify(pkg));
    await writeFile(join(repo, "package-lock.json"), JSON.stringify({ ...pkg, packages: { "": pkg } }));
    await writeFile(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-05\n");
    await symlink(repo, join(base, "link"), "dir");
    await symlink(script, join(base, "release.mjs"));
    const env = { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" };
    for (const path of [script, join(base, "link", "scripts", "check-release.mjs"), join(base, "release.mjs")]) {
      const result = spawnSync(process.execPath, [path], { env, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Release tag must match/);
    }
    const valid = spawnSync(process.execPath, ["--preserve-symlinks-main", join(base, "release.mjs")], {
      env: { ...env, GITHUB_REF_NAME: "v0.2.0" },
      encoding: "utf8",
    });
    assert.equal(valid.status, 0, valid.stderr);
    const imported = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`],
      { env, encoding: "utf8" },
    );
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout, "");
  },
);
