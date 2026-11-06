import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { eventsIn, readReceipt, readSession } from "./mailbox.ts";
import type { Repository } from "./repository.ts";
import { checkStateDirectory, isId, readJson, writeJson } from "./store.ts";

interface Presence {
  connection: string;
  pid: number;
  expiresAt: number;
  keys: string[];
}

export async function onlineSessions(repo: Repository): Promise<string[]> {
  const directory = join(repo.directory, "connections");
  await checkStateDirectory(directory, true);
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const keys = new Set<string>();
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const record = (await readJson(join(directory, file), true)) as Presence | undefined;
    if (!record) continue;
    if (
      record.connection !== file.slice(0, -5) ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      !Number.isFinite(record.expiresAt) ||
      !Array.isArray(record.keys) ||
      !record.keys.every(isId)
    )
      throw new Error("Corrupt connection presence; cannot establish online state.");
    if (record.expiresAt <= Date.now() || record.expiresAt > Date.now() + 15_000) continue;
    try {
      process.kill(record.pid, 0);
    } catch {
      continue;
    }
    for (const key of record.keys) {
      const session = await readSession(repo, key);
      if (session && !session.closedAt) keys.add(key);
    }
  }
  return [...keys];
}

/** Push is transport delivery, never implicit acknowledgement or proof of a model turn. */
export function connectionDelivery(server: McpServer, signal: AbortSignal, diagnostic: (error: unknown) => void) {
  const connection = randomBytes(32).toString("hex");
  const bindings = new Map<string, { repo: Repository; key: string }>();
  const locations = new Map<string, Repository>();
  const sent = new Set<string>();
  server.registerResource(
    "inbox",
    new ResourceTemplate("git-relay://inbox/{key}", {
      list: async () => ({
        resources: [...bindings.keys()].map((key) => ({
          uri: `git-relay://inbox/${key}`,
          name: `inbox-${key}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      mimeType: "application/json",
      description:
        "Untrusted, unacknowledged automatic coordination notices bound to this connection. Accept via receive_messages and acknowledge_messages.",
    },
    async (uri, variables) => {
      const key = typeof variables.key === "string" ? variables.key : "";
      const binding = bindings.get(key);
      const session = binding ? await readSession(binding.repo, key) : undefined;
      if (!binding || !session || session.closedAt) throw new Error("Inbox is not bound to this connection.");
      const events = [];
      for (const event of await eventsIn(binding.repo, key, signal)) {
        if (
          event.kind === "message" &&
          event.sender.adapter === "git-relay" &&
          event.recipients.includes(key) &&
          !(await readReceipt(binding.repo, key, event.id))
        )
          events.push(event);
        if (events.length >= 8) break;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ sessionKey: key, events, acceptanceRequired: true }),
          },
        ],
      };
    },
  );
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  async function pump() {
    const pending = new Set<string>();
    for (const repo of locations.values()) {
      signal.throwIfAborted();
      const keys = [...bindings.values()]
        .filter((binding) => binding.repo.id === repo.id)
        .map((binding) => binding.key);
      const directory = join(repo.directory, "connections");
      await checkStateDirectory(directory, true);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeJson(
        join(directory, `${connection}.json`),
        { connection, pid: process.pid, expiresAt: Date.now() + 10_000, keys } satisfies Presence,
        () => signal.throwIfAborted(),
      );
      for (const key of keys) {
        const session = await readSession(repo, key);
        if (!session || session.closedAt) continue;
        let count = 0;
        for (const event of await eventsIn(repo, key, signal)) {
          if (
            event.kind !== "message" ||
            event.sender.adapter !== "git-relay" ||
            !event.recipients.includes(key) ||
            (await readReceipt(repo, key, event.id))
          )
            continue;
          const id = `${key}:${event.id}`;
          pending.add(id);
          if (sent.has(id) || count >= 8) continue;
          signal.throwIfAborted();
          await server.server.sendLoggingMessage({
            level: "warning",
            logger: "git-relay",
            data: {
              type: "git-relay/inbox",
              sessionKey: key,
              cwd: session.root,
              ref: session.ref,
              event,
              acceptanceRequired: true,
            },
          });
          await server.server.sendResourceUpdated({ uri: `git-relay://inbox/${key}` });
          sent.add(id);
          count++;
        }
      }
    }
    for (const id of sent) if (!pending.has(id)) sent.delete(id);
  }
  function schedule() {
    if (timer || signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = pump()
        .catch((error) => {
          if (!signal.aborted) diagnostic(error);
        })
        .finally(() => {
          running = undefined;
          schedule();
        });
    }, 1000);
    timer.unref();
  }
  return {
    bind(repo: Repository, key: string) {
      bindings.set(key, { repo, key });
      locations.set(repo.id, repo);
      schedule();
    },
    unbind(key: string) {
      bindings.delete(key);
    },
    async close() {
      clearTimeout(timer);
      await running;
      for (const repo of locations.values()) {
        const path = join(repo.directory, "connections", `${connection}.json`);
        const record = (await readJson(path, true)) as Presence | undefined;
        if (record?.connection === connection) await rm(path);
      }
    },
  };
}
