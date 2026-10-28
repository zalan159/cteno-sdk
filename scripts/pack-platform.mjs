#!/usr/bin/env node
/**
 * Build the per-platform daemon packages of the SDK from a daemon bundle.
 *
 *   node scripts/pack-platform.mjs --payload <dir|.tar.gz> --target <t> --out <dir> [--wheel]
 *
 * <t> is one of darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.
 * The payload is a released daemon bundle `cteno-sdk-daemon-<daemon>-<t>.tar.gz`
 * (or its extracted directory): bin/ (cteno-host-cli, cteno-wiki, secret-exec,
 * rg), tools/ skills/ agents/, manifest.json and LICENSE.daemon. The SDK
 * version comes from js/package.json and python/pyproject.toml.
 *
 * Output:
 *   <out>/npm/sdk-<t>/                              npm package @cteno/sdk-<t> (os/cpu restricted)
 *   <out>/wheel/cteno_sdk-<v>-py3-none-<tag>.whl    (with --wheel)
 *
 * The daemon binaries are proprietary; the packages carry LICENSE.daemon,
 * not the SDK's MIT LICENSE. Wheels are written directly (zip + RECORD), so
 * any machine can produce every platform's wheel without a compiler.
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Public-repo layout; the monorepo wrapper passes its own paths. */
export const PUBLIC_LAYOUT = {
  license: join(here, 'LICENSE.daemon'),
  pyproject: join(here, 'python/pyproject.toml'),
  pythonPackage: join(here, 'python/cteno_sdk'),
  pythonReadme: join(here, 'python/README.md'),
  jsPackage: join(here, 'js/package.json'),
};
export function parseArgs(argv) {
  return Object.fromEntries(argv.reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []));
}

export const TARGETS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', wheel: 'macosx_11_0_arm64', exe: '' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', wheel: 'macosx_10_15_x86_64', exe: '' },
  'linux-x64': { os: 'linux', cpu: 'x64', wheel: 'manylinux_2_34_x86_64', exe: '' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', wheel: 'manylinux_2_34_aarch64', exe: '' },
  'win32-x64': { os: 'win32', cpu: 'x64', wheel: 'win_amd64', exe: '.exe' },
};
const BINARIES = ['cteno-host-cli', 'cteno-wiki', 'secret-exec', 'rg'];
const REQUIRED = new Set(['cteno-host-cli']);

function fail(message) { console.error(`pack-platform: ${message}`); process.exit(2); }

/** Lay out bin/ + resources + manifest + license under `dir`. */
export function stagePayload({ dir, target, binDir, resources, daemonVersion, license }) {
  const t = TARGETS[target];
  if (!t) fail(`unknown target ${target}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const shipped = [];
  for (const name of BINARIES) {
    const file = name + t.exe;
    const from = join(binDir, file);
    if (!existsSync(from)) {
      if (REQUIRED.has(name)) fail(`missing ${from}`);
      console.warn(`pack-platform: ${file} not found in ${binDir}; skipping (feature degrades)`);
      continue;
    }
    cpSync(from, join(dir, 'bin', file));
    if (!t.exe) chmodSync(join(dir, 'bin', file), 0o755);
    shipped.push(file);
  }
  for (const sub of ['tools', 'skills', 'agents']) {
    const from = join(resources, sub);
    if (existsSync(from)) cpSync(from, join(dir, sub), { recursive: true });
    else mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, sku: 'sdk-core', version: daemonVersion, target, binaries: shipped,
  }, null, 2) + '\n');
  cpSync(license, join(dir, 'LICENSE.daemon'));
  return shipped;
}

/** Extract a bundle tarball (or accept a directory); returns the payload dir. */
export function openPayload(payload) {
  if (statSync(payload).isDirectory()) return payload;
  const dir = join(tmpdir(), `cteno-sdk-payload-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', payload, '-C', dir], { stdio: 'inherit' });
  return dir;
}

/** Copy a staged payload (bin/, resources, manifest, license) into `dir`. */
function copyPayload(payloadDir, dir) {
  for (const name of readdirSync(payloadDir)) cpSync(join(payloadDir, name), join(dir, name), { recursive: true });
  return JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'));
}

export function npmPackage({ out, target, version, payloadDir }) {
  const t = TARGETS[target];
  if (!t) fail(`unknown target ${target}`);
  const dir = join(out, 'npm', `sdk-${target}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const manifest = copyPayload(payloadDir, dir);
  if (manifest.target !== target) fail(`payload is for ${manifest.target}, not ${target}`);
  const daemonVersion = manifest.version;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@cteno/sdk-${target}`,
    version,
    description: `Bundled Cteno daemon (cteno-host-cli ${daemonVersion}) for @cteno/sdk on ${target}`,
    license: 'SEE LICENSE IN LICENSE.daemon',
    homepage: 'https://github.com/zalan159/cteno-sdk#readme',
    repository: { type: 'git', url: 'git+https://github.com/zalan159/cteno-sdk.git' },
    os: [t.os], cpu: [t.cpu],
    files: ['bin', 'tools', 'skills', 'agents', 'manifest.json', 'LICENSE.daemon', 'README.md'],
    preferUnplugged: true,
    cteno: { daemonVersion },
    publishConfig: { access: 'public', provenance: true },
  }, null, 2) + '\n');
  writeFileSync(join(dir, 'README.md'),
    `# @cteno/sdk-${target}\n\nThe Cteno daemon binary for \`@cteno/sdk\` on ${target}. ` +
    'Install `@cteno/sdk`; npm picks this package automatically. Do not depend on it directly.\n\n' +
    'The binaries are not MIT; see LICENSE.daemon in this package. The SDK client itself is MIT.\n');
  return dir;
}

