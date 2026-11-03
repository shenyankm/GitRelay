import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
assert.equal(process.argv.length, 3, 'Pass the saved baseline dist directory.');
const apis = {};
for (const [name, path] of Object.entries({ baseline: resolve(process.argv[2]), candidate: fileURLToPath(new URL('../../../dist/', import.meta.url)) }))
  apis[name] = (await import(pathToFileURL(join(path, 'cli/installer-digest.js')))).installerDigest;
const root = await mkdtemp(join(tmpdir(), 'gitrelay-digest-perf-'));
const results = [], allocations = [];
try {
 for (const workload of ['small-files','mixed-files']) {
  const hash = createHash('sha256');
  for (let index=0;index<1000;index++) {
   const name = index.toString().padStart(4,'0')+'.js';
   const data = Buffer.alloc(workload === 'mixed-files' && index % 100 === 0 ? 128*1024 : 4096,index%256);
   await writeFile(join(root,name),data);
   hash.update(`${Buffer.byteLength(name)}:`).update(name).update(`${data.length}:`).update(data);
  }
  const expected = hash.digest('hex');
  for (let sample=0;sample<13;sample++) {
   const variants=Object.entries(apis);
   if(sample%2) variants.reverse();
   for(const [variant, run] of variants) {
    const start=performance.now();
    assert.equal(await run(root),expected);
    const wallMs=performance.now()-start;
    if(sample)results.push({variant,workload,sample,wallMs});
   }
  }
  for(const [variant, run] of Object.entries(apis)) {
   const original=Buffer.allocUnsafe;let bytes=0,count=0;
   Buffer.allocUnsafe=function(size){bytes+=size;count++;return original(size);};
   try {assert.equal(await run(root),expected);}finally {Buffer.allocUnsafe=original;}
   allocations.push({variant,workload,bytes,count});
  }
 }
 const medians={};
 for(const workload of ['small-files','mixed-files'])for(const variant of Object.keys(apis)) {
  const samples=results.filter(r=>r.workload===workload&&r.variant===variant).map(r=>r.wallMs).sort((a,b)=>a-b);
  medians[workload+'-'+variant]=(samples[5]+samples[6])/2;
 }
 console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,samples:12,medians,allocations,results,limitations:'Warm local caches, uncontrolled host load. Timings exclude allocation instrumentation and setup. Allocations are calls to Buffer.allocUnsafe, not peak RSS. No cold caches, network filesystems, Windows or native client timing.'},null,2));
}finally {await rm(root,{recursive:true,force:true});}
