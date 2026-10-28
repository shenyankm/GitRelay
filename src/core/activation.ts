import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sessionKey, type Identity } from "./mailbox.ts";
import { checkStateDirectory, readJson, stateDirectory, writeJson } from "./store.ts";
import { watchRoot } from "./changes.ts";
import { GitPathOutputError } from "./git.ts";
import { preflightLeaveSession } from "./sessions.ts";

type ActivationOptions = Identity & { cwd: string; ref: string; signal?: AbortSignal };

/** Conservative request matching: quoted examples and questions are not opt-ins. */
export function requestedActivation(prompt: unknown): boolean | undefined {
  if (typeof prompt !== "string") return;
  let fence: string | undefined;
  let fenceIndent = 0;
  let inlineCode = false;
  const columns = (value: string) =>
    [...value].reduce((width, char) => width + (char === "\t" ? 4 - (width % 4) : 1), 0);
  const text = prompt
    .split("\n")
    .map((line) => {
      if (fence && fenceIndent && line.trim() && columns(line.match(/^[ \t]*/)![0]) < fenceIndent) fence = undefined;
      if (fence) {
        const closing = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
        if (
          closing &&
          columns(closing[1]) <= fenceIndent + 3 &&
          closing[2][0] === fence[0] &&
          closing[2].length >= fence.length &&
          !closing[3].trim()
        )
          fence = undefined;
        return "";
      }
      const marker = line.match(/^( {0,3})((?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/);
      if (marker && (marker[3][0] !== "`" || !marker[4].includes("`"))) {
        fence = marker[3];
        fenceIndent = marker[2] ? columns(marker[1] + marker[2]) : 0;
        return "";
      }
      if (columns(line.match(/^[ \t]*/)![0]) >= 4) {
        // Keep delimiters that close a multiline example.
        return line.replace(/[^“”「」`]/g, "").replace(/`/g, () => {
          if (!inlineCode) return "";
          inlineCode = false;
          return "`";
        });
      }
      for (const char of line) if (char === "`") inlineCode = !inlineCode;
      return line;
    })
    .join("\n")
    .replace(/```[^]*?(?:```|$)/g, "")
    .replace(/`[^`]*`|"[^"\n]*"|“[^”]*”|「[^」]*」/g, "");
  let requested: boolean | undefined;
  for (const line of text.split(/[\n。；;]/)) {
    const request = line.trim();
    if (
      !request ||
      /^[>"'“「]/.test(request) ||
      /[?？]|(?:解释|介绍|说明|例如|比如|假如|如果|能否|是否)|\b(?:explain|describe|example|whether|if)\b/i.test(
        request,
      )
    )
      continue;
    const target =
      /git-?relay|并行(?:开发|实现|编码)|多(?:个)?工作树|多\s*worktrees?|\bin parallel\b|\bparallel (?:development|coding|implementation)\b|\b(?:multiple\s+|multi[ -])worktrees?\b/i;
    if (!target.test(request)) continue;
    if (
      /^(?:请)?(?:不要|别)(?:关闭|停用|禁用|停止)|^(?:please\s+)?(?:do not|don't|never)\s+(?:disable|deactivate|stop|turn off)\b/i.test(
        request,
      )
    )
      continue;
    if (
      /^(?:(?:请|麻烦|这次|本次|现在)\s*)*(?:不要|别|无需|停止|关闭|停用|禁用)|^(?:please\s+)?(?:(?:disable|deactivate|stop|turn off)\b|(?:do not|don't|never)\s+(?:(?:use|enable|activate|turn on|start)\b|(?:develop|implement|code|work)\b.{0,60}\bin parallel\b))/i.test(
        request,
      )
    ) {
      requested = false;
      continue;
    }
    if (/不要|无需|不需要|不使用|不开启|不启用|不并行|\b(?:not|without|never)\b/i.test(request)) continue;
    if (
      /^(?:(?:请|麻烦|帮我|这次|本次|现在|接下来|我们|我要|我想|希望|需要|要)\s*)*(?:(?:启用|开启|启动|使用|用)\s*git-?relay\b|(?:(?:使用|用|采用|进行|开始|安排)\s*)?并行(?:开发|实现|编码)|(?:使用|用|采用|创建|建立|在)?\s*(?:多(?:个)?工作树|多\s*worktrees?).{0,24}(?:开发|实现|协作|并行))|^(?:please\s+)?(?:(?:enable|activate|turn on|use|start)\s+(?:git-?relay\b|parallel (?:development|coding|implementation)\b|(?:multiple\s+|multi[ -])worktrees?\b)|(?:develop|implement|code|work)\b.{0,60}\bin parallel\b)/i.test(
        request,
      )
    )
      requested = true;
  }
  return requested;
}

/** Read-only until an explicit opt-in/out; no Git is needed without a candidate activation. */
export async function sessionActivation(
  options: ActivationOptions,
  enabled?: boolean,
  checked?: Awaited<ReturnType<typeof preflightLeaveSession>>,
): Promise<boolean> {
  options.signal?.throwIfAborted();
  const optOut = enabled === false ? (checked ?? (await preflightLeaveSession(options))) : undefined;
  const directory = join(stateDirectory(), "activations");
  await checkStateDirectory(directory, true);
  const read = async (root: string) => {
    const key = sessionKey({ root }, options, options.ref);
    const path = join(directory, `${key}.json`);
    const current = (await readJson(path, true)) as { key?: unknown; enabled?: unknown } | undefined;
    if (current !== undefined && (!current || current.key !== key || typeof current.enabled !== "boolean"))
      throw new Error(`Invalid GitRelay activation: ${path}; preserve it for inspection.`);
    return { key, path, current };
  };
  const cwd = await realpath(resolve(options.cwd)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return resolve(options.cwd);
    throw error;
  });
  const selected = process.env.GIT_WORK_TREE
    ? await realpath(resolve(cwd, process.env.GIT_WORK_TREE)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  const worktreeRoot = async () =>
    watchRoot(cwd, options.signal)
      .then((root) => realpath(resolve(root)))
      .catch(async (error: Error & { cause?: { code?: number } }) => {
        options.signal?.throwIfAborted();
        // shortcut: Git exit 128 also covers damaged repositories; distinguish discovery failures when Git can do so reliably.
        if (!(error instanceof GitPathOutputError) && error.cause?.code === 128) {
          if (selected && selected !== cwd && (await read(selected)).current?.enabled === true) throw error;
          let parent = dirname(cwd);
          while (parent !== cwd) {
            if ((await read(parent)).current?.enabled === true) throw error;
            const next = dirname(parent);
            if (next === parent) break;
            parent = next;
          }
          return cwd;
        }
        throw error;
      });
  if (enabled === undefined) {
    if (process.env.GIT_WORK_TREE) {
      if (selected && (await read(selected)).current?.enabled === true) {
        const root = await worktreeRoot();
        return root === selected && (await read(root)).current?.enabled === true;
      }
      if (!(await read(cwd)).current?.enabled) return false;
    }
    let candidate = cwd;
    while (true) {
      options.signal?.throwIfAborted();
      if ((await read(candidate)).current?.enabled === true) {
        const root = await worktreeRoot();
        const canonical = (await read(root)).current;
        return canonical !== undefined ? canonical.enabled === true : candidate === cwd;
      }
      const marker = await lstat(join(candidate, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      });
      if (marker) return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
  let root: string;
  if (optOut?.root) root = await realpath(resolve(optOut.root));
  else if (optOut) {
    await worktreeRoot();
    const current = await preflightLeaveSession(options);
    if (current.root || current.repositoryId !== optOut.repositoryId)
      throw new Error("GitRelay target changed during opt-out; preserve state and retry.");
    root = cwd;
  } else root = await worktreeRoot();
  const { key, path, current } = await read(root);
  if (current?.enabled === enabled) return current?.enabled === true;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkStateDirectory(directory);
  await writeJson(path, { key, enabled }, () => options.signal?.throwIfAborted());
  return enabled;
}
