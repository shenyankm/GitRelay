import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installerDigest } from "../../src/cli/installer-digest.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "git-relay-installer-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["dist", "src", "skills/worktree-coordination", "docs"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "src", "a"), Buffer.from([0, 255]));
  await writeFile(join(root, "skills/worktree-coordination/SKILL.md"), "skill");
  await writeFile(join(root, "dist", "中"), Buffer.alloc(8 * 1024 * 1024, 137));
  await writeFile(join(root, "docs", "a"), "");
  return root;
}

function expected(entries: [string, Buffer][]): string {
  const hash = createHash("sha256");
  for (const [path, data] of entries)
    hash
      .update(`${Buffer.byteLength(path)}:`)
      .update(path)
      .update(`${data.length}:`)
      .update(data);
  return hash.digest("hex");
}

test("installer digest keeps the published runtime format, including large and Unicode files", async (t) => {
  const root = await fixture(t),
    large = await readFile(join(root, "dist", "中"));
  assert.equal(await installerDigest(join(root, "dist")), expected([["中", large]]));
});

test("installer digest is independent of the process locale", async (t) => {
  const root = await fixture(t);
  const directory = join(root, "src");
  await writeFile(join(directory, "z.js"), "x");
  await writeFile(join(directory, "ä.js"), "y");
  const module = new URL("../../src/cli/installer-digest.ts", import.meta.url).href;
  const script = `import { installerDigest } from ${JSON.stringify(module)}; console.log(await installerDigest(process.argv[1]));`;
  const digest = (locale: string) =>
    execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, directory], {
      env: { ...process.env, LC_ALL: locale, LANG: locale },
      encoding: "utf8",
    });
  assert.equal(digest("en_US.UTF-8"), digest("sv_SE.UTF-8"));
});

test(
  "installer digests retain top-level link compatibility and reject nested links",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await fixture(t),
      real = join(root, "real-dist");
    await rename(join(root, "dist"), real);
    await symlink("real-dist", join(root, "dist"));
    assert.equal(await installerDigest(join(root, "dist")), expected([["中", await readFile(join(real, "中"))]]));
    await symlink("a", join(root, "src", "nested-link"));
    await assert.rejects(installerDigest(join(root, "src")), /Unexpected installer entry/);
  },
);

test(
  "installer digest rejects a file replaced by a FIFO without hanging",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await fixture(t),
      originalOpen = fs.promises.open;
    const directory = join(root, "dist");
    const victim = join(directory, "中");
    let injected = false;
    fs.promises.open = async function (path, ...args) {
      if (!injected && String(path) === victim) {
        injected = true;
        await rename(victim, `${victim}.old`);
        execFileSync("mkfifo", [victim]);
      }
      return originalOpen(path, ...args);
    } as typeof fs.promises.open;
    syncBuiltinESMExports();
    try {
      await assert.rejects(installerDigest(directory), /changed|ELOOP|Unexpected/);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
  },
);

test("installer digest rejects changed directory entries and replaced file paths", async (t) => {
  const root = await fixture(t),
    directory = join(root, "src"),
    victim = join(directory, "a");
  const originalRead = fs.promises.readdir;
  let injected = false;
  fs.promises.readdir = async function (path, ...args) {
    const result = await (originalRead as (...input: unknown[]) => Promise<unknown>)(path, ...args);
    if (!injected && String(path) === directory) {
      injected = true;
      await writeFile(join(directory, "new"), "x");
      await utimes(directory, 1, 1);
    }
    return result;
  } as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installerDigest(join(root, "src")), /directory changed/);
  } finally {
    fs.promises.readdir = originalRead;
    syncBuiltinESMExports();
  }
  await rm(join(directory, "new"));
  const originalOpen = fs.promises.open;
  injected = false;
  fs.promises.open = async function (path, ...args) {
    const opened = await originalOpen(path, ...args);
    if (!injected && String(path) === victim) {
      injected = true;
      await rename(victim, `${victim}.old`);
      await writeFile(victim, "replacement");
    }
    return opened;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installerDigest(join(root, "src")), /file changed/);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(victim, "utf8"), "replacement");
  await assert.rejects(installerDigest(join(root, "missing")), { code: "ENOENT" });
});

