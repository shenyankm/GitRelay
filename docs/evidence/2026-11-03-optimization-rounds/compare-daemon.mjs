import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
assert.equal(process.argv.length, 3, 'Pass the saved baseline dist directory.');
const apis = {};
for (const [name, path] of Object.entries({ baseline: resolve(process.argv[2]), candidate: fileURLToPath(new URL('../../../dist/', import.meta.url)) }))
  apis[name] = (await import(pathToFileURL(join(path, 'core/daemon-state.js')))).daemonStatus;
const root = await mkdtemp(join(tmpdir(), 'gitrelay-daemon-perf-'));
const previous = process.env.WORKTREE_SYNC_STATE_DIR;
process.env.WORKTREE_SYNC_STATE_DIR = root;
const results = [];
try {
  for (const workload of ['missing-lock', 'live']) {
    if (workload === 'live') {
      await writeFile(join(root,'daemon.lock'), JSON.stringify({pid:process.pid,token:'a'.repeat(64)}));
      await writeFile(join(root,'daemon.json'), JSON.stringify({pid:process.pid,token:'a'.repeat(64),intervalMs:60000,heartbeatAt:new Date().toISOString()}));
    }
    for (let sample=0; sample<13; sample++) {
      const variants = Object.entries(apis);
      if (sample % 2) variants.reverse();
      for (const [variant, run] of variants) {
        const start = performance.now();
        for (let index=0; index<200; index++) assert.equal((await run()).running, workload === 'live');
        const wallMs = (performance.now()-start)/200;
        if (sample) results.push({workload,variant,sample,wallMs});
      }
    }
  }
  const medians = {};
  for(const workload of ['missing-lock','live']) for(const variant of Object.keys(apis)) {
    const samples = results.filter(r=>r.workload===workload&&r.variant===variant).map(r=>r.wallMs).sort((a,b)=>a-b);
    medians[workload+'-'+variant] = (samples[5]+samples[6])/2;
  }
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,samples:12,callsPerSample:200,medians,results,limitations:'Warm local caches, uncontrolled host load; in-process status calls, not hook latency or physical disk I/O.'},null,2));
} finally {
  if (previous === undefined) delete process.env.WORKTREE_SYNC_STATE_DIR; else process.env.WORKTREE_SYNC_STATE_DIR = previous;
  await rm(root,{recursive:true,force:true});
}
