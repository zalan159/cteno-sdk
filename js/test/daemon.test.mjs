/**
 * Bundled-daemon unit tests: platform mapping, isolation layout, the
 * environment the daemon gets (nothing inherited from a Cteno app), pipe-name
 * parity with the Rust daemon, upgrade policy, and approval-row parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const daemon = await import('../dist/daemon.js');
const core = await import('../dist/core.js');

test('platform package per os/arch, null when unsupported', () => {
  assert.equal(daemon.platformPackageName('darwin', 'arm64'), '@cteno/sdk-darwin-arm64');
  assert.equal(daemon.platformPackageName('darwin', 'x64'), '@cteno/sdk-darwin-x64');
  assert.equal(daemon.platformPackageName('linux', 'x64'), '@cteno/sdk-linux-x64');
  assert.equal(daemon.platformPackageName('linux', 'arm64'), '@cteno/sdk-linux-arm64');
  assert.equal(daemon.platformPackageName('win32', 'x64'), '@cteno/sdk-win32-x64');
  assert.equal(daemon.platformPackageName('freebsd', 'x64'), null);
  assert.equal(daemon.platformPackageName('win32', 'arm64'), null);
});

test('instance layout lives under one root, never the GUI data dir', () => {
  const root = join('/tmp', 'sdk-root');
  const layout = daemon.instanceLayout(root);
  assert.equal(layout.dataDir, join(root, 'data'));
  assert.equal(layout.hostRoot, join(root, 'run'));
  assert.equal(layout.logFile, join(root, 'logs', 'daemon.log'));
  if (process.platform !== 'win32') assert.equal(layout.endpoint, join(root, 'run', 'host.host.sock'));
  assert.ok(!daemon.defaultInstanceRoot().includes('com.cteno-host'));
});

test('CTENO_SDK_HOME overrides the default root', () => {
  const saved = process.env.CTENO_SDK_HOME;
  process.env.CTENO_SDK_HOME = '/tmp/custom-sdk-home';
  try { assert.equal(daemon.defaultInstanceRoot(), '/tmp/custom-sdk-home'); }
  finally { if (saved === undefined) delete process.env.CTENO_SDK_HOME; else process.env.CTENO_SDK_HOME = saved; }
});

test('daemon environment strips everything a Cteno app could leak', () => {
  const layout = daemon.instanceLayout('/tmp/r');
  const binary = { path: '/x/bin/cteno-host-cli', binDir: '/x/bin', resourceDir: '/x', version: '1', source: 'package' };
  const env = daemon.daemonEnvironment(layout, binary, {
    PATH: '/usr/bin', HOME: '/u',
    CTENO_APP_DATA_DIR: '/gui/data', CTENO_HOST_ROOT: '/gui/run', cteno_env: 'dev',
    CTENO_HAPPY_SERVER_URL: 'https://cloud', EXPO_PUBLIC_CTENO_X: '1',
    SECRET_VAULT_DIR: '/gui/vault', FNOX_AGE_KEY: 'k', FNOX_AGE_KEY_FILE: '/k',
  });
  assert.equal(env.HOME, '/u');
  assert.ok(env.PATH.startsWith('/x/bin'));
  assert.equal(env.CTENO_ISOLATED_ROOT, '/tmp/r');
  assert.equal(env.CTENO_APP_DATA_DIR, layout.dataDir);
  assert.equal(env.CTENO_HOST_ROOT, layout.hostRoot);
  assert.equal(env.CTENO_ENV, 'host');
  assert.equal(env.CTENO_SDK_MANAGED, '1');
  for (const k of ['CTENO_HAPPY_SERVER_URL', 'cteno_env', 'EXPO_PUBLIC_CTENO_X', 'SECRET_VAULT_DIR', 'FNOX_AGE_KEY', 'FNOX_AGE_KEY_FILE']) {
    assert.equal(env[k], undefined, k);
  }
  const withExtra = daemon.daemonEnvironment(layout, binary, {}, { CTENO_HAPPY_SERVER_URL: 'https://mine' });
  assert.equal(withExtra.CTENO_HAPPY_SERVER_URL, 'https://mine');
});

test('pipe name matches the Rust daemon test vectors', () => {
  assert.equal(daemon.isolatedPipeName(''), '\\\\.\\pipe\\cteno-sdk-cbf29ce484222325');
  assert.equal(daemon.isolatedPipeName('a'), '\\\\.\\pipe\\cteno-sdk-af63dc4c8601ec8c');
  assert.equal(daemon.isolatedPipeName('C:\\Users\\x\\AppData\\Local\\cteno-sdk', 'host'),
    '\\\\.\\pipe\\cteno-sdk-91d1e156813077ec-host');
});

test('upgrade only replaces a strictly older daemon', () => {
  assert.equal(daemon.compareVersions('2.10.10', '2.9.28'), 1);
  assert.equal(daemon.compareVersions('2.10.10', '2.10.10'), 0);
  assert.equal(daemon.compareVersions('2.10', '2.10.0'), 0);
  assert.equal(daemon.compareVersions('2.10.9-rc.1', '2.10.10'), -1);
  assert.equal(daemon.needsUpgrade('2.10.9', '2.10.10'), true);
  assert.equal(daemon.needsUpgrade('2.10.10', '2.10.10'), false);
  assert.equal(daemon.needsUpgrade('2.11.0', '2.10.10'), false);
  assert.equal(daemon.needsUpgrade(null, '2.10.10'), true);
  assert.equal(daemon.needsUpgrade('2.10.9', null), false);
});

const row = data => ({ text: JSON.stringify({ content: { data }, role: 'agent' }) });

test('parked tool-result is a card approval named after its tool call', () => {
  const calls = new Map();
  assert.equal(core.permissionRequestOf(row({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'ls' } }), 's', calls), null);
  const req = core.permissionRequestOf(row({ type: 'tool-result', callId: 'c1',
    output: JSON.stringify({ verdict: 'pending', proceed: false, cardId: 'card_1', permissionPending: true }) }), 's', calls);
  assert.deepEqual(req, { sessionId: 's', id: 'card_1', toolName: 'Bash', input: { command: 'ls' }, via: 'card' });
  assert.equal(core.permissionRequestOf(row({ type: 'tool-result', callId: 'c2', output: 'plain output' }), 's', calls), null);
});

test('legacy permission-request is a session approval', () => {
  const req = core.permissionRequestOf(row({ type: 'permission-request', permissionId: 'p1', toolName: 'edit', options: { a: 1 } }), 's');
  assert.equal(req.via, 'session');
  assert.equal(req.id, 'p1');
  assert.equal(req.toolName, 'edit');
});

test('resumed turn is recognised by its confirmation task_complete', () => {
  assert.equal(core.resumedCardOf(row({ type: 'task_complete', id: 'confirmation:card_9' })), 'card_9');
  assert.equal(core.resumedCardOf(row({ type: 'task_complete', id: 'turn-1' })), null);
  assert.equal(core.resumedCardOf(row({ type: 'task_started', id: 'confirmation:card_9' })), null);
  assert.equal(core.resumedCardOf({ text: 'not json confirmation:' }), null);
});

test('lockHeld: live pid holds, dead pid or garbage does not', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cteno-lock-'));
  const lock = join(dir, 'host.lock');
  assert.equal(daemon.lockHeld(lock), false);
  writeFileSync(lock, `${process.pid}\n`);
  assert.equal(daemon.lockHeld(lock), true);
  writeFileSync(lock, '2147483646\n');
  assert.equal(daemon.lockHeld(lock), false);
  writeFileSync(lock, 'junk');
  assert.equal(daemon.lockHeld(lock), false);
});

test('over-long daemon home fails at once with CONFIG, bytes and the limit', { skip: process.platform === 'win32' }, async () => {
  const home = join('/tmp', 'x'.repeat(130));
  const started = Date.now();
  await assert.rejects(daemon.ensureDaemon({ home, startTimeoutMs: 20_000 }), error => {
    assert.equal(error.code, 'CONFIG');
    assert.match(error.message, /socket path .*host\.host\.sock is \d+ bytes, max 10[37]/);
    return true;
  });
  assert.ok(Date.now() - started < 1000, 'must not wait for a start timeout');
  assert.equal(daemon.socketPathLimit('darwin'), 103);
  assert.equal(daemon.socketPathLimit('linux'), 107);
  assert.equal(daemon.socketPathLimit('win32'), null);
});

test('a daemon that prints CTENO_DAEMON_FATAL and exits fails ensureDaemon fast with that line', { skip: process.platform === 'win32' }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sdkf-'));
  const fake = join(dir, 'cteno-host-cli');
  // 200 lines of startup chatter with the fatal line in the middle: a 2000
  // byte tail alone would lose it.
  writeFileSync(fake, [
    '#!/bin/sh',
    'i=0; while [ $i -lt 90 ]; do echo "[inbox] startup chatter line $i"; i=$((i+1)); done',
    'echo "[LocalRPC] Failed to bind /x/run/host.host.sock: Address already in use" ',
    'echo "CTENO_DAEMON_FATAL bind_failed: Failed to bind /x/run/host.host.sock: Address already in use" >&2',
    'i=0; while [ $i -lt 110 ]; do echo "[scheduler] more chatter $i"; i=$((i+1)); done',
    'exit 78',
  ].join('\n'));
  chmodSync(fake, 0o755);
  const saved = process.env.CTENO_SDK_DAEMON_PATH;
  process.env.CTENO_SDK_DAEMON_PATH = fake;
  const started = Date.now();
  try {
    await assert.rejects(daemon.ensureDaemon({ home: join(dir, 'h'), startTimeoutMs: 20_000 }), error => {
      assert.equal(error.code, 'TRANSPORT');
      assert.match(error.message, /CTENO_DAEMON_FATAL bind_failed: Failed to bind \/x\/run\/host\.host\.sock: Address already in use/);
      return true;
    });
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
  } finally {
    if (saved === undefined) delete process.env.CTENO_SDK_DAEMON_PATH; else process.env.CTENO_SDK_DAEMON_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
