#!/usr/bin/env node

import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {basename,dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

const sha256=(content)=>createHash("sha256").update(content).digest("hex");
const identity=async(path)=>{const content=await readFile(path);return {sha256:sha256(content),size:content.length};};
const option=(name)=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const required=(name)=>{const value=option(name);if(!value)throw new Error(`${name} is required`);return value;};
const cleanName=(name)=>name.toLowerCase().replaceAll("_","-");
const runPackageTool=(name,args,options={})=>{
  if(process.platform!=="win32")return execFileSync(name,args,{...options,windowsHide:true});
  if(!args.every((value)=>/^[A-Za-z0-9@._/:=,+-]+$/u.test(value)))throw new Error(`${name} received an unsafe Windows command argument`);
  const command=[`${name}.cmd`,...args].join(" ");
  return execFileSync(process.env.ComSpec??"C:\\Windows\\System32\\cmd.exe",["/d","/s","/c",command],{...options,shell:false,windowsHide:true});
};

function flattenNodeDependencies(dependencies,result=new Map()){
  for(const [name,value] of Object.entries(dependencies??{})){
    const version=String(value.version??"").replace(/\(.+$/u,"");
    if(!version)throw new Error(`Node dependency ${name} has no resolved version`);
    result.set(`pkg:npm/${encodeURIComponent(name).replace("%2F","/")}@${version}`,{name,version,type:"library"});
    flattenNodeDependencies(value.dependencies,result);
  }
  return [...result.entries()].map(([purl,value])=>({...value,purl,"bom-ref":purl}));
}

function pythonDependencies(text){
  const result=[];
  for(const match of text.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)[ \t]*\\?$/gmu)){
    const name=cleanName(match[1]);const version=match[2];const purl=`pkg:pypi/${name}@${version}`;
    result.push({type:"library",name,version,purl,"bom-ref":purl});
  }
  return result;
}

function javaDependencies(text){
  const result=[];
  for(const line of text.split(/\r?\n/u)){
    const match=/^\s*([^:\s]+):([^:\s]+):[^:\s]+:([^:\s]+):(?:compile|runtime)\b/u.exec(line);
    if(!match)continue;
    const [,group,name,version]=match;const purl=`pkg:maven/${group}/${name}@${version}`;
    result.push({type:"library",group,name,version,purl,"bom-ref":purl});
  }
  return result;
}

function dotnetDependencies(lock){
  const result=[];
  const frameworks=Object.values(lock.dependencies??{});
  for(const dependencies of frameworks){
    for(const [name,value] of Object.entries(dependencies)){
      const version=value.resolved;if(typeof version!=="string")throw new Error(`NuGet dependency ${name} has no resolved version`);
      const purl=`pkg:nuget/${name}@${version}`;const component={type:"library",name,version,purl,"bom-ref":purl};
      if(typeof value.contentHash==="string")component.hashes=[{alg:"SHA-512",content:Buffer.from(value.contentHash,"base64").toString("hex")}];
      result.push(component);
    }
  }
  return result;
}

export function createSdkEvidence({target,packageName,version,purl,artifactName,artifactIdentity,components,candidateId,sourceInputs,createdAt}){
  if(!/^sha256:[a-f0-9]{64}$/u.test(candidateId))throw new Error("Candidate ID must be a SHA-256 digest");
  if(!components.length)throw new Error(`${target} dependency inventory is empty`);
  const rootRef=`${purl}?download=${encodeURIComponent(artifactName)}`;
  const rootComponent={type:"library",name:packageName,version,purl,"bom-ref":rootRef,hashes:[{alg:"SHA-256",content:artifactIdentity.sha256}],properties:[{name:"slybrowser:artifact:size",value:String(artifactIdentity.size)},{name:"slybrowser:candidate",value:candidateId}]};
  const sbom={$schema:"https://cyclonedx.org/schema/bom-1.6.schema.json",bomFormat:"CycloneDX",specVersion:"1.6",serialNumber:`urn:uuid:${artifactIdentity.sha256.slice(0,8)}-${artifactIdentity.sha256.slice(8,12)}-4${artifactIdentity.sha256.slice(13,16)}-a${artifactIdentity.sha256.slice(17,20)}-${artifactIdentity.sha256.slice(20,32)}`,version:1,metadata:{timestamp:createdAt,component:rootComponent},components:[...components].sort((a,b)=>a.purl.localeCompare(b.purl)),dependencies:[{ref:rootRef,dependsOn:components.map((item)=>item["bom-ref"]).sort()}]};
  const provenance={_type:"https://in-toto.io/Statement/v1",subject:[{name:artifactName,digest:{sha256:artifactIdentity.sha256}}],predicateType:"https://slsa.dev/provenance/v1",predicate:{buildDefinition:{buildType:"https://slybrowser.com/build-types/sdk-release/v1",externalParameters:{target,version,candidateId},resolvedDependencies:sourceInputs.map((input)=>({uri:`https://github.com/virtualfanc/slybrowser/blob/candidate/${input.path}`,digest:{sha256:input.sha256}}))},runDetails:{builder:{id:"https://slybrowser.com/builders/sdk-release"},metadata:{invocationId:artifactIdentity.sha256,startedOn:createdAt,finishedOn:createdAt}}}};
  return {sbom,provenance};
}

