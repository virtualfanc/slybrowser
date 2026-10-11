import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {initializeRepository} from './helpers.mjs';
import {captureStagedCandidate} from '../../scripts/delivery/git-candidate.mjs';
import {loadBundledScannerPlan} from '../../scripts/delivery/scanner-plan.mjs';
import {runScanner} from '../../scripts/delivery/scanner-runner-lib.mjs';
test('canonical scanner materialization binds a separate project root and retains strict parsing',()=>{
 const root=mkdtempSync(join(tmpdir(),'sly-boundary-repo-'));
 initializeRepository(root,{'index.js':'export const answer=42;\n','contracts/delivery/semgrep-rules.yml':readFileSync('contracts/delivery/semgrep-rules.yml','utf8')});
 const candidate=captureStagedCandidate(root),raw=join(root,'scan.raw');
 const result=runScanner({root,candidate,scannerId:'sast',plan:loadBundledScannerPlan(),rawEvidencePath:raw,rawEvidenceReference:'artifact://boundary/scan.raw',execute(invocation){
   const project=invocation.args[invocation.args.indexOf('--project-root')+1];
   assert.ok(project);assert.equal(project,invocation.args.at(-1));assert.notEqual(invocation.cwd,root);
   assert.ok(invocation.args.includes('--novcs'));assert.ok(invocation.args.includes('--no-git-ignore'));
   assert.equal(readFileSync(join(invocation.cwd,'index.js'),'utf8'),'export const answer=42;\n');
   return {exitCode:0,toolVersion:'1.172.0',stdout:JSON.stringify({results:[],errors:[],paths:{scanned:[join(project,'index.js')]}}),stderr:''};
 }});
 assert.equal(result.status,'pass');
 const evidence=JSON.parse(readFileSync(raw));assert.ok(evidence.command.args.includes('{candidateRoot}'));assert.ok(evidence.command.args.includes('--novcs'));
});
