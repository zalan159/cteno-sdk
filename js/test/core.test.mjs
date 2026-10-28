/**
 * Core SDK unit tests.
 *
 * These run against an in-process fake owner socket, so they prove the CLIENT
 * behaves (framing, subscription ordering, turn boundaries, decoding, cleanup)
 * — they deliberately prove NOTHING about a model running. That is what
 * `scripts/test-core-sdk-e2e.mjs` is for, against a real daemon.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { query, CtenoSession } = await import('../dist/core.js');

const MACHINE = 'cteno-11111111-2222-3333-4444-555555555555';

/**
 * A minimal stand-in for the daemon's owner socket.
 *
 * Speaks the real newline-delimited envelope and the real method names, so a
 * client change that breaks the wire breaks these tests.
 */
function startFakeHost(handlers = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cteno-core-sdk-test-'));
  const path = join(dir, 'host.dev.sock');
  const connections = new Set();
  const server = createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        const unscoped = request.method.startsWith(`${MACHINE}:`)
          ? request.method.slice(MACHINE.length + 1)
          : request.method;
        const reply = value => socket.write(JSON.stringify({ requestId: request.requestId, ...value }) + '\n');
        const push = (channel, payload) => socket.write(JSON.stringify({
          method: 'local-session-event', params: { channel, payload },
        }) + '\n');

        if (unscoped === 'list-local-rpc-methods') { reply({ result: { machineId: MACHINE, methods: [] } }); continue; }
        if (unscoped === '__rpc.subscribe') { reply({ result: { subscribed: true } }); continue; }
        const handler = handlers[unscoped];
        if (!handler) { reply({ error: `Unknown method: ${request.method}` }); continue; }
        Promise.resolve(handler(request.params ?? {}, { push, reply, raw: frame => socket.write(JSON.stringify(frame) + '\n') })).then(result => {
          if (result !== undefined) reply({ result });
        });
      }
    });
  });
  return new Promise(resolve => {
    server.listen(path, () => resolve({
      path,
      close: () => {
        for (const socket of connections) socket.destroy();
        server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    }));
  });
}

test('query streams a turn and ends on result', async () => {
  const host = await startFakeHost({
    'create-thread': () => ({ success: true, sessionId: 's1' }),
    'send-thread-message': async (params, { push }) => {
      push('local-session:message-appended', {
        sessionId: 's1', message: { id: 'm1', role: 'user', text: params.message },
      });
      push('local-session:alive', { sessionId: 's1', thinking: true });
      push('local-session:message-appended', {
        sessionId: 's1', message: { id: 'm2', role: 'assistant', text: 'PONG' },
      });
      return { success: true, waited: true };
    },
    'close-session': () => ({ success: true }),
  });
  try {
    const seen = [];
    for await (const message of query({ prompt: 'ping', socketPath: host.path })) seen.push(message);
    assert.equal(seen.at(-1).type, 'result');
    assert.equal(seen.at(-1).ok, true);
    assert.ok(seen.some(m => m.type === 'user' && m.text === 'ping'));
    assert.ok(seen.some(m => m.type === 'assistant' && m.text === 'PONG'));
    assert.ok(seen.some(m => m.type === 'status' && m.thinking === true));
  } finally { host.close(); }
});

test('query surfaces a host-reported turn failure without throwing', async () => {
  const host = await startFakeHost({
    'create-thread': () => ({ success: true, sessionId: 's1' }),
    'send-thread-message': () => ({ success: false, error: 'model unavailable' }),
    'close-session': () => ({ success: true }),
  });
  try {
    const seen = [];
    for await (const message of query({ prompt: 'ping', socketPath: host.path })) seen.push(message);
    const result = seen.at(-1);
    assert.equal(result.type, 'result');
    assert.equal(result.ok, false);
    assert.match(result.error, /model unavailable/);
  } finally { host.close(); }
});

test('create failure rejects with the host error text', async () => {
  const host = await startFakeHost({ 'create-thread': () => ({ success: false, error: 'bad workdir' }) });
  try {
    await assert.rejects(
      (async () => { for await (const _ of query({ prompt: 'x', socketPath: host.path })) { /* drain */ } })(),
      /bad workdir/,
    );
  } finally { host.close(); }
});

