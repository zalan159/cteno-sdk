import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { CtenoClient } from '../dist/index.js';
import { connectNodeIpc } from '../dist/node.js';
import { SocketIoTransport } from '../dist/socketio.js';

test('raw RPC requires explicit acknowledgement; hello does not', async () => {
  const calls = [];
  const client = new CtenoClient({ request: async (...args) => { calls.push(args); }, onNotification() {}, close() {} });
  await assert.rejects(client.unsafeRawCall('write'), { code: 'UNSAFE_RAW_DISABLED' });
  await client.hello();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '__rpc.hello');
});
test('newline IPC: framing, correlation, explicit subscription, unicode, errors, timeout and cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-ipc-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\cteno-sdk-${process.pid}` : join(dir, 'host.sock');
  const received = []; const connections = new Set();
  const server = createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        received.push(request);
        if (request.method === 'hang') continue;
        const response = request.method === 'deny' ? { requestId: request.requestId, error: 'denied' } : { requestId: request.requestId, result: request.method };
        if (request.method === '__rpc.subscribe') {
          const bytes = Buffer.from(JSON.stringify({ method: 'future-event', params: '中文' }) + '\n');
          const split = bytes.indexOf(Buffer.from('中')) + 1;
          socket.write(bytes.subarray(0, split)); socket.write(bytes.subarray(split));
        }
        const line = JSON.stringify(response) + '\n'; socket.write(line.slice(0, 5)); socket.write(line.slice(5));
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  let transport;
  try {
    transport = await connectNodeIpc(path);
    assert.equal(received.length, 0);
    const events = [];
    transport.onNotification(() => { throw new Error('consumer failure'); });
    const off = transport.onNotification(e => events.push(e));
    assert.deepEqual(await Promise.all([transport.request('a', {}), transport.request('b', {})]), ['a', 'b']);
    await transport.unsafeSetNotificationSubscription(true);
    assert.equal(events[0].params, '中文'); off();
    await assert.rejects(transport.request('deny', {}), { code: 'REMOTE' });
    await assert.rejects(transport.request('hang', {}, { timeoutMs: 10 }), { code: 'TIMEOUT' });
    const abort = new AbortController();
    const pending = transport.request('hang', {}, { signal: abort.signal }); abort.abort();
    await assert.rejects(pending, { code: 'CANCELLED' });
    await assert.rejects(transport.request('never-sent', {}, { signal: abort.signal }), { code: 'CANCELLED' });
    assert.equal(received.filter(r => r.method === 'never-sent').length, 0);
    const closed = transport.request('hang', {}); transport.close();
    await assert.rejects(closed, { code: 'CLOSED' });
  } finally {
    transport?.close(); for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
class FakeSocket extends EventEmitter {
  connected = true; sent = [];
  volatile = { emit: (event, payload, ack) => { this.sent.push({ event, payload, ack }); } };
}
test('Socket.IO target + ACK; no replay, buffering or IPC fallback; unknown notifications', async () => {
  const socket = new FakeSocket();
  const transport = new SocketIoTransport(socket, { targetMachineId: 'machine', notification: {
    event: 'inbound', decode: value => value?.method ? value : undefined,
  } });
  const seen = []; transport.onNotification(event => seen.push(event));
  socket.emit('inbound', { variant: 'future' }); socket.emit('inbound', { method: 'test', params: 1 });
  assert.equal(seen.length, 1);
  const call = transport.request('__rpc.hello', {});
  assert.deepEqual(socket.sent[0].payload, { method: 'machine:__rpc.hello', params: {}, targetMachineId: 'machine' });
  socket.sent[0].ack({ ok: true, result: { ready: true } }); assert.deepEqual(await call, { ready: true });
  const deny = transport.request('write', {}); socket.sent[1].ack({ ok: false, error: 'denied' });
  await assert.rejects(deny, { code: 'REMOTE' });
  await assert.rejects(transport.request('write', {}, { timeoutMs: 10 }), { code: 'TIMEOUT' });
  socket.sent[2].ack({ ok: true, result: 'late' });
  assert.equal(socket.sent.length, 3);
  const pending = transport.request('write', {}); socket.connected = false; socket.emit('disconnect');
  await assert.rejects(pending, { code: 'CLOSED' });
  await assert.rejects(transport.request('write', {}), { code: 'TRANSPORT' });
  socket.connected = true;
  await assert.rejects(transport.request('write', {}), { code: 'CLOSED' });
  assert.equal(socket.listenerCount('inbound'), 0);
  assert.equal(socket.sent.length, 4);
});
