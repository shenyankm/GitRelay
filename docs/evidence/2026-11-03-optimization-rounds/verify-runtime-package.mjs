import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
assert.equal(process.argv.length, 3, "Pass the real tarball path to install.");
const tarball = resolve(process.argv[2]),
  source = fileURLToPath(new URL("../../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "gitrelay-runtime-package-"));
const env = {
  ...process.env,
  npm_config_cache: join(root, "cache"),
  npm_config_userconfig: join(root, "npmrc"),
  WORKTREE_SYNC_STATE_DIR: join(root, "state"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
delete env.WORKTREE_SYNC_REPOSITORY_IDS;
try {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "runtime-package-probe", version: "1.0.0", private: true }),
  );
  await writeFile(join(root, "npmrc"), "");
  const npmOutput = execFileSync(
    "npm",
    ["install", "--offline", "--omit=dev", "--ignore-scripts=false", "--no-audit", "--no-fund", tarball],
    {
      cwd: root,
      env,
      encoding: "utf8",
    },
  );
  const installed = join(root, "node_modules/git-relay");
  for (const path of [
    "src/index.ts",
    "vendor",
    "scripts",
    "tsconfig.json",
    "docs/evidence",
    "docs/acceptance-results.json",
    "docs/optimization-rounds.md",
  ])
    await assert.rejects(access(join(installed, path)), { code: "ENOENT" });
  for (const path of [
    "dist/cli/main.js",
    "dist/index.d.ts",
    "dist/vendor/smol-toml/LICENSE",
    "src/adapters/codex/hooks.json",
    "src/adapters/codex/plugin-hooks.json",
  ])
    await access(join(installed, path));
  assert.deepEqual(
    (await readdir(join(root, "node_modules"))).filter((name) => !name.startsWith(".")),
    ["git-relay"],
  );
  const manifest = JSON.parse(await readFile(join(installed, ".codex-plugin/plugin.json"), "utf8"));
  await access(join(installed, manifest.hooks));
  const help = execFileSync(process.execPath, [join(installed, "dist/cli/main.js"), "--help"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.match(help, /GitRelay/);
  const program = `
 import assert from 'node:assert/strict';
 import {execFileSync}from'node:child_process';
 import {mkdir}from'node:fs/promises';
 import {join}from'node:path';
 import {enableSession,sendMessage,consumeMailbox}from'git-relay';
 import {install}from'./node_modules/git-relay/dist/cli/install.js';assert.equal(typeof install,'function');
 const root=process.cwd(), main=join(root,'main'), receiver=join(root,'receiver'), template=join(root,'template');await mkdir(template);
 const git=(cwd,...args)=>execFileSync('git',['-C',cwd,'-c','user.name=Probe','-c','user.email=probe@example.test','-c','commit.gpgsign=false',...args],{stdio:'pipe'});
 git(root,'init','--template',template,'-b','main',main);git(main,'commit','--allow-empty','-m','initial');git(main,'worktree','add','-b','receiver',receiver);
 const options={cwd:receiver,adapter:'test',session:'receiver',ref:'refs/heads/main'};await enableSession(options);
 const event=await sendMessage({cwd:main,adapter:'test',session:'sender',text:'runtime package delivery'});
 let received=0;await consumeMailbox({...options,async deliver(batch){assert.equal(batch[0].event.id,event.id);received+=batch.length;}});assert.equal(received,1);
 await consumeMailbox({...options,async deliver(){assert.fail('must not repeat delivery');}});
 `;
  execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: root, env, stdio: "pipe" });
  const consumer = join(root, "consumer.mts");
  await writeFile(
    consumer,
    `import {enableSession,type SessionOptions}from'git-relay';const options:SessionOptions={cwd:'/repo',adapter:'test',session:'s',ref:'refs/heads/main'};void enableSession(options);`,
  );
  execFileSync(
    process.execPath,
    [
      join(source, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      "--typeRoots",
      join(source, "node_modules/@types"),
      consumer,
    ],
    { cwd: root, env, stdio: "pipe" },
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tarball,
        npmOutput: npmOutput.trim(),
        assertions: [
          "Real offline production installation without ignore-scripts",
          "Only GitRelay installed; no build/development dependencies",
          "CLI help, built installer/TOML imports and Codex hook files work without source or build scripts",
          "Actual installed SDK sends and consumes a message once across real Git worktrees",
          "Actual installed SDK declarations compile in a consumer with Node types",
        ],
        limitations: [
          "Local POSIX smoke test with test adapter; no real Codex/model or remote CI acceptance",
          "TypeScript and Node types are test tools from the source checkout, not production dependencies",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