test('events for other sessions are ignored', async () => {
  const host = await startFakeHost({
    'create-thread': () => ({ success: true, sessionId: 's1' }),
    'send-thread-message': async (_params, { push }) => {
      push('local-session:message-appended', {
        sessionId: 'OTHER', message: { id: 'x', role: 'assistant', text: 'leak' },
      });
      push('local-session:message-appended', {
        sessionId: 's1', message: { id: 'm2', role: 'assistant', text: 'mine' },
      });
      return { success: true };
    },
    'close-session': () => ({ success: true }),
  });
  try {
    const seen = [];
    for await (const message of query({ prompt: 'ping', socketPath: host.path })) seen.push(message);
    assert.ok(!seen.some(m => m.text === 'leak'));
    assert.ok(seen.some(m => m.text === 'mine'));
  } finally { host.close(); }
});

test('live tool-call and tool-result frames reach the consumer intact', async () => {
  // These are the exact envelopes the runtime pushes through AcpMessageSender
  // (autonomous_agent.rs) and the host wraps as an `acp` content frame. A
  // consumer that wants Claude-Code-style tool visibility reads them off
  // `message.data`, so the shape is part of the contract.
  const acp = payload => JSON.stringify({
    role: 'agent',
    content: { type: 'acp', provider: 'cteno', data: payload },
  });
  const host = await startFakeHost({
    'create-thread': () => ({ success: true, sessionId: 's1' }),
    'send-thread-message': async (_params, { push }) => {
      push('local-session:message-appended', {
        sessionId: 's1',
        message: { id: 'm1', role: 'assistant', text: acp({
          type: 'tool-call', callId: 'call-7', name: 'shell',
          input: { command: 'echo hi' }, id: 'u1',
        }) },
      });
      push('local-session:message-appended', {
        sessionId: 's1',
        message: { id: 'm2', role: 'assistant', text: acp({
          type: 'tool-result', callId: 'call-7', output: 'hi', isError: false,
        }) },
      });
      return { success: true };
    },
    'close-session': () => ({ success: true }),
  });
  try {
    const frames = [];
    for await (const message of query({ prompt: 'ping', socketPath: host.path })) {
      if (message.type === 'assistant' && message.data?.content?.type === 'acp') {
        frames.push(message.data.content.data);
      }
    }
    const call = frames.find(f => f.type === 'tool-call');
    assert.ok(call, 'tool-call frame must be visible to the consumer');
    assert.equal(call.name, 'shell');
    assert.equal(call.callId, 'call-7');
    assert.deepEqual(call.input, { command: 'echo hi' });

    const result = frames.find(f => f.type === 'tool-result');
    assert.ok(result, 'tool-result frame must be visible to the consumer');
    assert.equal(result.callId, 'call-7', 'result must be correlatable to its call');
    assert.equal(result.isError, false);
  } finally { host.close(); }
});

test('structured assistant envelopes expose text and parsed data', async () => {
  const envelope = JSON.stringify({ content: { data: { message: 'human readable' }, type: 'notice' } });
  const host = await startFakeHost({
    'create-thread': () => ({ success: true, sessionId: 's1' }),
    'send-thread-message': async (_params, { push }) => {
      push('local-session:message-appended', {
        sessionId: 's1', message: { id: 'm2', role: 'assistant', text: envelope },
      });
      return { success: true };
    },
    'close-session': () => ({ success: true }),
  });
  try {
    let assistant;
    for await (const message of query({ prompt: 'ping', socketPath: host.path })) {
      if (message.type === 'assistant') assistant = message;
    }
    assert.equal(assistant.text, 'human readable');
    assert.equal(assistant.data.content.type, 'notice');
  } finally { host.close(); }
});

test('query does not close a session it did not create', async () => {
  let closed = 0;
  const host = await startFakeHost({
    'send-thread-message': () => ({ success: true }),
    'close-session': () => { closed += 1; return { success: true }; },
  });
  try {
    for await (const _ of query({ prompt: 'ping', sessionId: 'caller-owned', socketPath: host.path })) { /* drain */ }
    assert.equal(closed, 0, 'caller-supplied session must survive the stream');
  } finally { host.close(); }
});

