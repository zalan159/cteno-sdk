import { SdkError, type CallOptions, type Notification } from './index.js';

export class PendingCalls {
  private calls = new Map<string, (error?: unknown, value?: unknown) => void>();
  private sequence = 0;
  private closed = false;
  constructor(private readonly timeoutMs = 30_000, private readonly maxPending = 256) {}
  run(send: (id: string) => void, options: CallOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new SdkError('CLOSED', 'Transport closed'));
    if (options.signal?.aborted) return Promise.reject(new SdkError('CANCELLED', 'Cancelled before dispatch'));
    const timeout = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new TypeError('timeoutMs must be finite and positive'));
    if (this.calls.size >= this.maxPending) return Promise.reject(new SdkError('TRANSPORT', 'Pending request limit exceeded'));
    const id = `sdk-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: unknown) => {
        if (!this.calls.delete(id)) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error !== undefined) reject(error); else resolve(value);
      };
      const abort = () => finish(new SdkError('CANCELLED', 'Local wait cancelled; host execution may continue'));
      const timer = setTimeout(() => finish(new SdkError('TIMEOUT', 'Local wait timed out; host execution may continue')), timeout);
      this.calls.set(id, finish);
      options.signal?.addEventListener('abort', abort, { once: true });
      try { send(id); } catch (error) { finish(error); }
    });
  }
  settle(id: string, error?: unknown, value?: unknown): void { this.calls.get(id)?.(error, value); }
  close(error = new SdkError('CLOSED', 'Transport closed')): void {
    this.closed = true;
    for (const finish of this.calls.values()) finish(error);
  }
}
export class Notifications {
  private listeners = new Set<(event: Notification) => void>();
  on(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  emit(event: Notification): void {
    for (const listener of this.listeners) {
      // Consumer exceptions must never kill inbound response draining.
      try { listener(event); } catch { /* Listener owns its errors. */ }
    }
  }
  clear(): void { this.listeners.clear(); }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
