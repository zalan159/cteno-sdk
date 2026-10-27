/** Experimental Rust-generated wire types. Not an authenticated transport or callable method surface. */
export type * as ExperimentalPublicApi from './generated/index.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }
/** SDK abstraction, NOT a generated public host method DTO. */
export interface Notification { method: string; params: unknown }
export interface Transport {
  request(method: string, params: JsonValue, options?: CallOptions): Promise<unknown>;
  onNotification(listener: (event: Notification) => void): () => void;
  close(): void;
}
export type SdkErrorCode = 'CANCELLED' | 'TIMEOUT' | 'CLOSED' | 'TRANSPORT' | 'PROTOCOL' | 'REMOTE' | 'UNSAFE_RAW_DISABLED';
export class SdkError extends Error {
  constructor(readonly code: SdkErrorCode, message: string, readonly detail?: unknown) {
    super(message); this.name = 'SdkError';
  }
}
/** Neither timeout nor cancellation proves that the host stopped executing. */
export class CtenoClient {
  constructor(readonly transport: Transport, private readonly options: {
    /** Required for raw calls. This is caller acknowledgement, NOT host authorization. */
    allowUnsafeRawRpc?: boolean;
    scope?: string;
  } = {}) {}
  hello(options?: CallOptions): Promise<unknown> {
    return this.transport.request(this.scoped('__rpc.hello'), {}, options);
  }
  /** Escape hatch for already-trusted host integrations. No public-method guarantee. */
  unsafeRawCall(method: string, params: JsonValue = {}, options?: CallOptions): Promise<unknown> {
    if (!this.options.allowUnsafeRawRpc) {
      return Promise.reject(new SdkError('UNSAFE_RAW_DISABLED', 'Raw RPC requires explicit acknowledgement; it does not grant third-party authorization.'));
    }
    return this.transport.request(this.scoped(method), params, options);
  }
  /** Only attaches a local listener; does not authorize or subscribe on the host. */
  onNotification(listener: (event: Notification) => void): () => void {
    return this.transport.onNotification(listener);
  }
  close(): void { this.transport.close(); }
  private scoped(method: string): string {
    if (!method || method.includes(':')) throw new TypeError('Expected a non-empty unscoped method');
    return this.options.scope ? `${this.options.scope}:${method}` : method;
  }
}
