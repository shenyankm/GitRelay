import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
assert.equal(process.argv.length,3,'Pass the saved round-6 dist directory.');
const variants={baseline:resolve(process.argv[2]),candidate:fileURLToPath(new URL('../../../dist/',import.meta.url))};
const apis={};
for(const [name,path]of Object.entries(variants))apis[name]={...(await import(pathToFileURL(join(path,'core/mailbox.js')))),...(await import(pathToFileURL(join(path,'core/repository.js'))))};
const temporary=await mkdtemp(join(tmpdir(),'gitrelay-send-files-perf-'));
const root=await realpath(temporary),cwd=join(root,'repo'),prior=process.env.WORKTREE_SYNC_STATE_DIR;
process.env.WORKTREE_SYNC_STATE_DIR=join(root,'state');
const results=[];
try{
 await mkdir(cwd);const template=join(root,'template');await mkdir(template);
 execFileSync('git',['-C',cwd,'init','--template',template,'-b','main'],{stdio:'pipe'});
 const repo=await apis.candidate.repository(cwd);
 for(let offset=0;offset<1000;offset+=32)await Promise.all(Array.from({length:Math.min(32,1000-offset)},(_,i)=>writeFile(join(cwd,`item-${offset+i}`),'unchanged\n')));
 for(const count of [0,1,100,1000]) {
  const files=Array.from({length:count},(_,i)=>`item-${i}`);
  for(let sample=0;sample<13;sample++){
   const entries=Object.entries(apis);if(sample%2)entries.reverse();
   for(const [variant,api]of entries){
    const start=performance.now();const event=await api.sendMessage({cwd,adapter:'benchmark',session:'sender',text:'hello',files});const wallMs=performance.now()-start;
    assert.deepEqual(event.files,files);assert.deepEqual(event.recipients,[]);assert.equal(event.text,'hello');
    assert.deepEqual(JSON.parse(await readFile(join(repo.directory,'events',event.id+'.json'),'utf8')),event);
    if(sample)results.push({count,variant,sample,wallMs});
   }
  }
 }
 for(let i=0;i<1000;i++)assert.equal(await readFile(join(cwd,`item-${i}`),'utf8'),'unchanged\n');
 const medians={};
 for(const count of [0,1,100,1000])for(const variant of Object.keys(apis)){
  const s=results.filter(r=>r.count===count&&r.variant===variant).map(r=>r.wallMs).toSorted((a,b)=>a-b);medians[`${count}-${variant}`]=(s[5]+s[6])/2;
 }
 console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,samples:12,variants,medians,results,limitations:'Warm local filesystem; uncontrolled host load. Full in-process send including repository discovery and publication, not native-client/model latency. Setup and assertions excluded. No cold-cache, Windows, network-filesystem, peak memory or physical I/O measurement.'},null,2));
}finally{if(prior===undefined)delete process.env.WORKTREE_SYNC_STATE_DIR;else process.env.WORKTREE_SYNC_STATE_DIR=prior;await rm(root,{recursive:true,force:true});}
