import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "docs/evidence/2026-11-07-performance-20");
const scratch = process.env.GITBEACON_PERF_SCRATCH;
assert.ok(scratch, "Set GITBEACON_PERF_SCRATCH to a disposable directory for source snapshots.");
await mkdir(output, { recursive: true });
await mkdir(scratch, { recursive: true });
async function edit(file, from, to) {
  const path = join(root, file),
    s = await readFile(path, "utf8");
  assert.equal(s.split(from).length, 2, `Expected one patch target in ${file}: ${from.slice(0, 90)}`);
  await writeFile(path, s.replace(from, to));
}
async function section(file, start, end, change) {
  const path = join(root, file),
    s = await readFile(path, "utf8"),
    a = s.indexOf(start),
    b = s.indexOf("\n" + end, a);
  assert.ok(a >= 0 && b > a);
  await writeFile(path, s.slice(0, a) + change(s.slice(a, b)) + s.slice(b));
}
const rounds = [
  {
    name: "Avoid replacing an unchanged pending delivery journal",
    workloads: ["receive-large", "receive-small"],
    patch: () =>
      edit(
        "src/core/mcp-mailbox.ts",
        "      await writeJson(\n        join(location.repository.directory",
        '      if (previous?.id !== id || previous?.phase !== "pending") await writeJson(\n        join(location.repository.directory',
      ),
  },
  {
    name: "Measure detail UTF-8 length once during record validation",
    workloads: ["pages-large", "pages-unicode"],
    patch: () =>
      edit(
        "src/core/mcp-mailbox.ts",
        "  const details = value?.details;",
        '  const details = value?.details;\n  const detailBytes = typeof details?.text === "string" ? Buffer.byteLength(details.text) : 0;',
      ).then(() =>
        section("src/core/mcp-mailbox.ts", "  const invalidDetails =", "  if (", (s) =>
          s.replaceAll("Buffer.byteLength(details.text)", "detailBytes"),
        ),
      ),
  },
  {
    name: "Slice ASCII detail pages without copying the full snapshot to a Buffer",
    workloads: ["pages-large", "pages-unicode"],
    patch: async () => {
      await edit(
        "src/core/mcp-mailbox.ts",
        "      const bytes = Buffer.from(delivery.details.text);",
        "      const detailText = delivery.details.text;\n      const bytes = Buffer.byteLength(detailText) === detailText.length ? undefined : Buffer.from(detailText);\n      const length = bytes?.length ?? detailText.length;",
      );
      await edit(
        "src/core/mcp-mailbox.ts",
        "(bytes[offset] & 0xc0) === 0x80",
        "(bytes && (bytes[offset] & 0xc0) === 0x80)",
      );
      await edit(
        "src/core/mcp-mailbox.ts",
        '      let nextOffset = Math.min(offset + DETAIL_CHUNK_BYTES, bytes.length);\n      while (nextOffset < bytes.length && (bytes[nextOffset] & 0xc0) === 0x80) nextOffset--;\n      const text = bytes.subarray(offset, nextOffset).toString("utf8");',
        '      let nextOffset = Math.min(offset + DETAIL_CHUNK_BYTES, length);\n      while (bytes && nextOffset < length && (bytes[nextOffset] & 0xc0) === 0x80) nextOffset--;\n      const text = bytes ? bytes.subarray(offset, nextOffset).toString("utf8") : detailText.slice(offset, nextOffset);',
      );
      await section("src/core/mcp-mailbox.ts", "      return {\n        deliveryId:", "    },", (s) =>
        s.replaceAll("bytes.length", "length"),
      );
    },
  },
  {
    name: "Avoid reserializing multi-notification batches already bounded by the consumer",
    workloads: ["receive-small", "receive-large"],
    patch: () =>
      edit(
        "src/core/mcp-mailbox.ts",
        "      const text = JSON.stringify(batch);",
        '      const text = batch.length === 1 ? JSON.stringify(batch) : "";',
      ),
  },
  {
    name: "Reuse validated receipts during the same locked acknowledgement",
    workloads: ["ack"],
    patch: async () => {
      await edit(
        "src/core/mcp-mailbox.ts",
        "          for (const id of delivery.eventIds) {\n            const event = events.get(id);\n            if (await readReceipt(repo, key, id)) continue;",
        "          const receipts = new Map<string, Awaited<ReturnType<typeof readReceipt>>>();\n          for (const id of delivery.eventIds) {\n            const event = events.get(id);\n            const receipt = await readReceipt(repo, key, id);\n            receipts.set(id, receipt);\n            if (receipt) continue;",
      );
      await edit(
        "src/core/mcp-mailbox.ts",
        "            const receipt = await readReceipt(repo, key, id);\n            if (receipt) continue;",
        "            const receipt = receipts.get(id);\n            if (receipt) continue;",
      );
    },
  },
  {
    name: "Enrich history events in settled groups of four",
    workloads: ["status-history", "status-small"],
    patch: () =>
      section("src/core/repository-snapshot.ts", "  for (const event of includeEvents", "  return {", (s) => {
        const body = s.slice(s.indexOf("    signal?"), s.lastIndexOf("    events.push"));
        return `  const selected = includeEvents ? retained.slice(-100).reverse() : [];\n  for (let offset = 0; offset < selected.length; offset += 4) {\n    const batch = await Promise.allSettled(selected.slice(offset, offset + 4).map(async (event) => {\n${body}      return { ...event, delivery };\n    }));\n    for (const result of batch) {\n      if (result.status === "rejected") throw result.reason;\n      events.push(result.value);\n    }\n  }\n`;
      }),
  },
  {
    name: "Overlap independent Git and mailbox status observations",
    workloads: ["status-history", "status-small"],
    patch: async () => {
      await edit(
        "src/core/repository-snapshot.ts",
        "  const [worktrees, status, daemon] = await Promise.all([",
        "  const [worktrees, status, daemon, sessions, retained] = await Promise.all([",
      );
      await edit(
        "src/core/repository-snapshot.ts",
        "    daemonStatus(),",
        "    daemonStatus(),\n    repo ? sessionsIn(repo) : Promise.resolve([]),\n    repo ? eventsIn(repo, undefined, signal) : Promise.resolve([]),",
      );
      await edit(
        "src/core/repository-snapshot.ts",
        "  const [sessions, retained] = await Promise.all([sessionsIn(repo), eventsIn(repo, undefined, signal)]);\n",
        "",
      );
    },
  },
  {
    name: "Read connection presence in settled groups of sixteen",
    workloads: ["presence-many", "presence-small"],
    patch: () =>
      section("src/core/connections.ts", "  for (const file of files)", "  return [...keys];", (s) => {
        let body = s.slice(s.indexOf("    if (!/"), s.lastIndexOf("  }"));
        body = body
          .replaceAll("continue;", "return [];")
          .replace(
            "    for (const key of record.keys)",
            "    const present: string[] = [];\n    for (const key of record.keys)",
          )
          .replace("keys.add(key)", "present.push(key)");
        return `  for (let offset = 0; offset < files.length; offset += 16) {\n    const batch = await Promise.allSettled(files.slice(offset, offset + 16).map(async (file) => {\n${body}    return present;\n    }));\n    for (const result of batch) {\n      if (result.status === "rejected") throw result.reason;\n      for (const key of result.value) keys.add(key);\n    }\n  }\n`;
      }),
  },
  {
    name: "Avoid rereading a session already observed online in this call",
    workloads: ["presence-shared", "presence-small"],
    patch: () =>
      edit(
        "src/core/connections.ts",
        "    for (const key of record.keys) {",
        "    for (const key of record.keys) {\n      if (keys.has(key)) continue;",
      ),
  },
  {
    name: "Reuse the non-streaming strict Git path decoder",
    workloads: ["git-paths"],
    patch: async () => {
      await edit(
        "src/core/git.ts",
        "const exec = promisify(execFile);",
        'const exec = promisify(execFile);\nconst pathDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });',
      );
      await edit(
        "src/core/git.ts",
        '      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });',
        "      const decoder = pathDecoder;",
      );
    },
  },
  {
    name: "Avoid allocating parsed event metadata just to filter names",
    workloads: ["events-wide", "events-small"],
    patch: () =>
      edit(
        "src/core/mailbox.ts",
        ".filter((name) => parseEventFilename(name));",
        ".filter((name) => /^[a-f0-9]{64}(?:\\.posix)?\\.json$/.test(name));",
      ),
  },
  {
    name: "Reduce session read concurrency from 32 to 16",
    workloads: ["sessions-many", "sessions-small"],
    patch: () =>
      section("src/core/mailbox.ts", "export async function sessionsIn(", "/** Caller owns publish.lock", (s) =>
        s.replaceAll("32", "16"),
      ),
  },
  {
    name: "Reduce event read concurrency from 32 to 16",
    workloads: ["events-wide", "events-small"],
    patch: () =>
      section("src/core/mailbox.ts", "export async function eventsIn(", "export async function readReceipt(", (s) =>
        s.replaceAll("offset += 32", "offset += 16").replaceAll("offset + 32", "offset + 16"),
      ),
  },
  {
    name: "Reduce the minimum state-read buffer from 256 to 64 bytes",
    workloads: ["json-small", "json-large"],
    patch: () => edit("src/core/store.ts", "Math.max(256, info.size + 1)", "Math.max(64, info.size + 1)"),
  },
  {
    name: "Split only the exact selected branch/ref row",
    workloads: ["branch-many", "branch-small"],
    patch: async () => {
      await edit(
        "src/core/branch-status.ts",
        '  const row = rows.map((line) => line.split("\\0")).find(([name]) => name === ref);',
        '  const row = rows.find((line) => line.startsWith(`${ref}\\0`))?.split("\\0");',
      );
      await edit(
        "src/core/branch-status.ts",
        '    const upstreamRow = upstreamRows.map((line) => line.split("\\0")).find(([name]) => name === upstream);',
        '    const upstreamRow = upstreamRows.find((line) => line.startsWith(`${upstream}\\0`))?.split("\\0");',
      );
    },
  },
  {
    name: "Read the two pinned revision diffs concurrently and settle failures",
    workloads: ["compare-wide", "compare-small"],
    patch: () =>
      section("src/core/conflicts.ts", "    const own = names(", "    const overlap =", (s) => {
        const own = s.slice(s.indexOf("await observationGit("), s.indexOf("\n    const other"));
        const other = s.slice(s.indexOf("await observationGit(", s.indexOf("\n    const other")));
        const suffix = s.slice(s.indexOf("\n    );", s.indexOf("\n    const other")) + "\n    );".length);
        // Extract calls through their final paths argument, without changing command/error ordering.
        const calls = [own, other].map((x) => x.slice(0, x.indexOf("\n      ),") + 8).replace(/^await /, ""));
        return `    const differences = await Promise.allSettled([${calls.join(",")}]);\n    const [own, other] = differences.map((result) => {\n      if (result.status === "rejected") throw result.reason;\n      return names(result.value);\n    });\n${suffix}`;
      }),
  },
  {
    name: "Use exact/parent path sets instead of a quadratic overlap scan",
    workloads: ["compare-wide", "compare-small"],
    patch: () =>
      edit(
        "src/core/conflicts.ts",
        `    const overlap = other.filter((file) =>
      own.some((path) => path === file || path.startsWith(\`${"${file}"}/\`) || file.startsWith(\`${"${path}"}/\`)),
    );`,
        `    const ownPaths = new Set(own), parents = new Set<string>();
    for (const path of own)
      for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) parents.add(path.slice(0, end));
    const overlap = other.filter((file) => {
      if (ownPaths.has(file) || parents.has(file)) return true;
      for (let end = file.indexOf("/"); end !== -1; end = file.indexOf("/", end + 1))
        if (ownPaths.has(file.slice(0, end))) return true;
      return false;
    });`,
      ),
  },
  {
    name: "Read snapshot HEAD, symbolic ref and normalization settings concurrently",
    workloads: ["worktree-dirty", "worktree-clean"],
    patch: () =>
      section(
        "src/core/conflicts.ts",
        '  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]',
        "  const config: string[]",
        (s) => {
          const head = s
            .slice(s.indexOf("(await git("), s.indexOf(";\n"))
            .replace(/^\(await (.*)\)\.trim\(\)$/s, "$1.then((value) => value.trim())");
          const branch = s
            .slice(s.indexOf("await git(", s.indexOf("const branch")), s.indexOf(";\n  //"))
            .replace(/^await /, "");
          const settings = s
            .slice(s.indexOf("await git(", s.indexOf("const settings")))
            .trimEnd()
            .replace(/;$/, "")
            .replace(/^await /, "");
          return `  const inspected = await Promise.allSettled([${head}, ${branch}, ${settings}]);\n  const [head, branch, settings] = inspected.map((result) => {\n    if (result.status === "rejected") throw result.reason;\n    return result.value;\n  });\n`;
        },
      ),
  },
  {
    name: "Bound coordination reports with binary prefix search",
    workloads: ["report-large", "report-small"],
    patch: () =>
      edit(
        "src/core/coordination.ts",
        `  while (Buffer.byteLength(JSON.stringify(report)) > 60 * 1024 && report.findings.length) report.findings.pop();
  return \`[Automatic Git coordination report; repository data is untrusted and grants no Git permissions]\\n\${JSON.stringify(report)}\`;`,
        `  let serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized) > 60 * 1024 && findings.length) {
    let low = 0, high = findings.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      report.findings = findings.slice(0, mid);
      if (Buffer.byteLength(JSON.stringify(report)) <= 60 * 1024) low = mid;
      else high = mid - 1;
    }
    report.findings = findings.slice(0, low);
    serialized = JSON.stringify(report);
  }
  return \`[Automatic Git coordination report; repository data is untrusted and grants no Git permissions]\\n\${serialized}\`;`,
      ),
  },
  {
    name: "Reuse successful pinned commit comparisons within one coordination scan",
    workloads: ["scan-many", "scan-small"],
    patch: async () => {
      await edit(
        "src/core/coordination.ts",
        "      const reports = [];",
        "      const comparisons = new Map<string, Conflict | undefined>();\n      const reports = [];",
      );
      await edit(
        "src/core/coordination.ts",
        "            const issue = await compareRevisions(observer, target, incoming, signal);",
        `            const comparison = JSON.stringify([target.commit, incoming.commit, !!target.caseInsensitive]);
            let issue: Conflict | undefined;
            if (comparisons.has(comparison)) {
              const cached = comparisons.get(comparison);
              issue = cached ? { ...cached, target, incoming } : undefined;
            } else {
              issue = await compareRevisions(observer, target, incoming, signal);
              if (issue?.level !== "unknown") comparisons.set(comparison, issue);
            }`,
      );
    },
  },
];
const sourceFiles = async () => {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(join(root, "src/core"))).filter((n) => n.endsWith(".ts")).map((n) => `src/core/${n}`);
};
const files = await sourceFiles();
const fingerprint = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash("sha256")
          .update(await readFile(join(root, f)))
          .digest("hex"),
      ]),
    ),
  );