test('breaking out of the stream still releases the connection', async () => {
  const host = await startFakeHost({
    'create-thread': () => ({ success: true, sessionId: 's1' }),
    'send-thread-message': async (_params, { push }) => {
      push('local-session:message-appended', {
        sessionId: 's1', message: { id: 'm2', role: 'assistant', text: 'first' },
      });
      // Never resolves: the turn is still "running" when the caller leaves.
      return new Promise(() => {});
    },
    'close-session': () => ({ success: true }),
  });
  try {
    for await (const message of query({ prompt: 'ping', socketPath: host.path })) {
      if (message.type === 'assistant') break;
    }
    // Reaching here without hanging is the assertion.
    assert.ok(true);
  } finally { host.close(); }
});

test('unreachable socket produces an actionable transport error', async () => {
  await assert.rejects(
    CtenoSession.open({ socketPath: '/nonexistent/cteno-core-sdk.sock', timeoutMs: 1000 }),
    error => error.code === 'TRANSPORT',
  );
});

test('listSessions and listProfiles normalize host rows', async () => {
  const host = await startFakeHost({
    'list-sessions': () => ({ sessions: [{ id: 's1', title: 'T', path: '/tmp', active: true, activeAt: 42 }] }),
    'list-profiles': () => ({ profiles: [{ id: 'p1', name: 'Test', chat: { model: 'm1' } }] }),
  });
  try {
    const client = await CtenoSession.open({ socketPath: host.path });
    const sessions = await client.listSessions();
    assert.deepEqual(sessions, [{ id: 's1', title: 'T', workdir: '/tmp', active: true, updatedAt: 42 }]);
    const profiles = await client.listProfiles();
    assert.deepEqual(profiles, [{ id: 'p1', name: 'Test', model: 'm1' }]);
    client.dispose();
  } finally { host.close(); }
});

test('listSessions reads title/workdir from daemon metadata rows', async () => {
  // Real daemon rows carry the title and path under `metadata`, not top level.
  const host = await startFakeHost({
    'list-sessions': () => ({ sessions: [{ id: 's2', active: false, activeAt: 7, metadata: { name: 'From meta', path: '/w' } }] }),
  });
  try {
    const client = await CtenoSession.open({ socketPath: host.path });
    assert.deepEqual(await client.listSessions(), [{ id: 's2', title: 'From meta', workdir: '/w', active: false, updatedAt: 7 }]);
    client.dispose();
  } finally { host.close(); }
});

test('create with a spec fails clearly on a daemon without sdk-session-spec-v1', async () => {
  let created = false;
  const host = await startFakeHost({
    '__rpc.hello': () => ({ capabilities: ['hooks-subscribe-v1'] }),
    'create-thread': () => { created = true; return { success: true, sessionId: 's1' }; },
  });
  const session = await CtenoSession.open({ socketPath: host.path });
  try {
    await assert.rejects(session.create({ spec: { systemPrompt: 'x' } }), error =>
      error.code === 'PROTOCOL' && /sdk-session-spec-v1/.test(error.message) && /2\.10\.10/.test(error.message));
    assert.equal(created, false, 'no session may be created when the spec would be ignored');
  } finally { session.dispose(); host.close(); }
});

test('create sends a relative cwd as an absolute path from the caller', async () => {
  let seen;
  const host = await startFakeHost({ 'create-thread': params => { seen = params; return { success: true, sessionId: 's1' }; } });
  const session = await CtenoSession.open({ socketPath: host.path });
  try {
    await session.create({ cwd: '.' });
    assert.equal(seen.workdir, process.cwd());
    await session.create({ cwd: '/abs/dir' });
    assert.equal(seen.workdir, '/abs/dir');
  } finally { session.dispose(); host.close(); }
});

test('call rejects an already-scoped method name', async () => {
  const host = await startFakeHost({});
  try {
    const client = await CtenoSession.open({ socketPath: host.path });
    await assert.rejects(client.call(`${MACHINE}:list-sessions`), /unscoped/);
    client.dispose();
  } finally { host.close(); }
});

