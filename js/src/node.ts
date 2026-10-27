import { createConnection, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { SdkError, type CallOptions, type JsonValue, type Notification, type Transport } from './index.js';
import { Notifications, PendingCalls, object } from './internal.js';

/** Explicit path only: never guesses dev/prod socket identity, launches daemon, or bypasses its auth gate. */
export function connectNodeIpc(path: string, options: CallOptions = {}): Promise<NodeIpcTransport> {
  if (!path) return Promise.reject(new TypeError('Explicit Unix socket / Windows pipe path required'));
  if (options.signal?.aborted) return Promise.reject(new SdkError('CANCELLED', 'Connection cancelled'));
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new TypeError('timeoutMs must be finite and positive'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); socket.off('error', fail); };
    const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const abort = () => fail(new SdkError('CANCELLED', 'Connection cancelled'));
    const timer = setTimeout(() => fail(new SdkError('TIMEOUT', 'Connection timed out')), timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', fail);
    socket.once('connect', () => { cleanup(); resolve(new NodeIpcTransport(socket)); });
  });
}
export class NodeIpcTransport implements Transport {
  private readonly pending = new PendingCalls();
  private readonly notifications = new Notifications();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private readonly socket: Socket, private readonly maxFrameBytes = 8 * 1024 * 1024) {
    socket.on('data', this.receive);
    socket.on('error', this.fail);
    socket.on('close', this.closed);
  }
  request(method: string, params: JsonValue, options?: CallOptions): Promise<unknown> {
    return this.pending.run(id => {
      const line = JSON.stringify({ requestId: id, method, params }) + '\n';
      if (Buffer.byteLength(line) > this.maxFrameBytes || this.socket.writableLength + Buffer.byteLength(line) > this.maxFrameBytes) {
        throw new SdkError('TRANSPORT', 'IPC outbound frame/buffer limit exceeded');
      }
      this.socket.write(line);
    }, options);
  }
  /** Host subscription is connection-wide, explicit and separate from local listeners. */
  unsafeSetNotificationSubscription(enabled: boolean, options?: CallOptions): Promise<unknown> {
    return this.request(enabled ? '__rpc.subscribe' : '__rpc.unsubscribe', {}, options);
  }
  onNotification(listener: (event: Notification) => void): () => void { return this.notifications.on(listener); }
  close(): void { this.pending.close(); this.notifications.clear(); this.socket.destroy(); }
  private closed = (): void => { this.pending.close(); this.notifications.clear(); };
  private fail = (error: Error): void => {
    this.pending.close(new SdkError('TRANSPORT', 'IPC connection failed', error)); this.socket.destroy();
  };
  private receive = (chunk: Buffer): void => {
    this.buffer += this.decoder.write(chunk);
    try {
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > this.maxFrameBytes) throw new Error('IPC frame limit exceeded');
        if (!line.trim()) continue;
        const message: unknown = JSON.parse(line);
        if (!object(message)) throw new Error('Invalid IPC envelope');
        if (typeof message.requestId === 'string') {
          const error = message.error == null ? undefined : new SdkError('REMOTE', 'Host RPC rejected request', message.error);
          this.pending.settle(message.requestId, error, message.result);
        } else if (typeof message.method === 'string') {
          this.notifications.emit({ method: message.method, params: message.params });
        }
        // Unknown envelope variants and late replies are deliberately ignored.
      }
      if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) throw new Error('IPC frame limit exceeded');
    } catch (error) {
      this.pending.close(new SdkError('PROTOCOL', 'Malformed IPC stream', error)); this.socket.destroy();
    }
  };
}
