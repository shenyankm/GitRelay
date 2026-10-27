import { publishBootstrap } from "./bootstrap.ts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readJson, withLock, writeJson } from "../core/store.ts";
import { readInstallationRecord } from "./install-record.ts";
import { checkWorkspace } from "./install-opencode.ts";
import { commandOutput } from "./command-output.ts";
import { installerDigest, matchesLegacyInstallerDigest } from "./installer-digest.ts";
import { checkInlineHooks } from "./codex-config.ts";

type Options = {
  workspace: string;
  sourceRoot: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  clientVersion?: string;
};
type Record = {
  entry: string;
  content: string;
  anchor: string;
  nodePath: string;
  current: string | null;
  pending?: string;
  generation?: string;
  removing?: string;
  removed?: boolean;
  archive?: string;
};
async function checkPlugins(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  let output: unknown;
  try {
    output = JSON.parse(
      await commandOutput("codex", ["plugin", "list", "--json"], env, 60000, 4 * 1024 * 1024, signal),
    );
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Cannot inspect Codex plugins; no hooks were installed. Check 'codex plugin list --json' and retry.",
    );
  }
  const installed = (output as { installed?: unknown })?.installed;
  if (
    !Array.isArray(installed) ||
    installed.some((item) => !item || typeof item !== "object" || typeof item.name !== "string")
  )
    throw new Error("Cannot interpret Codex plugin list; no hooks were installed.");
  if (
    installed.some((item) =>
      ["git-relay", "worktree-relay", "pi-git-worktree", "worktree-sync"].includes(item.name.toLowerCase()),
    )
  )
    throw new Error("A GitRelay-compatible Codex plugin is already installed; preserve it and avoid duplicate hooks.");
}

