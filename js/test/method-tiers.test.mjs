/**
 * Method-tier tests.
 *
 * Two different jobs here:
 *
 * 1. The classifier behaves (prefix families, scoped names, unknowns).
 * 2. The table is well-formed. The drift check against the daemon's own method
 *    table lives next to the daemon source (monorepo-only), so the public
 *    package stays self-contained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { methodTier, isStableMethod, STABLE_METHODS } = await import('../dist/method-tiers.js');

test('stable product methods are graded stable', () => {
  for (const method of ['list-sessions', 'create-thread', 'send-thread-message',
                        'get-session-trace', 'workspace-read', 'list-profiles']) {
    assert.equal(methodTier(method), 'stable', `${method} should be stable`);
    assert.ok(isStableMethod(method));
  }
});

test('credential and lifecycle internals are graded internal', () => {
  for (const method of ['auth-get-credentials', 'managed-llm-keys-save',
                        'secret-prompt-submit', 'browser-pane-open',
                        'install-host-plugin-package', '__rpc.hello',
                        '__test.call-via-target', 'get-dashboard']) {
    assert.equal(methodTier(method), 'internal', `${method} should be internal`);
    assert.equal(isStableMethod(method), false);
  }
});

test('unknown methods are reported as unknown, not silently blessed', () => {
  assert.equal(methodTier('totally-made-up-method'), 'unknown');
  assert.equal(isStableMethod('totally-made-up-method'), false);
});

test('scoped names are normalised before classification', () => {
  const scoped = 'cteno-11111111-2222-3333-4444-555555555555:list-sessions';
  assert.equal(methodTier(scoped), 'stable');
  assert.equal(methodTier('cteno-abc:auth-get-credentials'), 'internal');
});

test('the stable list has no duplicates and no scoped names', () => {
  assert.equal(new Set(STABLE_METHODS).size, STABLE_METHODS.length,
    'duplicate entry in STABLE_METHODS');
  for (const method of STABLE_METHODS) {
    assert.ok(!method.includes(':'), `${method} must be unscoped`);
    assert.equal(method.trim(), method, `${method} has stray whitespace`);
  }
});