async function main(){
  const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..","..");
  const artifactRoot=resolve(required("--artifact-root"));
  const outputDirectory=resolve(required("--output-dir"));
  const candidateId=required("--candidate-id");
  const contract=JSON.parse(await readFile(join(repoRoot,"contracts","sdk-packages.json"),"utf8"));
  const version=contract.version;const createdAt=new Date().toISOString();
  const javaList=join(repoRoot,"packages","java","target","runtime-dependencies.txt");
  runPackageTool("mvn",["dependency:list","-DincludeScope=runtime","-DoutputFile=target/runtime-dependencies.txt","-DappendOutput=false"],{cwd:join(repoRoot,"packages","java"),stdio:"ignore"});
  const nodeList=JSON.parse(runPackageTool("pnpm",["--filter","slybrowser","list","--prod","--json","--depth","Infinity"],{cwd:repoRoot,encoding:"utf8"}))[0];
  const definitions=[
    {target:"node",packageName:"slybrowser",purl:`pkg:npm/slybrowser@${version}`,artifact:join(artifactRoot,"node",`slybrowser-${version}.tgz`),components:flattenNodeDependencies(nodeList.dependencies),inputs:["packages/node/package.json","pnpm-lock.yaml"]},
    {target:"python",packageName:"slybrowser",purl:`pkg:pypi/slybrowser@${version}`,artifact:join(artifactRoot,"python",`slybrowser-${version}-py3-none-any.whl`),components:pythonDependencies(await readFile(join(repoRoot,"packages","python","requirements-security.txt"),"utf8")),inputs:["packages/python/pyproject.toml","packages/python/requirements-security.txt"]},
    {target:"java",packageName:"com.slybrowser:slybrowser",purl:`pkg:maven/com.slybrowser/slybrowser@${version}`,artifact:join(artifactRoot,"java",`slybrowser-${version}.jar`),components:javaDependencies(await readFile(javaList,"utf8")),inputs:["packages/java/pom.xml"]},
    {target:"dotnet",packageName:"SlyBrowser",purl:`pkg:nuget/SlyBrowser@${version}`,artifact:join(artifactRoot,"dotnet",`SlyBrowser.${version}.nupkg`),components:dotnetDependencies(JSON.parse(await readFile(join(repoRoot,"packages","dotnet","src","SlyBrowser","packages.lock.json"),"utf8"))),inputs:["packages/dotnet/src/SlyBrowser/SlyBrowser.csproj","packages/dotnet/src/SlyBrowser/packages.lock.json"]},
  ];
  await mkdir(outputDirectory,{recursive:true});
  const outputs=[];
  for(const definition of definitions){
    const artifactIdentity=await identity(definition.artifact);
    const sourceInputs=await Promise.all(definition.inputs.map(async(path)=>({path,sha256:(await identity(join(repoRoot,...path.split("/")))).sha256})));
    const evidence=createSdkEvidence({...definition,version,artifactName:basename(definition.artifact),artifactIdentity,candidateId,sourceInputs,createdAt});
    const sbomPath=join(outputDirectory,`${definition.target}.cdx.json`);const provenancePath=join(outputDirectory,`${definition.target}.provenance.json`);
    await Promise.all([writeFile(sbomPath,`${JSON.stringify(evidence.sbom,null,2)}\n`,{flag:"wx"}),writeFile(provenancePath,`${JSON.stringify(evidence.provenance,null,2)}\n`,{flag:"wx"})]);
    outputs.push({target:definition.target,artifact:definition.artifact,sbom:sbomPath,provenance:provenancePath,dependencies:definition.components.length,sha256:artifactIdentity.sha256});
  }
  process.stdout.write(`${JSON.stringify({result:"pass",candidateId,outputs})}\n`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch((error)=>{process.stderr.write(`SDK evidence generation failed: ${error.message}\n`);process.exitCode=1;});
