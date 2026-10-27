import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NodeIpcTransport } from '../dist/node.js';
import { SocketIoTransport } from '../dist/socketio.js';
class Stream extends EventEmitter {
  writableLength = 0; writes = []; destroyed = false;
  write(line) { this.writes.push(line); }
  destroy() { this.destroyed = true; }
}
test('malformed IPC closes pending and oversize outbound sends nothing', async () => {
  const stream = new Stream(); const transport = new NodeIpcTransport(stream, 100);
  await assert.rejects(transport.request('large', { text: 'x'.repeat(100) }), { code: 'TRANSPORT' });
  assert.equal(stream.writes.length, 0);
  const pending = transport.request('read', {});
  stream.emit('data', Buffer.from('{bad}\n'));
  await assert.rejects(pending, { code: 'PROTOCOL' });
  assert.equal(stream.destroyed, true);
  await assert.rejects(transport.request('read', {}), { code: 'CLOSED' });
});
test('invalid deadlines, pending bound, oversized inbound, malformed ACK and wrong target fail closed', async () => {
  const stream = new Stream(); const transport = new NodeIpcTransport(stream, 100);
  await assert.rejects(transport.request('read', {}, { timeoutMs: Infinity }), TypeError);
  const pending = transport.request('read', {});
  stream.emit('data', Buffer.from('x'.repeat(101)));
  await assert.rejects(pending, { code: 'PROTOCOL' });
  const socket = new EventEmitter(); socket.connected = true;
  socket.volatile = { emit: (_event, _payload, ack) => ack({ wrong: true }) };
  const remote = new SocketIoTransport(socket, { targetMachineId: 'one' });
  await assert.rejects(remote.request('two:write', {}), TypeError);
  await assert.rejects(remote.request('read', {}), { code: 'PROTOCOL' }); remote.close();
  const bounded = new NodeIpcTransport(new Stream());
  const waits = Array.from({ length: 256 }, () => bounded.request('read', {}).catch(error => error));
  await assert.rejects(bounded.request('read', {}), { code: 'TRANSPORT' });
  bounded.close(); assert.equal((await Promise.all(waits)).every(e => e.code === 'CLOSED'), true);
});
