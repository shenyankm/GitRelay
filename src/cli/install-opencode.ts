import { publishBootstrap } from "./bootstrap.ts";
import { randomUUID } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, withLock, writeJson } from "../core/store.ts";
import { commandOutput } from "./command-output.ts";
import { installerDigest, matchesLegacyInstallerDigest } from "./installer-digest.ts";

type Record = {
  entry: string;
  content: string;
  anchor: string;
  current: string | null;
  pending?: string;
  removing?: string;
  removed?: boolean;
  archive?: string;
};

export function validRecord(value: unknown, entry: string, root: string): value is Record {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record;
  const revision = (item: unknown) => typeof item === "string" && /^\d{20}-[a-f0-9]{64}$/.test(item);
  const archive = (item: unknown) =>
    item === undefined ||
    (typeof item === "string" &&
      dirname(dirname(item)) === dirname(entry) &&
      /^\.git-relay-removed-[a-zA-Z0-9]+$/.test(basename(dirname(item))) &&
      basename(item) === "entry");
  const expected = `export { default } from ${JSON.stringify(pathToFileURL(join(root, "opencode-current.mjs")).href)};\n`;
  return (
    record.entry === entry &&
    record.content === expected &&
    typeof record.anchor === "string" &&
    /^\.git-relay-anchor-[0-9a-f-]{36}$/.test(record.anchor) &&
    (record.current === null || revision(record.current)) &&
    (record.pending === undefined || revision(record.pending)) &&
    (record.removed === undefined || typeof record.removed === "boolean") &&
    archive(record.removing) &&
    archive(record.archive)
  );
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([lstat(a), lstat(b)]);
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

async function anchorPath(entry: string, name: string): Promise<string> {
  return join(dirname(entry), name);
}

async function contents(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error(`Not a small regular file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRecord(path: string): Promise<Record | undefined> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Invalid OpenCode installation record: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const record = await readJson(path);
  if (record === undefined) throw new Error(`Invalid OpenCode installation record: ${path}`);
  return record as Record;
}

const digest = (dir: string, signal?: AbortSignal) => installerDigest(dir, signal);

const legacyBootstrap = `import { readFile, readdir } from "node:fs/promises";\nconst state = JSON.parse(await readFile(new URL("./opencode.json", import.meta.url), "utf8"));\nconst revisions = (await readdir(new URL("./opencode-revisions/", import.meta.url))).sort();\nconst revision = revisions.at(-1);\nif (!revision || !/^\\d{20}-[a-f0-9]{64}$/.test(revision) || (revision !== state.current && revision !== state.pending)) throw new Error("Invalid GitRelay OpenCode revision");\nexport default (await import(new URL("./runtimes/" + revision.slice(21) + "/dist/adapters/opencode/index.js", import.meta.url).href)).default;\n`;
const bootstrap = legacyBootstrap
  .replace(
    "const revision = revisions.at(-1);",
    "const revision = [state.pending, state.current].find((value) => revisions.includes(value));",
  )
  .replace("if (!revision", "if (state.removed || !revision");

export async function checkWorkspace(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error(`Not an owned GitRelay workspace: ${root}`);
  if (info.isSymbolicLink() && !/^\.git-relay-[a-zA-Z0-9]+$/.test(await readlink(root)))
    throw new Error(`Not an owned GitRelay workspace: ${root}`);
  if ((await contents(join(root, ".git-relay-owner"))) !== "git-relay installer v1\n")
    throw new Error(`Not an owned GitRelay workspace: ${root}`);
}

export async function ensureWorkspace(root: string): Promise<void> {
  await mkdir(dirname(root), { recursive: true });
  let exists = false;
  try {
    await lstat(root);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    await checkWorkspace(root);
    return;
  }
  const staged = await mkdtemp(join(dirname(root), ".git-relay-"));
  let published = false;
  try {
    await writeFile(join(staged, ".git-relay-owner"), "git-relay installer v1\n", { flag: "wx", mode: 0o600 });
    try {
      await symlink(basename(staged), root, "dir");
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await checkWorkspace(root);
    }
  } finally {
    // Another process can reference or add files to this directory even if
    // our publication failed. Do not recursively remove it without proof.
    if (!published) console.warn(`GitRelay workspace stage retained: ${staged} (may be in use)`);
  }
}

export async function installOpenCode(
  root: string,
  config: string,
  sourceDist: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await ensureWorkspace(root);
  await withLock(
    join(root, "install.lock"),
    async () => {
      const state = join(root, "opencode.json");
      const entry = join(config, "opencode", "plugins", "git-relay.js");
      const record = await readRecord(state);
      if (record && !validRecord(record, entry, root))
        throw new Error(`Invalid OpenCode installation record: ${state}`);
      if (record?.removing) throw new Error("An uninstall is incomplete; rerun uninstall before installing.");
      if (!record && (await contents(entry)) !== undefined)
        throw new Error(`OpenCode entry already exists and is not owned: ${entry}`);
      const actual = await contents(entry);
      if (record?.removed && actual !== undefined)
        throw new Error(`OpenCode entry was recreated after uninstall; preserved: ${entry}`);
      if (record && actual !== undefined && actual !== record.content)
        throw new Error(`OpenCode entry was modified; preserved: ${entry}`);
      const existingAnchor = record && !record.removed ? await anchorPath(entry, record.anchor) : undefined;
      if (
        record &&
        !record.removed &&
        ((await contents(existingAnchor!)) !== record.content ||
          (actual !== undefined && !(await sameFile(entry, existingAnchor!))))
      )
        throw new Error(`OpenCode entry ownership cannot be established; preserved: ${entry}`);
      const pointer = join(root, "opencode-current.mjs");
      const pointerActual = await contents(pointer);
      if (
        pointerActual !== undefined &&
        (!record || (pointerActual !== bootstrap && pointerActual !== legacyBootstrap))
      )
        throw new Error(`OpenCode bootstrap was modified; preserved: ${pointer}`);
      const revisions = join(root, "opencode-revisions");
      await mkdir(revisions, { recursive: true });
      const names = (await readdir(revisions)).sort();
      if (names.some((name) => !/^\d{20}-[a-f0-9]{64}$/.test(name)))
        throw new Error(`Unexpected OpenCode revision; preserved: ${revisions}`);
      for (const name of names)
        if ((await contents(join(revisions, name))) !== "")
          throw new Error(`OpenCode revision was modified: ${join(revisions, name)}`);
      const latest = names.at(-1);
      if (
        (!record && latest) ||
        (record && (latest ?? null) !== (record.pending ?? record.current) && (latest ?? null) !== record.current)
      )
        throw new Error(`OpenCode revisions changed outside GitRelay: ${revisions}`);
      const id = await digest(sourceDist, signal);
      if (latest) {
        const existingRuntime = join(root, "runtimes", latest.slice(21));
        const existingDigest = await digest(join(existingRuntime, "dist"), signal);
        if (
          (existingDigest !== latest.slice(21) &&
            existingDigest !== id &&
            !(await matchesLegacyInstallerDigest(join(existingRuntime, "dist"), latest.slice(21), signal))) ||
          (await contents(join(existingRuntime, "package.json"))) !== '{"type":"module"}\n'
        )
          throw new Error(
            `OpenCode runtime was modified or its legacy digest cannot be verified; preserved: ${existingRuntime}. Retry with the original LC_ALL/LANG if known.`,
          );
      }

      const runtimes = join(root, "runtimes");
      const runtime = join(runtimes, id);
      await mkdir(runtimes, { recursive: true });
      try {
        if ((await digest(join(runtime, "dist"), signal)) !== id) throw new Error(`Runtime was modified: ${runtime}`);
        if ((await contents(join(runtime, "package.json"))) !== '{"type":"module"}\n')
          throw new Error(`Runtime was modified: ${runtime}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const existing = await lstat(runtime).catch((failure) => {
          if (failure.code === "ENOENT") return undefined;
          throw failure;
        });
        if (existing)
          throw new Error(`OpenCode runtime is incomplete or was modified; preserved: ${runtime}`, { cause: error });
        const temp = await mkdtemp(join(runtimes, ".stage-"));
        try {
          await cp(sourceDist, join(temp, "dist"), { recursive: true });
          if ((await digest(join(temp, "dist"), signal)) !== id)
            throw new Error("Runtime changed while copying; retry installation.");
          await writeFile(join(temp, "package.json"), '{"type":"module"}\n', { flag: "wx" });
          await rename(temp, runtime);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
      const moduleUrl = pathToFileURL(join(runtime, "dist", "adapters", "opencode", "index.js")).href;
      try {
        await commandOutput(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const m = await import(process.argv[1]); if (m.default?.id !== 'git-relay' || typeof m.default?.setup !== 'function') throw new Error('Invalid OpenCode adapter');",
            moduleUrl,
          ],
          process.env,
          5000,
          64 * 1024,
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(
          `OpenCode staged adapter validation failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      signal?.throwIfAborted();
      const desired = latest?.endsWith(`-${id}`)
        ? latest
        : `${String(BigInt(latest?.slice(0, 20) ?? "0") + 1n).padStart(20, "0")}-${id}`;
      if (!/^\d{20}-[a-f0-9]{64}$/.test(desired)) throw new Error("OpenCode revision counter exhausted.");
      const entryContent = `export { default } from ${JSON.stringify(pathToFileURL(pointer).href)};\n`;
      if (record && record.content !== entryContent) throw new Error(`Invalid OpenCode entry in ${state}`);
      const anchor = record && !record.removed ? record.anchor : `.git-relay-anchor-${randomUUID()}`;
      if (!record || record.removed) {
        await mkdir(dirname(entry), { recursive: true });
        await writeFile(await anchorPath(entry, anchor), entryContent, { flag: "wx", mode: 0o600 });
      }
      const next: Record = { entry, content: entryContent, anchor, current: latest ?? null, pending: desired };
      await writeJson(state, next);
      await mkdir(join(config, "opencode", "plugins"), { recursive: true });
      if (latest !== desired) await writeFile(join(revisions, desired), "", { flag: "wx", mode: 0o600 });
      await publishBootstrap(pointer, pointerActual, bootstrap);
      if (actual === undefined) {
        await link(await anchorPath(entry, anchor), entry);
      }
      await writeJson(state, { entry, content: entryContent, anchor, current: desired });
    },
    { waitMs: 100, signal },
  );
  signal?.throwIfAborted();
}

export async function uninstallOpenCode(
  root: string,
  config: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  await checkWorkspace(root);
  const archive = await withLock(
    join(root, "install.lock"),
    async () => {
      const state = join(root, "opencode.json");
      const record = await readRecord(state);
      if (!record) return;
      const entry = join(config, "opencode", "plugins", "git-relay.js");
      if (!validRecord(record, entry, root)) throw new Error(`Invalid OpenCode installation record: ${state}`);
      if (record.removed) return record.archive;
      const actual = await contents(entry);
      if (record.removing && actual !== undefined && (await contents(record.removing)) !== undefined)
        throw new Error(`Uninstall interrupted; preserve both ${entry} and ${record.removing} for inspection.`);
      if (!record.removing && actual !== undefined && actual !== record.content)
        throw new Error(`OpenCode entry was modified; preserved: ${entry}`);
      const anchor = await anchorPath(entry, record.anchor);
      if ((await contents(anchor)) !== record.content || (actual !== undefined && !(await sameFile(entry, anchor))))
        throw new Error(`OpenCode entry ownership cannot be established; preserved: ${entry}`);
      let archive = record.removing;
      if (!archive && actual !== undefined) {
        const directory = await mkdtemp(join(dirname(entry), ".git-relay-removed-"));
        archive = join(directory, "entry");
        await writeJson(state, { ...record, removing: archive });
        await rename(entry, archive);
      } else if (archive && actual !== undefined) await rename(entry, archive);
      if (archive) {
        let same = false;
        try {
          same = (await contents(archive)) === record.content && (await sameFile(archive, anchor));
        } catch {
          /* Preserve nonregular replacements. */
        }
        if (!same) {
          try {
            await link(archive, entry);
          } catch {
            /* Keep the archive when a replacement occupies the path. */
          }
          throw new Error(`OpenCode entry changed during uninstall; preserved at ${archive} and possibly ${entry}.`);
        }
      }
      await writeJson(state, {
        entry,
        content: record.content,
        anchor: record.anchor,
        current: record.current,
        pending: record.pending,
        removed: true,
        archive,
      });
      return archive;
    },
    { waitMs: 100, signal },
  );
  signal?.throwIfAborted();
  return archive;
}
