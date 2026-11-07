import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A source install deliberately points outside Codex's copied plugin cache.
export async function buildPlugin(root, env = process.env) {
  root = resolve(root);
  const output = join(root, "build", "local-plugin");
  const entry = join(root, "dist", "mcp", "main.js");
  await access(entry);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8"));
  const serverEnv = {};
  if (env.GITBEACON_STATE_DIR) {
    if (!isAbsolute(env.GITBEACON_STATE_DIR)) throw new Error("GITBEACON_STATE_DIR must be absolute.");
    serverEnv.GITBEACON_STATE_DIR = env.GITBEACON_STATE_DIR;
  }
  if (env.GITBEACON_MAIN_REF) serverEnv.GITBEACON_MAIN_REF = env.GITBEACON_MAIN_REF;
  await rm(output, { recursive: true, force: true });
  const target = join(output, "plugins", "gitbeacon");
  await cp(join(root, "plugin"), target, { recursive: true });
  const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
  await json(join(target, ".codex-plugin", "plugin.json"), { ...manifest, version: pkg.version });
  await json(join(target, ".mcp.json"), {
    mcpServers: { gitbeacon: { type: "stdio", command: process.execPath, args: [entry], env: serverEnv } },
  });
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const hooks = JSON.parse(await readFile(join(target, "hooks", "hooks.json"), "utf8"));
  for (const groups of Object.values(hooks.hooks))
    for (const group of groups)
      for (const handler of group.hooks) handler.command = handler.command.replace("@NODE@", quote(process.execPath));
  await json(join(target, "hooks", "hooks.json"), hooks);
  await mkdir(join(output, ".agents", "plugins"), { recursive: true });
  await json(join(output, ".agents", "plugins", "marketplace.json"), {
    name: "gitbeacon-local",
    plugins: [
      {
        name: "gitbeacon",
        source: { source: "local", path: "./plugins/gitbeacon" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = await buildPlugin(fileURLToPath(new URL("../", import.meta.url)));
  process.stdout.write(`Built source-linked plugin: ${target}\n`);
}
