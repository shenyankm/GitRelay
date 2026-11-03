import { readdir, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../../src/', import.meta.url));
const sources = [];
for (const name of (await readdir(root, {recursive:true})).sort())
 if(name.endsWith('.ts')) sources.push(await readFile(join(root,name),'utf8'));
const results = [];
for(let sample=0;sample<13;sample++) {
 const variants=['strip','transform'];
 if(sample%2)variants.reverse();
 for(const variant of variants) {
  const start=performance.now();
  let bytes=0;
  for(const source of sources)bytes+=Buffer.byteLength(stripTypeScriptTypes(source,{mode:variant}));
  const wallMs=performance.now()-start;
  if(sample)results.push({variant,sample,bytes,wallMs});
 }
}
console.log(JSON.stringify({node:process.version,files:sources.length,samples:12,results,decision:'Rejected: a marginal size reduction does not justify reprinting every runtime module without runtime-equivalence acceptance.',limitations:'In-memory TypeScript erasure only; excludes file I/O, vendor code and declarations. Not a runtime benchmark.'},null,2));
