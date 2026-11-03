import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
assert.equal(process.argv.length, 3, "Pass saved baseline dist directory.");
const variants = {
    baseline: resolve(process.argv[2]),
    candidate: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  },
  apis = {},
  results = [];
for (const [name, path] of Object.entries(variants))
  apis[name] = (await import(pathToFileURL(join(path, "core/store.js")))).readJson;
const root = await mkdtemp(join(tmpdir(), "gitrelay-state-ascii-")),
  path = join(root, "value.json");
try {
  const invalid = [
    Buffer.from([255]),
    Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]),
    Buffer.from('\ufeff{"a":1}'),
    Buffer.from("{broken"),
  ];
  for (const bytes of invalid) {
    await writeFile(path, bytes);
    const outcomes = [];
    for (const run of Object.values(apis)) {
      try {
        await run(path);
        assert.fail("Invalid fixture accepted");
      } catch (error) {
        outcomes.push({
          name: error.name,
          message: error.message,
          causeName: error.cause?.name,
          causeCode: error.cause?.code,
          causeMessage: error.cause?.message,
        });
      }
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  }
  for (const unicode of [false, true])
    for (const size of [64, 65536, 1048576]) {
      const unit = unicode ? "工作😀" : "a",
        value = { payload: unit.repeat(Math.floor(size / Buffer.byteLength(unit))) },
        bytes = Buffer.byteLength(JSON.stringify(value)),
        calls = size === 64 ? 200 : size === 65536 ? 30 : 10;
      await writeFile(path, JSON.stringify(value));
      for (let sample = 0; sample <= 12; sample++) {
        const entries = Object.entries(apis);
        if (sample % 2) entries.reverse();
        for (const [variant, run] of entries) {
          let last;
          const before = process.resourceUsage(),
            start = performance.now();
          for (let i = 0; i < calls; i++) last = await run(path);
          const wallMs = (performance.now() - start) / calls,
            after = process.resourceUsage(),
            cpuMs =
              (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000 / calls;
          assert.deepEqual(last, value);
          if (sample) results.push({ unicode, size, bytes, calls, variant, sample, wallMs, cpuMs });
        }
      }
    }
  const medians = {};
  for (const unicode of [false, true])
    for (const size of [64, 65536, 1048576])
      for (const variant of Object.keys(apis))
        for (const key of ["wallMs", "cpuMs"]) {
          const s = results
            .filter((r) => r.unicode === unicode && r.size === size && r.variant === variant)
            .map((r) => r[key])
            .sort((a, b) => a - b);
          medians[`${unicode}-${size}-${variant}-${key}`] = (s[5] + s[6]) / 2;
        }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples: 12,
        invalidCases: invalid.length,
        variants,
        medians,
        results,
        limitations:
          "Actual public readJson on small/64-KiB/1-MiB ASCII and Unicode JSON files. Strict invalid UTF8, BOM and malformed JSON outcomes compared including error causes. Warm local caches; setup and output equality outside timing. No physical I/O, cold-cache, peak-memory, Windows or native-client claim.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
