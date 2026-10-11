import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import test from 'node:test';
import {buildScannerInvocation,loadBundledScannerPlan} from '../../scripts/delivery/scanner-plan.mjs';
const root=process.env.SLY_SCANNER_BOUNDARY_E2E_ROOT,output=process.env.SLY_SCANNER_BOUNDARY_E2E_OUTPUT;
const required=()=>{assert.ok(root&&output,'Pinned-tool E2E requires an exact materialized source and private output directory');mkdirSync(output,{recursive:true});};
test('pinned Semgrep scans all exact candidate languages without inherited VCS scope',{timeout:100000},()=>{
 required();const plan=loadBundledScannerPlan(),tool=process.env.SLY_SCANNER_SEMGREP_PATH;assert.ok(tool);
 const invocation=buildScannerInvocation(plan,'sast',{candidateRoot:resolve(root),repositoryRoot:resolve(root),toolPaths:{sast:tool}});
 const r=spawnSync(invocation.executable,invocation.args,{cwd:invocation.cwd,encoding:'utf8',windowsHide:true,timeout:80000,maxBuffer:300000});
 writeFileSync(join(output,'semgrep.stdout'),r.stdout??'');writeFileSync(join(output,'semgrep.stderr'),r.stderr??'');
 assert.equal(r.status,0,r.error?.message??r.stderr);const report=JSON.parse(r.stdout);assert.deepEqual(report.errors,[]);assert.ok(report.paths.scanned.length>100);
});
test('pinned OSV resolves Maven transitively through the frozen native registry',{timeout:100000},()=>{
 required();const tool=process.env.SLY_SCANNER_OSV_PATH;assert.ok(tool);
 const invocation=buildScannerInvocation(loadBundledScannerPlan(),'dependency-vulnerability',{candidateRoot:resolve(root),repositoryRoot:resolve(root),toolPaths:{'dependency-vulnerability':tool}});
 const flags=invocation.args.filter((_,i)=>i>=4);const r=spawnSync(invocation.executable,['scan','source','--lockfile',join(root,'packages/java/pom.xml'),...flags],{encoding:'utf8',windowsHide:true,timeout:80000,maxBuffer:300000});
 writeFileSync(join(output,'osv.stdout'),r.stdout??'');writeFileSync(join(output,'osv.stderr'),r.stderr??'');
 assert.equal(r.status,0,r.error?.message??r.stderr);assert.deepEqual(JSON.parse(r.stdout).results,[]);
});