test('trace camelCases the host snake_case event fields', async () => {
  const host = await startFakeHost({
    'get-session-trace': () => ({
      success: true,
      sessionId: 's1',
      events: [
        { seq: 0, timestamp: 't0', role: 'user', event_type: 'user_message', text: 'go' },
        { seq: 1, timestamp: 't1', role: 'assistant', event_type: 'tool_call', tool_name: 'read', call_id: 'c1' },
        { seq: 2, timestamp: 't2', role: 'assistant', event_type: 'tool_result', call_id: 'c1', is_error: true },
      ],
      summary: { total: 3, toolCalls: 1, toolResults: 1 },
    }),
  });
  try {
    const client = await CtenoSession.open({ socketPath: host.path });
    const trace = await client.trace('s1');
    assert.equal(trace.sessionId, 's1');
    assert.deepEqual(trace.summary, { total: 3, toolCalls: 1, toolResults: 1 });
    // The host wire is snake_case; consumers must only ever see camelCase.
    assert.deepEqual(trace.events.map(e => e.type),
      ['user_message', 'tool_call', 'tool_result']);
    assert.equal(trace.events[1].toolName, 'read');
    assert.equal(trace.events[1].callId, 'c1');
    assert.equal(trace.events[2].isError, true);
    assert.equal(trace.events[0].text, 'go');
    // No snake_case key survives the boundary.
    for (const event of trace.events) {
      for (const key of Object.keys(event)) assert.ok(!key.includes('_'), key);
    }
    client.dispose();
  } finally { host.close(); }
});

test('trace surfaces a host-reported failure as a REMOTE error', async () => {
  const host = await startFakeHost({
    'get-session-trace': () => ({ success: false, error: 'Session not found' }),
  });
  try {
    const client = await CtenoSession.open({ socketPath: host.path });
    await assert.rejects(client.trace('missing'), error =>
      error.code === 'REMOTE' && /Session not found/.test(error.message));
    client.dispose();
  } finally { host.close(); }
});

test('hooks.on subscribes, answers __hooks.call with the handler outcome, fails open on throw', async () => {
  const replies = [];
  let raw;
  const host = await startFakeHost({
    '__rpc.hello': () => ({ capabilities: ['hooks-subscribe-v1'] }),
    '__hooks.subscribe': (params, ctx) => {
      raw = ctx.raw;
      assert.deepEqual(params.events, [{ event: 'PreRpc', matcher: 'delete-session' }]);
      return { subscriptionId: 'hs-1', events: ['PreRpc'] };
    },
    '__hooks.reply': params => { replies.push(params); return { ok: true }; },
    '__hooks.unsubscribe': () => ({ unsubscribed: true }),
  });
  const session = await CtenoSession.open({ socketPath: host.path });
  try {
    let calls = 0;
    const off = await session.hooks.on('PreRpc', 'delete-session', call => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return { decision: 'deny', reason: `no ${call.matcher}` };
    });
    raw({ method: '__hooks.call', params: { callId: 'c1', subscriptionId: 'hs-1', hook_event_name: 'PreRpc', matcher: 'delete-session', payload: {} } });
    raw({ method: '__hooks.call', params: { callId: 'c2', subscriptionId: 'hs-1', hook_event_name: 'PreRpc', matcher: 'delete-session', payload: {} } });
    raw({ method: '__hooks.call', params: { callId: 'c3', subscriptionId: 'OTHER', hook_event_name: 'PreRpc', matcher: 'x', payload: {} } });
    for (let i = 0; i < 50 && replies.length < 2; i += 1) await new Promise(r => setTimeout(r, 10));
    assert.equal(replies.length, 2);
    assert.deepEqual(replies.find(r => r.callId === 'c1').outcome, { decision: 'deny', reason: 'no delete-session' });
    assert.deepEqual(replies.find(r => r.callId === 'c2').outcome, {});
    await off();
  } finally { session.dispose(); host.close(); }
});

test('hooks.on refuses a daemon without the capability', async () => {
  const host = await startFakeHost({ '__rpc.hello': () => ({ capabilities: [] }) });
  const session = await CtenoSession.open({ socketPath: host.path });
  try {
    await assert.rejects(session.hooks.on('Stop', null, () => {}), /hooks-subscribe-v1/);
  } finally { session.dispose(); host.close(); }
});

