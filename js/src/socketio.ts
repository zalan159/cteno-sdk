import { SdkError, type CallOptions, type JsonValue, type Notification, type Transport } from './index.js';
import { Notifications, PendingCalls, object } from './internal.js';

/** Inject an authenticated Socket.IO client configured WITHOUT retries. SDK never owns credentials. */
export interface SocketIoClient {
  readonly connected: boolean;
  readonly volatile: { emit(event: string, payload: unknown, ack: (response: unknown) => void): unknown };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}
export interface SocketIoOptions {
  targetMachineId: string;
  /** Explicit event decoder/routing filter until canonical public notifications are generated. */
  notification?: { event: string; decode(payload: unknown): Notification | undefined };
}
export class SocketIoTransport implements Transport {
  private readonly pending = new PendingCalls();
  private readonly notifications = new Notifications();
  constructor(private readonly socket: SocketIoClient, private readonly options: SocketIoOptions) {
    if (!options.targetMachineId || options.targetMachineId.includes(':')) throw new TypeError('Explicit targetMachineId required');
    socket.on('disconnect', this.disconnected);
    if (options.notification) socket.on(options.notification.event, this.receive);
  }
  request(method: string, params: JsonValue, options?: CallOptions): Promise<unknown> {
    if (!this.socket.connected) return Promise.reject(new SdkError('TRANSPORT', 'Socket disconnected; request not buffered'));
    const prefix = `${this.options.targetMachineId}:`;
    if (method.includes(':') && !method.startsWith(prefix)) return Promise.reject(new TypeError('RPC scope differs from target machine'));
    return this.pending.run(id => {
      // volatile bypasses Socket.IO retry queue / offline send buffering. A dropped packet times out, never replays.
      this.socket.volatile.emit('rpc-call', {
        method: method.startsWith(prefix) ? method : prefix + method,
        params, targetMachineId: this.options.targetMachineId,
      }, response => {
        if (!object(response) || typeof response.ok !== 'boolean') {
          this.pending.settle(id, new SdkError('PROTOCOL', 'Invalid Socket.IO RPC acknowledgement')); return;
        }
        if (!response.ok) this.pending.settle(id, new SdkError('REMOTE', 'Host RPC rejected request', response.error));
        else this.pending.settle(id, undefined, response.result);
      });
    }, options);
  }
  onNotification(listener: (event: Notification) => void): () => void { return this.notifications.on(listener); }
  /** Does not disconnect the injected/shared socket. */
  close(): void {
    this.pending.close(); this.notifications.clear();
    this.socket.off('disconnect', this.disconnected);
    if (this.options.notification) this.socket.off(this.options.notification.event, this.receive);
  }
  private disconnected = (): void => { this.close(); };
  private receive = (payload: unknown): void => {
    try {
      const event = this.options.notification?.decode(payload);
      if (event) this.notifications.emit(event);
    } catch { /* Unknown/unparseable notification variants are ignored. */ }
  };
}
