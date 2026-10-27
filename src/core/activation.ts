import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sessionKey, type Identity } from "./mailbox.ts";
import { checkStateDirectory, readJson, stateDirectory, writeJson } from "./store.ts";

type ActivationOptions = Identity & { cwd: string; ref: string; signal?: AbortSignal };

/** Conservative request matching: quoted examples and questions are not opt-ins. */
export function requestedActivation(prompt: unknown): boolean | undefined {
  if (typeof prompt !== "string") return;
  const text = prompt.replace(/```[^]*?(?:```|$)/g, "").replace(/`[^`]*`|"[^"\n]*"|“[^”]*”|「[^」]*」/g, "");
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

/** Read-only until an explicit opt-in/out; does not discover Git or create repository state. */
export async function sessionActivation(options: ActivationOptions, enabled?: boolean): Promise<boolean> {
  options.signal?.throwIfAborted();
  const key = sessionKey({ root: resolve(options.cwd) }, options, options.ref);
  const directory = join(stateDirectory(), "activations");
  await checkStateDirectory(directory, true);
  const path = join(directory, `${key}.json`);
  const current = (await readJson(path, true)) as { key?: unknown; enabled?: unknown } | undefined;
  if (current !== undefined && (!current || current.key !== key || typeof current.enabled !== "boolean"))
    throw new Error(`Invalid GitRelay activation: ${path}; preserve it for inspection.`);
  if (enabled === undefined || current?.enabled === enabled) return current?.enabled === true;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkStateDirectory(directory);
  await writeJson(path, { key, enabled }, () => options.signal?.throwIfAborted());
  return enabled;
}
