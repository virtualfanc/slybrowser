import assert from 'node:assert/strict';
import test from 'node:test';
import {buildScannerInvocation,loadBundledScannerPlan,parseScannerPlan} from '../../scripts/delivery/scanner-plan.mjs';
test('exact Semgrep candidate cannot inherit ancestor VCS or omit Git ignored inputs',()=>{
  const scan=buildScannerInvocation(loadBundledScannerPlan(),'sast',{candidateRoot:'/candidate',repositoryRoot:'/repository'});
  assert.ok(scan.args.includes('--novcs'));assert.ok(scan.args.includes('--no-git-ignore'));
  assert.equal(scan.args[scan.args.indexOf('--project-root')+1],scan.args.at(-1));
  assert.equal(scan.args[scan.args.indexOf('--jobs')+1],'2');
  assert.ok(scan.args.includes('--strict'));assert.ok(scan.args.includes('--error'));
});
test('Maven native resolution remains complete and rejects arbitrary registries',()=>{
  const plan=loadBundledScannerPlan(),scan=buildScannerInvocation(plan,'dependency-vulnerability',{candidateRoot:'/candidate',repositoryRoot:'/repository'});
  assert.equal(scan.args[scan.args.indexOf('--data-source')+1],'native');
  assert.equal(scan.args[scan.args.indexOf('--maven-registry')+1],'https://maven-central.storage-download.googleapis.com/maven2');
  assert.ok(!scan.args.includes('--no-resolve'));assert.equal(scan.requiredEcosystems.length,4);
  const bad=structuredClone(plan);bad.scanners.find(s=>s.id==='dependency-vulnerability').mavenRegistry='https://untrusted.invalid';
  assert.throws(()=>parseScannerPlan(bad),/registry/);
});
