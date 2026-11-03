import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
assert.equal(process.argv.length,3,'Pass the saved round-6 dist directory.');
assert.equal(typeof global.gc,'function','Run with --expose-gc for the separate heap probe.');
const variants={baseline:resolve(process.argv[2]),candidate:fileURLToPath(new URL('../../../dist/',import.meta.url))};
const apis={};
for(const [name,path] of Object.entries(variants)) apis[name]=await import(pathToFileURL(join(path,'core/mailbox.js')));
const hash=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root=await mkdtemp(join(tmpdir(),'gitrelay-mailbox-perf-'));
const results=[],heapProbes=[];
const sender={adapter:'benchmark',session:'sender',root};
const repo={root,common:root,id:hash('repo'),directory:root,identity:hash('identity'),identitySource:'external'};
const median=(values)=>{const sorted=values.toSorted((a,b)=>a-b);return (sorted[(sorted.length-1)>>1]+sorted[sorted.length>>1])/2;};
const measure=async(workload,run,prepare=async()=>{})=>{
 for(let sample=0;sample<13;sample++) {
  const entries=Object.entries(apis);if(sample%2)entries.reverse();
  for(const [variant,api] of entries) {
   await prepare();
   const start=performance.now();await run(api);const wallMs=performance.now()-start;
   if(sample)results.push({workload,variant,sample,wallMs});
  }
 }
};
try {
 for(const name of ['events','trash','receipts'])await mkdir(join(root,name));
 for(const [count,posix] of [[100,false],[1000,false],[10000,false],[1000,true]]) {
  const ids=[];
  for(let offset=0;offset<count;offset+=32)await Promise.all(Array.from({length:Math.min(32,count-offset)},async(_,i)=>{
   const id=hash(['event',offset+i]);ids.push(id);
   await writeFile(join(root,'events',id+(posix?'.posix.json':'.json')),JSON.stringify({id,kind:'message',createdAt:'2026-01-01T00:00:00.000Z',sender,recipients:[],text:'message',files:[],...(posix?{pathFormat:'posix-v1'}:{})}));
  }));
  ids.sort();
  const check=async(api)=>{assert.deepEqual((await api.eventsIn(repo)).map(e=>e.id),ids);};
  const workload=`scan-${posix?'posix':'normal'}-${count}`;
  await measure(workload,check);
  for(const [variant,api]of Object.entries(apis)) {
   global.gc();
   const start=process.memoryUsage().heapUsed,original=fs.promises.open;
   let atFirstOpen;
   fs.promises.open=async function(...args){atFirstOpen??=process.memoryUsage().heapUsed;return original(...args);};
   syncBuiltinESMExports();
   try{await check(api);}finally{fs.promises.open=original;syncBuiltinESMExports();}
   heapProbes.push({workload,variant,heapGrowthBeforeFirstOpen:atFirstOpen-start});
  }
  await rm(join(root,'events'),{recursive:true});await mkdir(join(root,'events'));
 }
 const ref='refs/heads/main',previous='a'.repeat(40),commit='b'.repeat(40),id=hash(['upstream',ref,previous,commit,'']);
 for(const count of [10,1000,5000])for(const mode of ['unchanged','extend']) {
  const recipients=Array.from({length:count},(_,i)=>hash(['recipient',i]));
  const targets=mode==='unchanged'?recipients:[...recipients.slice(count/2),...Array.from({length:count},(_,i)=>hash(['new',i]))];
  const expected=mode==='unchanged'?recipients:[...new Set([...recipients,...targets])];
  const original=JSON.stringify({id,kind:'upstream',ref,previous,commit,createdAt:'2026-01-01T00:00:00.000Z',sender,recipients});
  await measure(`recipients-${mode}-${count}`,async(api)=>{
   const event=await api.publishUpstream(repo,sender,ref,previous,commit,targets);
   assert.deepEqual(event.recipients,expected);
  },()=>writeFile(join(root,'events',id+'.json'),original));
 }
 const medians={};
 for(const workload of new Set(results.map(r=>r.workload)))for(const variant of Object.keys(apis))medians[workload+'-'+variant]=median(results.filter(r=>r.workload===workload&&r.variant===variant).map(r=>r.wallMs));
 console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,variants,samples:12,medians,heapProbes,results,limitations:'Warm local caches; uncontrolled host load. Setup excluded. Separate heap probes measure heap growth until the first file open, not peak RSS or a stable allocation bound. No cold cache, Windows, physical I/O or native-client latency.'},null,2));
}finally{await rm(root,{recursive:true,force:true});}
