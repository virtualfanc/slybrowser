import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const read=(path)=>readFile(new URL(`../../${path}`,import.meta.url),"utf8");

test("framework support lines match package metadata and exact resolution inputs",async()=>{
  const [nodePackage,lock,nodePolicy,pythonProject,pythonPolicy,javaPom,javaPolicy,dotnetProject,dotnetPolicy,dotnetLock]=await Promise.all([
    read("packages/node/package.json").then(JSON.parse),read("pnpm-lock.yaml"),read("packages/node/src/automation.ts"),read("packages/python/pyproject.toml"),read("packages/python/src/slybrowser/automation.py"),read("packages/java/pom.xml"),read("packages/java/src/main/java/com/slybrowser/AutomationPolicy.java"),read("packages/dotnet/src/SlyBrowser/SlyBrowser.csproj"),read("packages/dotnet/src/SlyBrowser/AutomationPolicy.cs"),read("packages/dotnet/src/SlyBrowser/packages.lock.json").then(JSON.parse),
  ]);
  assert.equal(nodePackage.peerDependencies["playwright-core"],">=1.62.0 <1.63.0");
  assert.equal(nodePackage.peerDependencies["puppeteer-core"],">=25.0.0 <26.0.0");
  assert.match(lock,/packages\/node:[\s\S]*?playwright-core:[\s\S]*?specifier: '>=1\.62\.0 <1\.63\.0'[\s\S]*?version: 1\.62\.1/u);
  assert.match(nodePolicy,/playwright: Object\.freeze\(\["1\.62"\]\)/u);
  assert.match(nodePolicy,/puppeteer: Object\.freeze\(\["25"\]\)/u);
  assert.match(pythonProject,/playwright>=1\.62,<1\.63/u);
  assert.match(pythonPolicy,/_SUPPORTED_PLAYWRIGHT_LINES = frozenset\(\{"1\.62"\}\)/u);
  assert.match(javaPom,/<playwright\.version>1\.61\.0<\/playwright\.version>/u);
  assert.match(javaPolicy,/Collections\.singleton\("1\.61"\)/u);
  assert.match(dotnetProject,/<PackageReference Include="Microsoft\.Playwright" Version="1\.61\.0" \/>/u);
  assert.match(dotnetPolicy,/SupportedPlaywrightLines = \["1\.61"\]/u);
  assert.equal(dotnetLock.dependencies["net8.0"]["Microsoft.Playwright"].resolved,"1.61.0");
});
