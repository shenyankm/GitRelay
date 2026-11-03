import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,mkdtemp,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
assert.equal(process.argv.length,3,'Pass the saved round-9 dist directory.');
const variants={baseline:resolve(process.argv[2]),candidate:fileURLToPath(new URL('../../../dist/',import.meta.url))};
const apis={};for(const [name,path]of Object.entries(variants))apis[name]=(await import(pathToFileURL(join(path,'core/cleanup.js')))).collectRepository;
const hash=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root=await mkdtemp(join(tmpdir(),'gitrelay-gc-perf-'));
const repo={root,common:root,directory:root,id:hash('repo'),identity:hash('identity'),identitySource:'external'};
const results=[];
try{
 for(const name of ['sessions','events','trash','refs','receipts'])await mkdir(join(root,name));
 for(const kind of ['trash','refs'])for(const count of [0,100,1000]){
  const ids=[];
  for(let offset=0;offset<count;offset+=32)await Promise.all(Array.from({length:Math.min(32,count-offset)},async(_,i)=>{
   const index=offset+i,id=hash(['event',index]),ref=`refs/heads/branch-${index}`;ids.push(id);
   const event={id,kind:kind==='trash'?'message':'upstream',createdAt:'2020-01-01T00:00:00.000Z',sender:{adapter:'benchmark',session:'sender',root},recipients:[],...(kind==='trash'?{text:'message',files:[]}:{ref,previous:'a'.repeat(40),commit:'b'.repeat(40)})};
   await writeFile(join(root,kind==='trash'?'trash':'events',id+'.json'),JSON.stringify(event));
   if(kind==='refs')await writeFile(join(root,'refs',hash(ref)+'.json'),JSON.stringify({ref,commit:'b'.repeat(40)}));
  }));ids.sort();
  for(let sample=0;sample<13;sample++){
   const entries=Object.entries(apis);if(sample%2)entries.reverse();
   for(const [variant,run]of entries){
    const start=performance.now(),report=await run(repo,{apply:false,retentionDays:0}),wallMs=performance.now()-start;
    assert.equal(report.dryRun,true);assert.deepEqual(report.eligible.toSorted(),ids);assert.deepEqual(report.removed,[]);assert.deepEqual(report.kept,[]);
    if(sample)results.push({kind,count,variant,sample,wallMs});
   }
  }
  assert.equal((await readdir(join(root,kind==='trash'?'trash':'events'))).length,count);
  for(const name of ['trash','events','refs']){await rm(join(root,name),{recursive:true});await mkdir(join(root,name));}
 }
 const medians={};for(const kind of ['trash','refs'])for(const count of [0,100,1000])for(const variant of Object.keys(apis)){
  const s=results.filter(r=>r.kind===kind&&r.count===count&&r.variant===variant).map(r=>r.wallMs).toSorted((a,b)=>a-b);medians[`${kind}-${count}-${variant}`]=(s[5]+s[6])/2;
 }
 console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,samples:12,variants,medians,results,limitations:'Warm local caches, uncontrolled host load. GC dry-runs with no recipients; setup/assertions excluded. Does not measure deletion throughput, memory at the 2 MiB record limit, cold caches, network filesystems, Windows or native-client latency.'},null,2));
}finally{await rm(root,{recursive:true,force:true});}