test('create sends every daemon param and the normalized agent spec; serves client tools fail-closed', async () => {
  const replies = [];
  let created;
  let raw;
  let subscribed;
  let mcp;
  const host = await startFakeHost({
    '__rpc.hello': () => ({ capabilities: ['hooks-subscribe-v1', 'sdk-session-spec-v1'] }),
    'create-thread': params => { created = params; return { success: true, sessionId: 's9' }; },
    's9:set-session-mcp-servers': params => { mcp = params; return { success: true }; },
    '__hooks.subscribe': (params, ctx) => { raw = ctx.raw; subscribed = params; return { subscriptionId: 'hs-9' }; },
    '__hooks.reply': params => { replies.push(params); return { ok: true }; },
  });
  const session = await CtenoSession.open({ socketPath: host.path });
  try {
    const id = await session.create({
      model: 'm1', title: 't', permissionMode: 'bypassPermissions', agentType: 'worker',
      reasoningEffort: 'high', initialGoal: { objective: 'g', tokenBudget: 10 }, mcpServers: ['amap'],
      spec: {
        systemPrompt: 'You are a guide.',
        tools: { allow: ['websearch'] },
        clientTools: [{
          name: 'search_poi', description: 'find places', inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          handler: async (input, ctx) => {
            if (input.q === 'boom') throw new Error('upstream down');
            return { hits: [input.q, ctx.tenant.userId] };
          },
        }],
        terminalTools: ['search_poi'], requireTerminalTool: true,
        limits: { maxToolCalls: 3, turnTimeoutMs: 1000 },
        history: [{ role: 'user', text: 'hi' }],
        tenant: { tenantId: 'acme', userId: 'u1' },
      },
    });
    assert.equal(id, 's9');
    assert.equal(created.modelId, 'm1');
    assert.equal(created.agent, 'worker');
    assert.equal(created.reasoningEffort, 'high');
    assert.deepEqual(created.initialGoal, { objective: 'g', tokenBudget: 10 });
    assert.deepEqual(created.sdk.systemPrompt, { mode: 'replace', text: 'You are a guide.' });
    assert.equal(created.sdk.clientTools[0].handler, undefined, 'handlers never cross the wire');
    assert.equal(created.sdk.clientTools[0].name, 'search_poi');
    assert.deepEqual(created.sdk.tenant, { tenantId: 'acme', userId: 'u1' });
    assert.deepEqual(mcp, { serverIds: ['amap'] });
    assert.deepEqual(subscribed.events, [{ event: 'ClientTool', matcher: 'search_poi' }]);
    assert.deepEqual(subscribed.sessions, ['s9']);
    const call = (callId, q) => raw({ method: '__hooks.call', params: {
      callId, subscriptionId: 'hs-9', hook_event_name: 'ClientTool', session_id: 's9', matcher: 'search_poi',
      payload: { tool_name: 'search_poi', tool_input: { q }, tool_use_id: 'tu', tenant: { tenantId: 'acme', userId: 'u1' } },
    } });
    call('c1', 'noodles');
    call('c2', 'boom');
    for (let i = 0; i < 50 && replies.length < 2; i += 1) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(replies.find(r => r.callId === 'c1').outcome, { updatedOutput: { hits: ['noodles', 'u1'] } });
    assert.deepEqual(replies.find(r => r.callId === 'c2').outcome, { continue: false, reason: 'upstream down' });
  } finally { session.dispose(); host.close(); }
});

test('create surfaces an invalid spec as REMOTE and abort targets the session scope', async () => {
  let aborted = false;
  const host = await startFakeHost({
    '__rpc.hello': () => ({ capabilities: ['hooks-subscribe-v1', 'sdk-session-spec-v1'] }),
    'create-thread': () => ({ success: false, errorKind: 'invalid_sdk_spec', error: "unknown sdk spec field 'sytemPrompt'" }),
    's1:abort': () => { aborted = true; return { success: true }; },
  });
  const session = await CtenoSession.open({ socketPath: host.path });
  try {
    await assert.rejects(session.create({ spec: { systemPrompt: 'x' } }), error =>
      error.code === 'REMOTE' && /sytemPrompt/.test(error.message));
    await session.abort('s1');
    assert.equal(aborted, true);
  } finally { session.dispose(); host.close(); }
});

test('run collects the final text and parses structured output', async () => {
  const host = await startFakeHost({
    'send-thread-message': async (params, { push }) => {
      push('local-session:message-appended', { sessionId: 's1', message: { id: 'm1', role: 'assistant', text: '{"answer":42}' } });
      return { success: true };
    },
  });
  const session = await CtenoSession.open({ socketPath: host.path });
  try {
    const result = await session.run({ sessionId: 's1', prompt: 'q' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { answer: 42 });
  } finally { session.dispose(); host.close(); }
});