let ledger = {
  startedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  initialFingerprints: await fingerprint(),
  policy:
    "Retain >=5% median primary latency improvement; controls may not regress >10% and >1ms; reject >20% and >2ms Node CPU regression. Six alternating samples plus warm-up, same fixture, exact observable-output hashes. All rejected patches restored. Synthetic warm-cache measurements are not native/provider or cold-cache claims.",
  rounds: [],
};
async function snapshot(name) {
  const target = join(scratch, name);
  await mkdir(target, { recursive: true });
  await cp(join(root, "src"), join(target, "src"), { recursive: true });
  await writeFile(join(target, "package.json"), '{"type":"module"}');
  await symlink(join(root, "node_modules"), join(target, "node_modules"));
  const p = join(target, "src/core/coordination.ts");
  await writeFile(p, (await readFile(p, "utf8")) + "\nexport { notification as benchmarkNotification };\n");
  return target;
}
const selected = new Set((process.env.GITBEACON_PERF_ROUNDS ?? "").split(",").filter(Boolean).map(Number));
if (selected.size) ledger = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
for (let i = 0; i < rounds.length; i++) {
  if (selected.size && !selected.has(i + 1)) continue;
  const round = rounds[i],
    n = i + 1;
  const saved = Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, await readFile(join(root, f), "utf8")])),
  );
  const entry = { round: n, name: round.name, workloads: round.workloads, retained: false, measurements: [] };
  try {
    const attempt = Date.now();
    const before = await snapshot(`${n}-before-${attempt}`);
    await round.patch();
    const changed = (
      await Promise.all(files.map(async (f) => (saved[f] !== (await readFile(join(root, f), "utf8")) ? f : undefined)))
    ).filter(Boolean);
    execFileSync(join(root, "node_modules/.bin/prettier"), ["--write", ...changed], { cwd: root, stdio: "pipe" });
    const after = await snapshot(`${n}-after-${attempt}`);
    const measure = (workload) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ["--experimental-strip-types", join(root, "scripts/benchmark-performance.mjs"), before, after, workload],
          { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
        ),
      );
    const passes = ([primary, ...controls]) =>
      primary.gainPercent >= 5 &&
      controls.every(
        (m) => m.medians.after.ms <= m.medians.before.ms * 1.1 || m.medians.after.ms - m.medians.before.ms <= 1,
      ) &&
      [primary, ...controls].every(
        (m) =>
          m.medians.after.cpuMs <= m.medians.before.cpuMs * 1.2 || m.medians.after.cpuMs - m.medians.before.cpuMs <= 2,
      );
    entry.measurements = round.workloads.map(measure);
    entry.retained = passes(entry.measurements);
    entry.decision = entry.retained ? "retained" : "reverted: latency/control/CPU gate not met";
    if (entry.retained) {
      entry.confirmation = round.workloads.map(measure);
      entry.retained = passes(entry.confirmation);
      if (!entry.retained) entry.decision = "reverted: independent confirmation gate not met";
    }
    entry.fingerprints = await fingerprint();
    let patch = "";
    for (const f of files) {
      const current = await readFile(join(root, f), "utf8");
      if (current === saved[f]) continue;
      const a = join(scratch, `${n}-${f.split("/").at(-1)}.before`),
        b = join(scratch, `${n}-${f.split("/").at(-1)}.after`);
      await writeFile(a, saved[f]);
      await writeFile(b, current);
      try {
        patch += execFileSync("diff", ["-u", "--label", `before/${f}`, "--label", `after/${f}`, a, b], {
          encoding: "utf8",
        });
      } catch (e) {
        assert.equal(e.status, 1);
        patch += e.stdout;
      }
    }
    await writeFile(join(output, `round-${String(n).padStart(2, "0")}.patch`), patch);
  } catch (error) {
    entry.retained = false;
    entry.decision = "reverted: experiment failed";
    entry.error = String(error.stderr ?? error.message).slice(-4000);
  }
  if (!entry.retained) for (const f of files) await writeFile(join(root, f), saved[f]);
  const old = ledger.rounds.findIndex((r) => r.round === n);
  if (old >= 0) ledger.rounds[old] = entry;
  else ledger.rounds.push(entry);
  await writeFile(join(output, "summary.json"), JSON.stringify(ledger, null, 2) + "\n");
  console.log(
    JSON.stringify({
      round: n,
      name: entry.name,
      decision: entry.decision,
      measurements: entry.measurements.map((m) => ({
        workload: m.workload,
        beforeMs: m.medians.before.ms,
        afterMs: m.medians.after.ms,
        gainPercent: m.gainPercent,
      })),
      ...(entry.error ? { error: entry.error } : {}),
    }),
  );
}
ledger.finishedAt = new Date().toISOString();
ledger.finalFingerprints = await fingerprint();
ledger.retained = ledger.rounds.filter((r) => r.retained).length;
ledger.reverted = 20 - ledger.retained;
await writeFile(join(output, "summary.json"), JSON.stringify(ledger, null, 2) + "\n");
console.log(JSON.stringify({ retained: ledger.retained, reverted: ledger.reverted }));
