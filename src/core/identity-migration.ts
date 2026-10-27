import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, link, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { checkStateDirectory, hash, isId, withLock, writeExclusiveTemporary } from "./store.ts";
import { validateEvent } from "./mailbox.ts";

interface MigrationOptions {
  common: string;
  oldDirectory: string;
  newDirectory: string;
  newId: string;
  identity: string;
  identitySource: "marker" | "external";
  signal?: AbortSignal;
}

const filename = /^[a-f0-9]{64}\.json$/;
const folders = ["sessions", "events", "receipts", "refs", "trash"] as const;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function directory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Legacy state is not a directory: ${path}`);
}

/** Read one bounded, stable regular file without following a symbolic link. */
async function readState(path: string): Promise<{ data: Buffer; value: unknown }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat(),
      named = await lstat(path);
    if (
      !before.isFile() ||
      !named.isFile() ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size > 2 * 1024 * 1024
    )
      throw new Error(`Invalid legacy state file: ${path}`);
    const parts: Buffer[] = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, 2 * 1024 * 1024 + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > 2 * 1024 * 1024) throw new Error(`Legacy state file exceeds 2 MiB: ${path}`);
      parts.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat(),
      current = await lstat(path);
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      size !== before.size
    )
      throw new Error(`Legacy state changed during migration: ${path}`);
    const data = Buffer.concat(parts, size);
    return { data, value: JSON.parse(decoder.decode(data)) };
  } finally {
    await file.close();
  }
}

/** Caller owns the new identity lifecycle lock; old clients must be stopped before and after migration. */
export async function migrateLegacyState(
  options: MigrationOptions,
): Promise<{ source: string; target: string; alreadyMigrated?: true }> {
  const { common, oldDirectory, newDirectory, newId, identity, identitySource, signal } = options;
  if (
    !isId(identity) ||
    newId !== hash([common, identity]) ||
    !["marker", "external"].includes(identitySource) ||
    basename(oldDirectory) !== hash(common) ||
    basename(newDirectory) !== newId ||
    dirname(oldDirectory) !== dirname(newDirectory)
  )
    throw new Error("Invalid legacy migration identity or directories.");
  signal?.throwIfAborted();
  await checkStateDirectory(dirname(newDirectory));
  await checkStateDirectory(join(dirname(dirname(newDirectory)), "identity-migration-claims"), true);
  await directory(oldDirectory);
  const alreadyMigrated = await withLock(
    join(oldDirectory, "publish.lock"),
    async () => {
      const metadata = (await readState(join(oldDirectory, "repo.json"))).value as { id?: unknown; common?: unknown };
      if (
        !metadata ||
        metadata.id !== hash(common) ||
        metadata.common !== common ||
        Object.keys(metadata).some((key) => key !== "id" && key !== "common")
      )
        throw new Error("Legacy repository metadata does not match; source preserved.");
      const rootNames = await readdir(oldDirectory);
      if (
        rootNames.some(
          (name) =>
            name !== "repo.json" && name !== "publish.lock" && !folders.includes(name as (typeof folders)[number]),
        )
      )
        throw new Error("Unexpected legacy repository state; source preserved.");
      const files: string[] = [],
        sessionKeys = new Set<string>(),
        receiptDirectories: string[] = [];
      const entries = new Map<string, string[]>();
      for (const folder of folders) {
        signal?.throwIfAborted();
        const source = join(oldDirectory, folder);
        try {
          await directory(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const names = (await readdir(source)).sort();
        entries.set(folder, names);
        for (const name of names) {
          signal?.throwIfAborted();
          if (folder === "receipts") {
            if (!isId(name)) throw new Error(`Unexpected legacy receipt entry: ${name}`);
            sessionKeys.add(name);
            receiptDirectories.push(name);
            await directory(join(source, name));
            const receipts = (await readdir(join(source, name))).sort();
            entries.set(join(folder, name), receipts);
            for (const receipt of receipts) {
              if (!filename.test(receipt)) throw new Error(`Unexpected legacy receipt: ${receipt}`);
              files.push(join(folder, name, receipt));
            }
          } else {
            if (!filename.test(name)) throw new Error(`Unexpected legacy ${folder} entry: ${name}`);
            files.push(join(folder, name));
            if (folder === "sessions") sessionKeys.add(name.slice(0, -5));
            if (folder === "events" || folder === "trash") {
              const event = validateEvent((await readState(join(source, name))).value, name.slice(0, -5));
              for (const key of event.recipients) sessionKeys.add(key);
            }
          }
        }
      }
      for (const key of [...sessionKeys].sort()) {
        signal?.throwIfAborted();
        await withLock(join(oldDirectory, "sessions", `${key}.lock`), async () => {}, { signal });
      }
      signal?.throwIfAborted();
      // One old inbox may only be claimed by one new identity, even across restarts.
      const claims = join(dirname(dirname(newDirectory)), "identity-migration-claims");
      await mkdir(claims, { recursive: true, mode: 0o700 });
      const legacy = hash(common),
        claim = join(claims, `${legacy}.json`);
      const publishing = join(claims, `${legacy}.publishing.json`),
        completed = join(claims, `${legacy}.completed.json`);
      const claimData = Buffer.from(JSON.stringify({ common, newId }));
      const ownerData = Buffer.from(JSON.stringify({ id: newId }));
      const provenanceData = Buffer.from(JSON.stringify({ legacy, id: newId }));
      const repoData = Buffer.from(JSON.stringify({ id: newId, common, identity, identitySource }));
      const exists = async (path: string) =>
        !!(await lstat(path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }));
      // Complete bytes are published without ever replacing an existing path.
      const publish = async (path: string, data: Buffer) => {
        if (await exists(path)) {
          if (!(await readState(path)).data.equals(data))
            throw new Error(`Migration state conflicts with existing file: ${path}`);
          return;
        }
        const temporary = join(claims, `.${randomUUID()}.tmp`);
        await writeExclusiveTemporary(temporary, data);
        try {
          try {
            await link(temporary, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EXDEV")
              throw new Error(
                "Migration state directories must be on the same filesystem; incomplete state preserved.",
                { cause: error },
              );
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readState(path)).data.equals(data))
              throw error;
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
      };
      const hadClaim = await exists(claim);
      if (hadClaim && !(await readState(claim)).data.equals(claimData))
        throw new Error(`Legacy state was already claimed by another identity: ${claim}`);
      if (!hadClaim && ((await exists(publishing)) || (await exists(completed))))
        throw new Error(`Migration claim is missing; inspect without deleting state: ${claim}`);
      if (!hadClaim && (await exists(newDirectory)))
        throw Object.assign(new Error(`Migration target already exists: ${newDirectory}`), { code: "EEXIST" });
      await publish(claim, claimData);
      if (await exists(completed)) {
        if (!(await readState(completed)).data.equals(claimData))
          throw new Error(`Invalid completed migration claim: ${completed}`);
        try {
          if (!(await readState(publishing)).data.equals(claimData))
            throw new Error("Invalid publishing migration claim.");
          await directory(newDirectory);
          for (const [name, data] of [
            ["identity-owner.json", ownerData],
            ["identity-ready.json", ownerData],
            ["identity-migration.json", provenanceData],
            ["repo.json", repoData],
          ] as const) {
            if (!(await readState(join(newDirectory, name))).data.equals(data))
              throw new Error(`Migration target metadata differs: ${name}`);
          }
          return true;
        } catch (error) {
          throw new Error(
            `Completed migration target is missing or changed; inspect before recovery: ${newDirectory}`,
            { cause: error },
          );
        }
      }
      if ((await exists(publishing)) && !(await readState(publishing)).data.equals(claimData))
        throw new Error(`Invalid publishing migration claim: ${publishing}`);
      signal?.throwIfAborted();
      if (!(await exists(newDirectory))) await mkdir(newDirectory, { mode: 0o700 });
      else {
        await directory(newDirectory);
        if (!(await exists(join(newDirectory, "identity-owner.json"))) && (await readdir(newDirectory)).length > 0)
          throw new Error(`Unowned incomplete migration target; inspect without deleting data: ${newDirectory}`);
      }
      await publish(join(newDirectory, "identity-owner.json"), ownerData);
      const allowedRoot = new Set<string>([
        ...folders,
        "identity-owner.json",
        "identity-ready.json",
        "identity-migration.json",
        "repo.json",
      ]);
      for (const name of await readdir(newDirectory))
        if (!allowedRoot.has(name)) throw new Error(`Unexpected migration target entry: ${name}`);
      if (
        (await exists(join(newDirectory, "identity-ready.json"))) &&
        !(await exists(join(newDirectory, "identity-migration.json")))
      )
        throw new Error("Existing ready state is not a migration target; inspect it before continuing.");
      for (const folder of folders) {
        const target = join(newDirectory, folder);
        if (!(await exists(target))) await mkdir(target, { mode: 0o700 });
        else await directory(target);
        const allowed = new Set(
          folder === "receipts"
            ? receiptDirectories
            : files.filter((file) => dirname(file) === folder).map((file) => basename(file)),
        );
        for (const name of await readdir(target))
          if (!allowed.has(name)) throw new Error(`Unexpected migration target entry: ${folder}/${name}`);
      }
      for (const name of receiptDirectories) {
        const target = join(newDirectory, "receipts", name);
        if (!(await exists(target))) await mkdir(target, { mode: 0o700 });
        else await directory(target);
        const allowed = new Set(
          files.filter((file) => dirname(file) === join("receipts", name)).map((file) => basename(file)),
        );
        for (const file of await readdir(target))
          if (!allowed.has(file)) throw new Error(`Unexpected migration target receipt: ${name}/${file}`);
      }
      const fingerprints = new Map<string, string>();
      for (const relative of files) {
        signal?.throwIfAborted();
        const { data } = await readState(join(oldDirectory, relative));
        fingerprints.set(relative, createHash("sha256").update(data).digest("hex"));
        const target = join(newDirectory, relative);
        await publish(target, data);
      }
      // A changed directory or file means an old writer may have resumed.
      const checkEntries = async () => {
        if (JSON.stringify((await readdir(oldDirectory)).sort()) !== JSON.stringify(rootNames.sort()))
          throw new Error("Legacy root changed during migration; incomplete target preserved.");
        for (const [relative, names] of entries) {
          await directory(join(oldDirectory, relative));
          if (JSON.stringify((await readdir(join(oldDirectory, relative))).sort()) !== JSON.stringify(names))
            throw new Error(`Legacy state changed during migration: ${relative}`);
        }
      };
      await checkEntries();
      for (const [relative, fingerprint] of fingerprints) {
        signal?.throwIfAborted();
        const { data } = await readState(join(oldDirectory, relative));
        if (createHash("sha256").update(data).digest("hex") !== fingerprint)
          throw new Error(`Legacy state changed during migration: ${relative}`);
      }
      const finalMetadata = (await readState(join(oldDirectory, "repo.json"))).value;
      if (JSON.stringify(finalMetadata) !== JSON.stringify(metadata))
        throw new Error("Legacy repository metadata changed during migration.");
      await checkEntries();
      await publish(join(newDirectory, "repo.json"), repoData);
      await publish(join(newDirectory, "identity-migration.json"), provenanceData);
      await publish(publishing, claimData);
      signal?.throwIfAborted();
      await publish(join(newDirectory, "identity-ready.json"), ownerData);
      // Consumers cannot enter until the migration-specific completion record exists.
      await publish(completed, claimData);
      return false;
    },
    { signal },
  );
  return { source: oldDirectory, target: newDirectory, ...(alreadyMigrated ? { alreadyMigrated: true as const } : {}) };
}