// ---- minimal wheel writer (zip + RECORD), no build backend needed ----

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(path, entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((mode ?? 0o644) | 0o100000) << 16 >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, ...centrals, end]));
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name === '__pycache__' || name.endsWith('.pyc')) continue;
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(p);
  }
  return out;
}

export function pyVersion(pyproject) {
  const toml = readFileSync(pyproject, 'utf8');
  return toml.match(/^version = "([^"]+)"/m)[1];
}

export function wheel({ out, target, payloadDir, layout }) {
  const t = TARGETS[target];
  const version = pyVersion(layout.pyproject);
  const stage = join(out, 'wheel-stage', target);
  rmSync(stage, { recursive: true, force: true });
  cpSync(layout.pythonPackage, join(stage, 'cteno_sdk'), { recursive: true });
  mkdirSync(join(stage, 'cteno_sdk', '_bin'), { recursive: true });
  copyPayload(payloadDir, join(stage, 'cteno_sdk', '_bin'));
  const dist = `cteno_sdk-${version}.dist-info`;
  const readme = readFileSync(layout.pythonReadme, 'utf8');
  const meta = [
    'Metadata-Version: 2.1', 'Name: cteno-sdk', `Version: ${version}`,
    'Summary: Python client for Cteno agents, with a bundled local daemon',
    'Home-page: https://github.com/zalan159/cteno-sdk', 'License: MIT (client); daemon binaries: see cteno_sdk/_bin/LICENSE.daemon',
    'Requires-Python: >=3.9', 'Description-Content-Type: text/markdown', '', readme,
  ].join('\n');
  const files = walk(stage).map(p => ({ name: relative(stage, p).split('\\').join('/'), data: readFileSync(p), mode: statSync(p).mode & 0o777 }));
  files.push({ name: `${dist}/METADATA`, data: Buffer.from(meta) });
  files.push({ name: `${dist}/WHEEL`, data: Buffer.from(`Wheel-Version: 1.0\nGenerator: cteno pack-platform\nRoot-Is-Purelib: false\nTag: py3-none-${t.wheel}\n`) });
  files.push({ name: `${dist}/top_level.txt`, data: Buffer.from('cteno_sdk\n') });
  const record = files.map(f => {
    const digest = createHash('sha256').update(f.data).digest('base64url');
    return `${f.name},sha256=${digest},${f.data.length}`;
  });
  record.push(`${dist}/RECORD,,`);
  files.push({ name: `${dist}/RECORD`, data: Buffer.from(record.join('\n') + '\n') });
  mkdirSync(join(out, 'wheel'), { recursive: true });
  const path = join(out, 'wheel', `cteno_sdk-${version}-py3-none-${t.wheel}.whl`);
  writeZip(path, files);
  rmSync(stage, { recursive: true, force: true });
  return path;
}

/**
 * Write a daemon bundle `cteno-sdk-daemon-<daemon>-<target>.tar.gz` from
 * release binaries + resources. Used by the (private) daemon release flow;
 * the public publish workflow consumes the tarball.
 */
export function bundle({ out, target, binDir, resources, daemonVersion, license }) {
  const stage = join(out, 'bundle-stage', target);
  rmSync(stage, { recursive: true, force: true });
  stagePayload({ dir: stage, target, binDir, resources, daemonVersion, license });
  mkdirSync(join(out, 'bundles'), { recursive: true });
  const file = join(out, 'bundles', `cteno-sdk-daemon-${daemonVersion}-${target}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', stage, '.'], { stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });
  return file;
}

export function main(argv, layout = PUBLIC_LAYOUT) {
  const args = parseArgs(argv);
  const { target, payload, out } = args;
  if (!target || !payload || !out) fail('usage: --payload <dir|tar.gz> --target <t> --out <dir> [--wheel]');
  const version = JSON.parse(readFileSync(layout.jsPackage, 'utf8')).version;
  const py = pyVersion(layout.pyproject);
  if (version !== py) fail(`js/package.json ${version} != python/pyproject.toml ${py}`);
  const payloadDir = openPayload(resolve(payload));
  const outDir = resolve(out);
  console.log(npmPackage({ out: outDir, target, version, payloadDir }));
  if (args.wheel) console.log(wheel({ out: outDir, target, payloadDir, layout }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