test("installer digest checks cancellation between chunks and closes its descriptor", async (t) => {
  const root = await fixture(t),
    victim = join(root, "dist", "中"),
    originalOpen = fs.promises.open,
    controller = new AbortController();
  let handle: Awaited<ReturnType<typeof originalOpen>> | undefined;
  fs.promises.open = async function (path, ...args) {
    const opened = await originalOpen(path, ...args);
    if (String(path) === victim) {
      handle = opened;
      const read = opened.read;
      opened.read = async function (...params: Parameters<typeof read>) {
        const result = await read.apply(opened, params);
        controller.abort();
        return result;
      } as typeof read;
    }
    return opened;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installerDigest(join(root, "dist"), controller.signal), { name: "AbortError" });
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.ok(handle);
  await assert.rejects(handle.stat(), { code: "EBADF" });
});

test("installer digest rejects a file that grows after it is opened", async (t) => {
  const root = await fixture(t),
    victim = join(root, "src", "a"),
    originalOpen = fs.promises.open;
  let injected = false;
  fs.promises.open = async function (path, ...args) {
    const opened = await originalOpen(path, ...args);
    if (String(path) === victim) {
      const read = opened.read;
      opened.read = async function (...params: Parameters<typeof read>) {
        const result = await read.apply(opened, params);
        if (!injected) {
          injected = true;
          await fs.promises.appendFile(victim, "growth");
        }
        return result;
      } as typeof read;
    }
    return opened;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installerDigest(join(root, "src")), /file changed/);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
});

test("installer digest rejects an in-place edit after the final descriptor stat", async (t) => {
  const root = await fixture(t),
    victim = join(root, "src", "a"),
    originalLstat = fs.promises.lstat;
  let seen = 0;
  fs.promises.lstat = async function (path, ...args) {
    if (String(path) === victim && ++seen === 2) {
      await writeFile(victim, Buffer.from([255, 0]));
      await utimes(victim, 1, 1);
    }
    return (originalLstat as (...input: unknown[]) => Promise<unknown>)(path, ...args);
  } as typeof fs.promises.lstat;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installerDigest(join(root, "src")), /file changed/);
  } finally {
    fs.promises.lstat = originalLstat;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(victim), Buffer.from([255, 0]));
  assert.equal(seen, 2);
});

test("installer digest rechecks earlier files after reading later files", async (t) => {
  const root = await fixture(t),
    first = join(root, "src", "a"),
    second = join(root, "src", "b");
  await writeFile(second, "later");
  const originalOpen = fs.promises.open;
  let injected = false;
  fs.promises.open = async function (path, ...args) {
    const opened = await originalOpen(path, ...args);
    if (!injected && String(path) === second) {
      injected = true;
      await writeFile(first, Buffer.from([255, 0]));
      await utimes(first, 1, 1);
    }
    return opened;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installerDigest(join(root, "src")), /entry changed/);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(first), Buffer.from([255, 0]));
  assert.equal(injected, true);
});

test("installer digest settles recheck reads before returning cancellation", async (t) => {
  const root = await fixture(t),
    first = join(root, "src", "a"),
    second = join(root, "src", "b");
  await writeFile(second, "later");
  const originalLstat = fs.promises.lstat,
    counts = new Map<string, number>(),
    controller = new AbortController();
  let settled = false;
  fs.promises.lstat = async function (path, ...args) {
    const name = String(path),
      count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (name === second && count === 3) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = true;
    }
    const value = await (originalLstat as (...input: unknown[]) => Promise<unknown>)(path, ...args);
    if (name === first && count === 3) controller.abort();
    return value;
  } as typeof fs.promises.lstat;
  syncBuiltinESMExports();
  try {
    await assert.rejects(installerDigest(join(root, "src"), controller.signal), { name: "AbortError" });
  } finally {
    fs.promises.lstat = originalLstat;
    syncBuiltinESMExports();
  }
  assert.equal(settled, true);
});
