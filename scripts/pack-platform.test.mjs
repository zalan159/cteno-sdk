import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { npmPackage, openPayload, stagePayload, walk, wheel } from './pack-platform.mjs';

test('archive paths containing a colon are local files, not tar remote hosts', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-tar-'));
  let extracted;
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync(join(root, 'source'));
    writeFileSync(join(root, 'source', 'proof'), 'local payload');
    // A colon in the filename reproduces GNU tar remote-host parsing on POSIX.
    const name = process.platform === 'win32' ? 'payload.tar.gz' : 'D:payload.tar.gz';
    execFileSync('tar', ['-czf', `./${name}`, '-C', 'source', '.'], { cwd: root });
    extracted = openPayload(process.platform === 'win32' ? join(root, name) : name);
    assert.equal(readFileSync(join(extracted, 'proof'), 'utf8'), 'local payload');
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
    if (extracted) rmSync(extracted, { recursive: true, force: true });
  }
});

test('dangling symlinks in payload or resources are skipped with a warning and do not break wheel or npm packaging', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-symlink-'));
  try {
    const binDir = join(root, 'bin');
    const resources = join(root, 'resources');
    mkdirSync(binDir, { recursive: true });
    for (const b of ['cteno-host-cli', 'cteno-wiki', 'secret-exec', 'rg']) {
      writeFileSync(join(binDir, b), '#!/bin/sh\n', { mode: 0o755 });
    }
    for (const d of ['tools', 'skills', 'agents', 'plugins']) {
      mkdirSync(join(resources, d), { recursive: true });
      writeFileSync(join(resources, d, 'fixture.txt'), 'ok');
    }
    const tzDir = join(resources, 'plugins', 'System', 'Library', 'Templates', 'Data', 'private', 'var', 'db', 'timezone');
    mkdirSync(tzDir, { recursive: true });
    symlinkSync('/nonexistent/usr/share/zoneinfo.default', join(tzDir, 'zoneinfo'));

    const license = join(root, 'LICENSE.daemon');
    writeFileSync(license, 'Proprietary\n');

    const payloadDir = join(root, 'payload');
    stagePayload({ dir: payloadDir, target: 'linux-x64', binDir, resources, daemonVersion: '2.11.5', license });

    // Even if a pre-built payload tarball already contains a dangling symlink, wheel() and npmPackage() must survive it.
    const payloadTzDir = join(payloadDir, 'plugins', 'System', 'Library', 'Templates', 'Data', 'private', 'var', 'db', 'timezone');
    mkdirSync(payloadTzDir, { recursive: true });
    const danglingInPayload = join(payloadTzDir, 'zoneinfo');
    try { rmSync(danglingInPayload, { force: true }); } catch {}
    symlinkSync('/nonexistent/usr/share/zoneinfo.default', danglingInPayload);
    assert.equal(lstatSync(danglingInPayload).isSymbolicLink(), true);

    const layout = {
      license,
      pyproject: join(root, 'pyproject.toml'),
      pythonPackage: join(root, 'cteno_sdk'),
      pythonReadme: join(root, 'README.md'),
      jsPackage: join(root, 'package.json'),
    };
    mkdirSync(layout.pythonPackage, { recursive: true });
    writeFileSync(join(layout.pythonPackage, '__init__.py'), '__version__ = "2.11.5"\n');
    writeFileSync(layout.pyproject, '[project]\nname = "cteno-sdk"\nversion = "2.11.5"\n');
    writeFileSync(layout.pythonReadme, '# cteno-sdk\n');
    writeFileSync(layout.jsPackage, JSON.stringify({ name: '@cteno/sdk', version: '2.11.5' }));

    const out = join(root, 'out');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let whlPath, npmDir, walked;
    try {
      walked = walk(payloadDir);
      npmDir = npmPackage({ out, target: 'linux-x64', version: '2.11.5', payloadDir });
      whlPath = wheel({ out, target: 'linux-x64', payloadDir, layout });
    } finally {
      console.warn = origWarn;
    }

    assert.equal(walked.some((p) => p.endsWith('zoneinfo')), false);
    assert.equal(existsSync(whlPath), true);
    assert.equal(existsSync(join(npmDir, 'package.json')), true);
    assert.ok(warnings.some((w) => w.includes('zoneinfo')), `expected warning mentioning zoneinfo, got: ${warnings.join('\n')}`);
    assert.throws(() => lstatSync(join(npmDir, 'plugins', 'System', 'Library', 'Templates', 'Data', 'private', 'var', 'db', 'timezone', 'zoneinfo')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
