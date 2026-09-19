import assert from "node:assert/strict";
import test from "node:test";

import {createSdkEvidence} from "../../scripts/release/Generate-SdkSupplyChainEvidence.mjs";

test("SDK evidence binds the artifact, candidate, source inputs, and dependency inventory",()=>{
  const candidateId=`sha256:${"a".repeat(64)}`;
  const evidence=createSdkEvidence({target:"node",packageName:"slybrowser",version:"0.1.0",purl:"pkg:npm/slybrowser@0.1.0",artifactName:"slybrowser-0.1.0.tgz",artifactIdentity:{sha256:"b".repeat(64),size:42},components:[{type:"library",name:"yauzl",version:"3.4.0",purl:"pkg:npm/yauzl@3.4.0","bom-ref":"pkg:npm/yauzl@3.4.0"}],candidateId,sourceInputs:[{path:"packages/node/package.json",sha256:"c".repeat(64)}],createdAt:"2026-09-13T03:00:00.000Z"});
  assert.equal(evidence.sbom.metadata.component.hashes[0].content,"b".repeat(64));
  assert.deepEqual(evidence.sbom.dependencies[0].dependsOn,["pkg:npm/yauzl@3.4.0"]);
  assert.equal(evidence.provenance.subject[0].digest.sha256,"b".repeat(64));
  assert.equal(evidence.provenance.predicate.buildDefinition.externalParameters.candidateId,candidateId);
  assert.equal(evidence.provenance.predicate.buildDefinition.resolvedDependencies[0].digest.sha256,"c".repeat(64));
});

test("SDK evidence rejects an unbound candidate or empty dependency inventory",()=>{
  const base={target:"python",packageName:"slybrowser",version:"0.1.0",purl:"pkg:pypi/slybrowser@0.1.0",artifactName:"slybrowser.whl",artifactIdentity:{sha256:"b".repeat(64),size:42},components:[{type:"library",name:"cffi",version:"2.1.1",purl:"pkg:pypi/cffi@2.1.1","bom-ref":"pkg:pypi/cffi@2.1.1"}],candidateId:`sha256:${"a".repeat(64)}`,sourceInputs:[],createdAt:"2026-09-13T03:00:00.000Z"};
  assert.throws(()=>createSdkEvidence({...base,candidateId:"working-tree"}),/Candidate ID/);
  assert.throws(()=>createSdkEvidence({...base,components:[]}),/inventory is empty/);
});
