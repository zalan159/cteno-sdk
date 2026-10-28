/**
 * Owner-socket discovery: which socket files count as daemon endpoints.
 *
 * The daemon names its owner socket `host[.<tag>].sock` under a `.d<hash>`
 * host root: `host.sock` (desktop release), `host.dev.sock` (dev), and e.g.
 * `host.host.sock` for a headless `cteno-host-cli serve` (CTENO_ENV=host).
 * Discovery must find every one of those, and must never offer the public
 * listener (`host.sock.public`) or a regular file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { discoverOwnerEndpoints } = await import('../dist/discover.js');

const posix = process.platform !== 'win32';

async function listenAt(path) {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(path, resolve));
  return server;
}

test('finds desktop, dev and headless owner sockets; skips public listener and plain files', { skip: !posix }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cteno-discover-'));
  const servers = [];
  t.after(() => {
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.CTENO_HOST_ROOT;
  });
  for (const name of ['host.sock', 'host.dev.sock', 'host.host.sock', 'host.sock.public']) {
    servers.push(await listenAt(join(root, name)));
  }
  writeFileSync(join(root, 'host.stale.sock'), 'not a socket');

  process.env.CTENO_HOST_ROOT = root;
  const found = discoverOwnerEndpoints().map(e => e.path.slice(root.length + 1));
  assert.deepEqual(found, ['host.dev.sock', 'host.host.sock', 'host.sock']);
});

test('headless daemon under XDG data dir is discovered without CTENO_HOST_ROOT', { skip: process.platform !== 'linux' }, async t => {
  const xdg = mkdtempSync(join(tmpdir(), 'cteno-xdg-'));
  const hostRoot = join(xdg, '.d4078');
  mkdirSync(hostRoot);
  const server = await listenAt(join(hostRoot, 'host.host.sock'));
  const saved = process.env.XDG_DATA_HOME;
  t.after(() => {
    server.close();
    rmSync(xdg, { recursive: true, force: true });
    if (saved === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved;
  });
  delete process.env.CTENO_HOST_ROOT;
  process.env.XDG_DATA_HOME = xdg;
  const found = discoverOwnerEndpoints().map(e => e.path);
  assert.ok(found.includes(join(hostRoot, 'host.host.sock')), `got ${JSON.stringify(found)}`);
});