export async function codexDirectory(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = resolve(env.CODEX_HOME || join(homedir(), ".codex"));
  async function canonical(dir: string): Promise<string> {
    try {
      return await realpath(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await lstat(dir);
        throw new Error(`Cannot resolve existing path: ${dir}`);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
      const parent = dirname(dir);
      if (parent === dir) throw error;
      return join(await canonical(parent), basename(dir));
    }
  }
  return canonical(path);
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

async function sameFile(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([lstat(a), lstat(b)]);
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function hookContent(workspace: string, nodePath: string): string {
  const command = `${quote(nodePath)} ${quote(join(workspace, "codex-current.mjs"))} hook codex --branch-status`;
  return `${JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 60 }] }]])) }, null, 2)}\n`;
}

const legacyBootstrap = `import { readFile, readdir } from "node:fs/promises";\nconst state = JSON.parse(await readFile(new URL("./codex-hooks.json", import.meta.url), "utf8"));\nconst revisions = (await readdir(new URL("./codex-revisions/", import.meta.url))).sort();\nconst revision = revisions.at(-1);\nif (!revision || !/^\\d{20}-[a-f0-9]{64}$/.test(revision) || (revision !== state.current && revision !== state.pending)) throw new Error("Invalid GitRelay Codex revision");\nawait import(new URL("./runtimes/" + revision.slice(21) + "/dist/cli/main.js", import.meta.url));\n`;
const bootstrap = legacyBootstrap
  .replace(
    "const revision = revisions.at(-1);",
    "const revision = [state.pending, state.current].find((value) => revisions.includes(value));",
  )
  .replace("if (!revision", "if (state.removed || !revision");

export function validCodexRecord(value: unknown, entry: string, root: string): value is Record {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record;
  const revision = (item: unknown) => typeof item === "string" && /^\d{20}-[a-f0-9]{64}$/.test(item);
  const archive = (item: unknown) =>
    item === undefined ||
    (typeof item === "string" &&
      dirname(dirname(item)) === dirname(entry) &&
      /^\.git-relay-codex-removed-[a-zA-Z0-9]+$/.test(basename(dirname(item))) &&
      basename(item) === "hooks.json");
  return (
    typeof record.nodePath === "string" &&
    isAbsolute(record.nodePath) &&
    !record.nodePath.includes("\0") &&
    record.entry === entry &&
    record.content === hookContent(root, record.nodePath) &&
    typeof record.anchor === "string" &&
    /^\.git-relay-codex-anchor-[0-9a-f-]{36}$/.test(record.anchor) &&
    (record.current === null || revision(record.current)) &&
    (record.pending === undefined || revision(record.pending)) &&
    (record.generation === undefined ||
      (typeof record.generation === "string" && /^[0-9a-f-]{36}$/.test(record.generation))) &&
    (record.removed === undefined || typeof record.removed === "boolean") &&
    archive(record.removing) &&
    archive(record.archive)
  );
}

const digest = (dir: string, signal?: AbortSignal) => installerDigest(dir, signal);

export async function installCodex({
  workspace,
  sourceRoot,
  env = process.env,
  signal,
  clientVersion,
}: Options): Promise<void> {
  if (process.platform === "win32") throw new Error("Automatic Codex hooks installation is not supported on Windows.");
  signal?.throwIfAborted();
  await checkWorkspace(workspace);
  const home = await codexDirectory(env);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await checkPlugins(env, signal);
  await checkInlineHooks(home, signal, clientVersion);
  let newlyPublished = false;
  const generation = randomUUID();
  await withLock(
    join(workspace, "codex-hooks.lock"),
    async () => {
      const state = join(workspace, "codex-hooks.json"),
        entry = join(home, "hooks.json");
      if ((await readJson(join(workspace, "codex-install.json"))) !== undefined)
        throw new Error("A previous Codex plugin installation record exists; inspect it before installing hooks.");
      const record = (await readInstallationRecord(state, "Codex")) as Record | undefined;
      if (record !== undefined && !validCodexRecord(record, entry, workspace))
        throw new Error(`Invalid Codex installation record: ${state}`);
      if (record?.removing) throw new Error("An uninstall is incomplete; rerun uninstall before installing.");
      const nodePath = record && !record.removed ? record.nodePath : process.execPath;
      if (record && !record.removed) {
        try {
          await access(nodePath, constants.X_OK);
          const stdout = await commandOutput(nodePath, ["--version"], env, 5000, 4096, signal);
          const version = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(stdout);
          if (!version || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 19))
            throw new Error("Unsupported Node version");
        } catch {
          signal?.throwIfAborted();
          throw new Error(
            `Codex hook's Node executable is unavailable or incompatible: ${nodePath}; uninstall and reinstall to use the current Node, then review /hooks again.`,
          );
        }
      }
      const actual = await contents(entry);
      if ((!record || record.removed) && actual !== undefined)
        throw new Error(`Codex hooks already exist and are not owned; preserved: ${entry}`);
      const oldAnchor = record && !record.removed ? join(home, record.anchor) : undefined;
      if (
        record &&
        !record.removed &&
        ((await contents(oldAnchor!)) !== record.content ||
          (actual !== undefined && (actual !== record.content || !(await sameFile(entry, oldAnchor!)))))
      )
        throw new Error(`Codex hooks ownership cannot be established; preserved: ${entry}`);
      const pointer = join(workspace, "codex-current.mjs"),
        pointerActual = await contents(pointer);
      if (
        pointerActual !== undefined &&
        (!record || (pointerActual !== bootstrap && pointerActual !== legacyBootstrap))
      )
        throw new Error(`Codex bootstrap was modified; preserved: ${pointer}`);
      const revisions = join(workspace, "codex-revisions");
      await mkdir(revisions, { recursive: true });
      const names = (await readdir(revisions)).sort();
      if (names.some((name) => !/^\d{20}-[a-f0-9]{64}$/.test(name)))
        throw new Error(`Unexpected Codex revision; preserved: ${revisions}`);
      for (const name of names)
        if ((await contents(join(revisions, name))) !== "")
          throw new Error(`Codex revision was modified: ${join(revisions, name)}`);
      const latest = names.at(-1);
      if (
        (!record && latest) ||
        (record && (latest ?? null) !== (record.pending ?? record.current) && (latest ?? null) !== record.current)
      )
        throw new Error(`Codex revisions changed outside GitRelay: ${revisions}`);
      const source = join(sourceRoot, "dist"),
        id = await digest(source, signal);
      if (latest) {
        const existing = join(workspace, "runtimes", latest.slice(21));
        const existingDigest = await digest(join(existing, "dist"), signal);
        if (
          (existingDigest !== latest.slice(21) &&
            existingDigest !== id &&
            !(await matchesLegacyInstallerDigest(join(existing, "dist"), latest.slice(21), signal))) ||
          (await contents(join(existing, "package.json"))) !== '{"type":"module"}\n'
        )
          throw new Error(
            `Codex runtime was modified or its legacy digest cannot be verified; preserved: ${existing}. Retry with the original LC_ALL/LANG if known.`,
          );
      }
      const runtimes = join(workspace, "runtimes"),
        runtime = join(runtimes, id);
      await mkdir(runtimes, { recursive: true });
      try {
        if (
          (await digest(join(runtime, "dist"), signal)) !== id ||
          (await contents(join(runtime, "package.json"))) !== '{"type":"module"}\n'
        )
          throw new Error(`Codex runtime was modified: ${runtime}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const existing = await lstat(runtime).catch((failure) => {
          if (failure.code === "ENOENT") return undefined;
          throw failure;
        });
        if (existing)
          throw new Error(`Codex runtime is incomplete or was modified; preserved: ${runtime}`, { cause: error });
        const temp = await mkdtemp(join(runtimes, ".stage-"));
        try {
          await cp(source, join(temp, "dist"), { recursive: true });
          if ((await digest(join(temp, "dist"), signal)) !== id)
            throw new Error("Runtime changed while copying; retry installation.");
          await writeFile(join(temp, "package.json"), '{"type":"module"}\n', { flag: "wx" });
          try {
            await rename(temp, runtime);
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            if (
              (await digest(join(runtime, "dist"), signal)) !== id ||
              (await contents(join(runtime, "package.json"))) !== '{"type":"module"}\n'
            )
              throw new Error(`Codex runtime was modified: ${runtime}`);
          }
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
      try {
        const checked = await commandOutput(
          nodePath,
          [join(runtime, "dist", "cli", "main.js"), "--help"],
          env,
          5000,
          64 * 1024,
          signal,
        );
        if (!checked.includes("git-relay hook")) throw new Error("Invalid CLI output");
      } catch {
        signal?.throwIfAborted();
        throw new Error(
          `Codex runtime cannot run with ${nodePath}; check the runtime or uninstall and reinstall, then review /hooks again.`,
        );
      }
      const desired = latest?.endsWith(`-${id}`)
        ? latest
        : `${String(BigInt(latest?.slice(0, 20) ?? "0") + 1n).padStart(20, "0")}-${id}`;
      if (!/^\d{20}-[a-f0-9]{64}$/.test(desired)) throw new Error("Codex revision counter exhausted.");
      const content = hookContent(workspace, nodePath),
        anchor = record && !record.removed ? record.anchor : `.git-relay-codex-anchor-${randomUUID()}`;
      if (!record || record.removed) {
        await mkdir(home, { recursive: true });
        await writeFile(join(home, anchor), content, { flag: "wx", mode: 0o600 });
      }
      await writeJson(state, {
        entry,
        content,
        anchor,
        nodePath,
        current: latest ?? null,
        pending: desired,
        generation,
      });
      if (latest !== desired) await writeFile(join(revisions, desired), "", { flag: "wx", mode: 0o600 });
      await publishBootstrap(pointer, pointerActual, bootstrap);
      if (actual === undefined) {
        await link(join(home, anchor), entry);
        newlyPublished = true;
      }
      await writeJson(state, { entry, content, anchor, nodePath, current: desired, generation });
    },
    { waitMs: 100, signal },
  );
  try {
    await checkPlugins(env, signal);
    await checkInlineHooks(home, signal, clientVersion);
  } catch (error) {
    if (!newlyPublished) {
      signal?.throwIfAborted();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; existing GitRelay hooks were preserved, and another source may duplicate them.`,
      );
    }
    let archive: string | undefined;
    try {
      archive = await uninstallCodexInternal({ workspace, env }, generation);
    } catch (cleanup) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; unable to withdraw hooks safely: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
      );
    }
    signal?.throwIfAborted();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; GitRelay hooks were withdrawn${archive ? ` and preserved at ${archive}` : ""}.`,
    );
  }
}

export async function uninstallCodex(options: Omit<Options, "sourceRoot">): Promise<string | undefined> {
  return uninstallCodexInternal(options);
}

async function uninstallCodexInternal(
  { workspace, env = process.env, signal }: Omit<Options, "sourceRoot">,
  expectedGeneration?: string,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (process.platform === "win32") throw new Error("Automatic Codex hooks uninstall is not supported on Windows.");
  await checkWorkspace(workspace);
  const home = await codexDirectory(env);
  signal?.throwIfAborted();
  return withLock(
    join(workspace, "codex-hooks.lock"),
    async () => {
      const state = join(workspace, "codex-hooks.json"),
        entry = join(home, "hooks.json");
      const record = (await readInstallationRecord(state, "Codex")) as Record | undefined;
      if (record === undefined) {
        if (expectedGeneration !== undefined)
          throw new Error("Codex installation record is missing; hooks preserved for inspection.");
        return;
      }
      if (!validCodexRecord(record, entry, workspace)) throw new Error(`Invalid Codex installation record: ${state}`);
      if (expectedGeneration !== undefined && record.generation !== expectedGeneration)
        throw new Error("Codex hooks changed after installation; newer installation preserved.");
      if (record.removed) {
        if (expectedGeneration !== undefined && (await contents(entry)) !== undefined)
          throw new Error(`Codex hooks were recreated; preserved: ${entry}`);
        return record.archive;
      }
      const actual = await contents(entry),
        anchor = join(home, record.anchor);
      if (record.removing && actual !== undefined && (await contents(record.removing)) !== undefined)
        throw new Error(`Uninstall interrupted; preserve both ${entry} and ${record.removing} for inspection.`);
      const anchorContent = await contents(anchor);
      if (
        (anchorContent !== record.content &&
          !(anchorContent === undefined && actual === undefined && !record.removing)) ||
        (actual !== undefined && (actual !== record.content || !(await sameFile(entry, anchor))))
      )
        throw new Error(`Codex hooks ownership cannot be established; preserved: ${entry}`);
      let archive = record.removing;
      if (!archive && actual !== undefined) {
        const directory = await mkdtemp(join(home, ".git-relay-codex-removed-"));
        archive = join(directory, "hooks.json");
        signal?.throwIfAborted();
        await writeJson(state, { ...record, removing: archive }, signal ? () => signal.throwIfAborted() : undefined);
        signal?.throwIfAborted();
        await rename(entry, archive);
      } else if (archive && actual !== undefined) {
        signal?.throwIfAborted();
        await rename(entry, archive);
      }
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
          throw new Error(`Codex hooks changed during uninstall; preserved at ${archive} and possibly ${entry}.`);
        }
      }
      signal?.throwIfAborted();
      await writeJson(
        state,
        {
          entry,
          content: record.content,
          anchor: record.anchor,
          nodePath: record.nodePath,
          current: record.current,
          pending: record.pending,
          generation: record.generation,
          removed: true,
          archive,
        },
        signal ? () => signal.throwIfAborted() : undefined,
      );
      return archive;
    },
    { waitMs: 100, signal },
  );
}
