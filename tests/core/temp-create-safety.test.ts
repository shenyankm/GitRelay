import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, sep } from "node:path";
import { test } from "node:test";
import { migrateLegacyState } from "../../src/core/identity-migration.ts";
import { hash, writeJson } from "../../src/core/store.ts";
import { chooseFreshRepository, repository, repositoryIdentity } from "../../src/core/repository.ts";
import { fixture } from "../helpers.ts";

for (const kind of ["identity", "choice", "owner", "migration"] as const) {
  for (const failure of ["collision", "partial", "access"] as const) {
    test(`${kind} preserves an exclusive temporary file on ${failure}`, async (t) => {
      const f = await fixture(t),
        common = join(f.main, ".git");
      if (kind === "choice" || kind === "owner") await repositoryIdentity(common, true);
      let action: () => Promise<unknown>;
      if (kind === "identity") action = () => repositoryIdentity(common, true);
      else if (kind === "choice") action = () => chooseFreshRepository(f.main);
      else if (kind === "owner") action = () => repository(f.main);
      else {
        const repos = join(f.root, "migration", "repos"),
          identity = "a".repeat(64),
          id = hash([common, identity]);
        const oldDirectory = join(repos, hash(common)),
          newDirectory = join(repos, id);
        await mkdir(oldDirectory, { recursive: true });
        await writeJson(join(oldDirectory, "repo.json"), { id: hash(common), common });
        action = () =>
          migrateLegacyState({ common, oldDirectory, newDirectory, newId: id, identity, identitySource: "marker" });
      }
      const matches = (path: string) =>
        path.endsWith(".tmp") &&
        (kind === "identity"
          ? basename(path).startsWith(".git-relay-id-")
          : kind === "choice"
            ? path.includes(`${sep}identity-choices${sep}`)
            : kind === "owner"
              ? basename(path).startsWith(".git-relay-owner-")
              : path.includes(`${sep}identity-migration-claims${sep}`));
      const original = fs.promises.writeFile;
      let temporary = "";
      fs.promises.writeFile = (async (file: any, data: any, options: any) => {
        if (!temporary && matches(String(file))) {
          temporary = String(file);
          await original(file, failure === "collision" ? "existing" : "partial", { flag: "wx", mode: 0o600 });
          if (failure === "partial") throw Object.assign(new Error("injected partial write"), { code: "EIO" });
          if (failure === "access") throw Object.assign(new Error("injected access failure"), { code: "EACCES" });
        }
        return original(file, data, options);
      }) as typeof fs.promises.writeFile;
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          action(),
          (error: any) =>
            (error.code ?? error.cause?.code) ===
              (failure === "collision" ? "EEXIST" : failure === "partial" ? "EIO" : "EACCES") &&
            error.message.includes(temporary) &&
            /preserved/.test(error.message),
        );
      } finally {
        fs.promises.writeFile = original;
        syncBuiltinESMExports();
      }
      assert.ok(temporary);
      assert.equal(await readFile(temporary, "utf8"), failure === "collision" ? "existing" : "partial");
    });
  }
}
