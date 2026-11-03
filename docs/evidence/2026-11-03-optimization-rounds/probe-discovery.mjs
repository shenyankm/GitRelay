import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temporary = await mkdtemp(join(tmpdir(), 'gitrelay-discovery-probe-'));
try {
 const root = await realpath(temporary), nested = join(root,'nested');
 await mkdir(nested);
 const clean = {...process.env};
 for(const name of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR']) delete clean[name];
 for(const cwd of [root,nested]) execFileSync('git',['-C',cwd,'init','-b','main'],{env:clean,stdio:'pipe'});
 const env = {...clean,GIT_DIR:'.git',GIT_WORK_TREE:root};
 const git = (cwd,...args) => execFileSync('git',['-C',cwd,...args],{env,encoding:'utf8'}).slice(0,-1);
 const pinnedRoot=git(nested,'rev-parse','--show-toplevel');
 const sequentialCommon=await realpath(git(pinnedRoot,'rev-parse','--path-format=absolute','--git-common-dir'));
 const speculativeCommon=await realpath(git(nested,'rev-parse','--path-format=absolute','--git-common-dir'));
 assert.equal(pinnedRoot,root);
 assert.equal(sequentialCommon,join(root,'.git'));
 assert.equal(speculativeCommon,join(nested,'.git'));
 assert.notEqual(sequentialCommon,speculativeCommon);
 console.log(JSON.stringify({node:process.version,git:git(root,'--version'),environment:{GIT_DIR:'.git',GIT_WORK_TREE:root},pinnedRoot,sequentialCommon,speculativeCommon,decision:'Rejected: parallel discovery from the original cwd changes repository identity with relative GIT_DIR and an explicit worktree. Retain the common-directory query from the pinned root. No runtime change or speedup claim.'},null,2));
}finally {await rm(temporary,{recursive:true,force:true});}
