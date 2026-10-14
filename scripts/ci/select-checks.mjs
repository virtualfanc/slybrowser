import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const systems = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
const platformSupport = JSON.parse(readFileSync(new URL('../../contracts/platform-support.json', import.meta.url), 'utf8'));
const allChecks = Object.freeze({ delivery: true, node: true, python: true, java: true, dotnet: true, audit: true });
const normalized = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '');
const matrix = (selected, versions, full) => selected
  ? (full ? systems.flatMap((os) => versions.map((version) => ({ os, version }))) : [{ os: 'ubuntu-latest', version: versions.at(-1) }])
  : [];

export function selectChecks(paths, { full = false } = {}) {
  const flags = full ? { ...allChecks } : { delivery: false, node: false, python: false, java: false, dotnet: false, audit: false };
  for (const rawPath of paths) {
    const file = normalized(rawPath);
    if (file.startsWith('packages/node/')) flags.node = true;
    else if (file.startsWith('packages/python/')) flags.python = true;
    else if (file.startsWith('packages/java/')) flags.java = true;
    else if (file.startsWith('packages/dotnet/')) flags.dotnet = true;
    else if (file.startsWith('scripts/delivery/') || file.startsWith('tests/delivery/')) flags.delivery = true;
    else if (file.startsWith('docs/') || file.startsWith('examples/') || /^(README|CHANGELOG)(\.|$)/i.test(file)) continue;
    else Object.assign(flags, allChecks);
    if (/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pyproject\.toml|pom\.xml|[^/]+\.csproj)$/.test(file)) flags.audit = true;
  }
  return {
    ...flags, full,
    deliveryMatrix: flags.delivery ? (full ? systems.map((os) => ({ os, version: '24' })) : [{ os: 'ubuntu-latest', version: '24' }]) : [],
    nodeMatrix: matrix(flags.node, ['20', '22', '24'], full),
    pythonMatrix: matrix(flags.python, ['3.10', '3.12', '3.14'], full),
    javaMatrix: matrix(flags.java, platformSupport.sdk.java.versions, full),
    dotnetMatrix: matrix(flags.dotnet, ['8.0.x', '9.0.x', '10.0.x'], full),
  };
}

function diffPaths(base, head, repo) {
  if (!/^[a-f0-9]{40}$/i.test(base ?? '') || !/^[a-f0-9]{40}$/i.test(head ?? '') || /^0+$/.test(base)) return null;
  const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', base, head, '--'], { cwd: repo, encoding: 'utf8' });
  return diff.status === 0 ? diff.stdout.split(/\r?\n/).filter(Boolean) : null;
}

function main(arguments_) {
  let paths = null;
  let base = null;
  let head = null;
  let candidate = null;
  let repo = '.';
  let full = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === '--paths') paths = arguments_[++index]?.split(',').filter(Boolean) ?? [];
    else if (option === '--base') base = arguments_[++index];
    else if (option === '--head') head = arguments_[++index];
    else if (option === '--candidate') candidate = arguments_[++index];
    else if (option === '--repo') repo = arguments_[++index];
    else if (option === '--full') full = true;
    else throw new Error(`Unknown CI scope option: ${option}`);
  }
  if (full && (!/^[a-f0-9]{40}$/i.test(candidate ?? '') || candidate !== head)) {
    throw new Error('Frozen full-matrix candidate identity mismatch with checked-out head');
  }
  const changed = paths ?? diffPaths(base, head, repo);
  const selection = selectChecks(changed ?? ['unknown/changed-paths'], { full });
  const output = {
    delivery: selection.delivery, node: selection.node, python: selection.python, java: selection.java, dotnet: selection.dotnet, audit: selection.audit,
    delivery_matrix: selection.deliveryMatrix, node_matrix: selection.nodeMatrix, python_matrix: selection.pythonMatrix,
    java_matrix: selection.javaMatrix, dotnet_matrix: selection.dotnetMatrix,
  };
  const lines = Object.entries(output).map(([key, value]) => `${key}=${typeof value === 'boolean' ? value : JSON.stringify(value)}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
