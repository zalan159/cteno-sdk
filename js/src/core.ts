/**
 * Core SDK surface: the shape a developer actually wants.
 *
 *     import { query } from '@cteno/sdk/core';
 *     for await (const message of query({ prompt: 'hi', cwd: './src' })) {
 *       if (message.type === 'assistant') console.log(message.text);
 *     }
 *
 * This is a THIN client over the daemon's existing owner RPC surface (~135
 * distinct business methods). It introduces no authorization layer of its own,
 * because there is nothing here for one to protect: the owner socket is mode
 * 0600, so the OS already decided that whoever can open it is the user. A
 * process that can reach this socket can equally read `~/.ssh`. That is the
 * same bargain Claude Code's SDK makes when it spawns the `claude` binary.
 *
 * Consequently: no grants, no capability digests, no second socket, no
 * credential provider. If you need to defend against the caller, you need a
 * different process boundary, not a different client library.
 *
 * What the SDK does draw is a COMPATIBILITY line, which is a different thing
 * from an access line: see `method-tiers.ts` for which methods are covered by
 * semver and which are daemon internals you may still call at your own risk.
 */
import { connectNodeIpc } from './node.js';
import { discoverOwnerEndpoints, type OwnerEndpoint } from './discover.js';
import { methodTier } from './method-tiers.js';
import { SdkError, type CallOptions, type JsonValue, type Transport } from './index.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Message stream
 * ------------------------------------------------------------------ */

/** A user turn, echoed back as the host durably accepts it. */
export interface UserMessage {
  type: 'user';
  id: string;
  text: string;
  sessionId: string;
}

/**
 * An assistant frame.
 *
 * `text` is the plain rendering when the host emitted one. The host also
 * emits structured envelopes (tool calls, task lifecycle, permission
 * prompts); those arrive with `text` holding the raw JSON and `data` holding
 * the parsed object, so a consumer can ignore structure entirely and still
 * get something printable.
 */
export interface AssistantMessage {
  type: 'assistant';
  id: string;
  text: string;
  data?: unknown;
  /**
   * Frame kind for structured host frames: `message` (assistant text),
   * `thinking`, `tool-call`, `tool-result`, `task_started`, `task_complete`,
   * `context_usage`, … Absent for plain text frames.
   */
  kind?: string;
  sessionId: string;
}

/** Emitted once when the turn finishes, successfully or not. */
export interface ResultMessage {
  type: 'result';
  sessionId: string;
  /** False when the host reported a failure for this turn. */
  ok: boolean;
  /** Host-provided error text, when `ok` is false. */
  error?: string;
}

/** Session became active/idle. Useful for progress UI; safe to ignore. */
export interface StatusMessage {
  type: 'status';
  sessionId: string;
  thinking: boolean;
  status?: string;
}

export type CtenoMessage = UserMessage | AssistantMessage | ResultMessage | StatusMessage;

/* ------------------------------------------------------------------ *
 * query()
 * ------------------------------------------------------------------ */

/**
 * How the agent handles a tool it is not pre-authorised to run.
 *
 * This matters more here than in a CLI: a permission prompt is answered in the
 * Cteno UI, so an unattended SDK consumer that leaves this at `default` will
 * see the turn stall on a card nobody can answer and then time out. Pick the
 * mode that matches how much you trust the prompt.
 *
 * - `default` — ask for anything not pre-approved. Correct when a human is
 *   watching the Cteno app; wrong for unattended runs.
 * - `acceptEdits` — file edits proceed, other tools still ask.
 * - `bypassPermissions` — never ask. The usual choice for automation, and only
 *   safe when you control the prompt and the working directory.
 * - `plan` — no mutations at all; the agent plans instead of acting.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface QueryOptions {
  /** The prompt to send. */
  prompt: string;
  /** Working directory for the session. Defaults to the host's `~`. */
  cwd?: string;
  /** Continue an existing session instead of creating one. */
  sessionId?: string;
  /** Model/profile id, as listed by `listProfiles()`. Host default if unset. */
  model?: string;
  /**
   * How to handle tool permission prompts. Only applies when `query` creates
   * the session. Unattended callers almost always want `bypassPermissions`;
   * leaving this unset means an unexpected tool call stalls until it times out.
   */
  permissionMode?: PermissionMode;
  /** Session title. Only used when creating a new session. */
  title?: string;
  /**
   * Per-session configuration (prompt, tools, client tools, limits, output
   * schema, history, tenant). Only used when `query` creates the session.
   * See {@link AgentSpec}.
   */
  agent?: AgentSpec;
  /** Explicit socket path. Defaults to auto-discovery. */
  socketPath?: string;
  /** Abort the local wait. Does NOT prove the host stopped working. */
  signal?: AbortSignal;
  /** Per-turn deadline. Defaults to 10 minutes. */
  timeoutMs?: number;
  /**
   * Close the session when the stream ends. Defaults to true for sessions
   * `query` created, false for a `sessionId` you passed in — we do not close
   * what we did not open.
   */
  closeOnFinish?: boolean;
}

/**
 * Run one turn and stream it back.
 *
 * The iterator ends after the `result` message. Breaking out early aborts the
 * local wait and releases the connection; the host may still be working, which
 * is exactly the same guarantee `ctrl-C` on a CLI gives you.
 */
export async function* query(options: QueryOptions): AsyncGenerator<CtenoMessage, void, void> {
  const session = await CtenoSession.open({
    socketPath: options.socketPath,
    signal: options.signal,
  });
  const createdHere = !options.sessionId;
  const shouldClose = options.closeOnFinish ?? createdHere;
  let sessionId = options.sessionId ?? '';
  try {
    if (!sessionId) {
      sessionId = await session.create({
        cwd: options.cwd,
        model: options.model,
        title: options.title,
        permissionMode: options.permissionMode,
        spec: options.agent,
        signal: options.signal,
      });
    }
    yield* session.send({
      sessionId,
      prompt: options.prompt,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  } finally {
    if (shouldClose && sessionId) {
      // Best-effort: a close failure must not mask the real error, and the
      // session is durable on the host either way.
      await session.close(sessionId).catch(() => {});
    }
    session.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * Session client
 * ------------------------------------------------------------------ */

export interface ProfileInfo {
  id: string;
  name?: string;
  model?: string;
}

export interface SessionInfo {
  id: string;
  title?: string;
  workdir?: string;
  active?: boolean;
  updatedAt?: number;
}

/**
 * One step of a run.
 *
 * `type` is host-defined and open — currently `user_message`,
 * `assistant_message`, `tool_call`, `tool_result`. Switch on the ones you care
 * about and ignore the rest; new kinds are not a breaking change.
 */
export interface TraceEvent {
  seq: number;
  timestamp: string;
  role: string;
  type: string;
  text?: string;
  toolName?: string;
  callId?: string;
  isError?: boolean;
}

export interface TraceSummary {
  total: number;
  toolCalls: number;
  toolResults: number;
}

export interface SessionTrace {
  sessionId: string;
  events: TraceEvent[];
  summary: TraceSummary;
}

export interface OpenOptions {
  /** Explicit socket path; skips discovery. */
  socketPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * A connected owner-RPC client.
 *
 * Use this when you want more than one turn, or want the non-chat surface
 * (listing sessions, reading the trace). `query()` is a one-shot wrapper
 * around it.
 */
export class CtenoSession {
  private constructor(
    private readonly transport: Transport,
    /** The daemon's machine id; every business method is namespaced by it. */
    readonly machineId: string,
    readonly endpoint: OwnerEndpoint | null,
  ) {}

  /** Connect to the owner socket, auto-discovering it unless told otherwise. */
  static async open(options: OpenOptions = {}): Promise<CtenoSession> {
    const candidates: OwnerEndpoint[] = options.socketPath
      ? [{ path: options.socketPath, hostRoot: '', kind: 'dev' }]
      : discoverOwnerEndpoints();
    if (candidates.length === 0) {
      throw new SdkError('TRANSPORT',
        'No Cteno daemon socket found. Start the daemon, or pass socketPath / set CTENO_HOST_ROOT.');
    }
    let lastError: unknown;
    for (const endpoint of candidates) {
      let transport: Transport | undefined;
      try {
        transport = await connectNodeIpc(endpoint.path, {
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 10_000,
        });
        // A stale socket file connects and then goes nowhere, so liveness is
        // only proven by a reply. hello also carries the machine id we need.
        const machineId = await resolveMachineId(transport, options);
        return new CtenoSession(transport, machineId, endpoint);
      } catch (error) {
        lastError = error;
        transport?.close();
      }
    }
    throw new SdkError('TRANSPORT',
      `Could not reach a Cteno daemon (tried ${candidates.length} socket(s))`, lastError);
  }

  /**
   * Create a session and return its id.
   *
   * Every `create-thread` parameter the daemon accepts is exposed here, plus
   * `spec` — the per-session {@link AgentSpec} (prompt, tool surface, client
   * tools, limits, structured output, imported history, tenant). Client tools
   * that carry a `handler` are served by THIS connection for the session's
   * lifetime on it; keep the `CtenoSession` open while the session runs.
   */
  async create(options: CreateOptions = {}): Promise<string> {
    const params: Record<string, JsonValue> = { ...(options.extraParams ?? {}) };
    if (options.cwd) params.workdir = options.cwd;
    if (options.model) params.modelId = options.model;
    if (options.title) params.title = options.title;
    if (options.permissionMode) params.permissionMode = options.permissionMode;
    if (options.agentType) params.agent = options.agentType;
    if (options.reasoningEffort) params.reasoningEffort = options.reasoningEffort;
    if (options.initialGoal) {
      params.initialGoal = options.initialGoal.tokenBudget === undefined
        ? { objective: options.initialGoal.objective }
        : { objective: options.initialGoal.objective, tokenBudget: options.initialGoal.tokenBudget };
    }
    if (options.avatarId) params.avatarId = options.avatarId;
    if (options.description) params.description = options.description;
    if (options.lineage) {
      for (const [key, value] of Object.entries(options.lineage)) if (value) params[key] = value;
    }
    if (options.scheduledTaskId) params.scheduledTaskId = options.scheduledTaskId;
    const wire = options.spec ? specToWire(options.spec) : undefined;
    if (wire) params.sdk = wire;
    const result = await this.call('create-thread', params, options);
    if (!object(result)) throw new SdkError('PROTOCOL', 'create-thread returned a non-object');
    if (result.success === false) {
      throw new SdkError('REMOTE', String(result.error ?? 'create-thread failed'), result);
    }
    const id = result.sessionId ?? result.threadId;
    if (typeof id !== 'string' || !id) {
      throw new SdkError('PROTOCOL', 'create-thread returned no session id', result);
    }
    try {
      if (options.mcpServers) {
        await this.transport.request(`${id}:set-session-mcp-servers`, { serverIds: options.mcpServers }, options);
      }
      const handlers = (options.spec?.clientTools ?? []).filter(tool => typeof tool.handler === 'function');
      if (handlers.length > 0) await this.serveClientTools(id, handlers, options);
    } catch (error) {
      await this.close(id).catch(() => {});
      throw error;
    }
    return id;
  }

  /**
   * Serve client tools for `sessionId` from this connection. `create()` does
   * this for tools declared with a handler; call it yourself to (re)attach
   * handlers after reconnecting to an existing session.
   */
  async serveClientTools(
    sessionId: string,
    tools: Array<Pick<ClientTool, 'name' | 'handler'>>,
    options: CallOptions = {},
  ): Promise<() => Promise<void>> {
    const byName = new Map(tools.filter(t => t.handler).map(t => [t.name, t.handler as ClientToolHandler]));
    if (byName.size === 0) throw new TypeError('serveClientTools needs at least one tool with a handler');
    return this.subscribeHooks(
      [{ event: 'ClientTool', matcher: [...byName.keys()].join('|') }],
      async call => {
        const payload = call.payload ?? {};
        const name = String(payload.tool_name ?? call.matcher ?? '');
        const handler = byName.get(name);
        if (!handler) return { continue: false, reason: `no handler for client tool ${name}` };
        try {
          const output = await handler(payload.tool_input as Record<string, unknown> ?? {}, {
            sessionId: call.session_id,
            toolName: name,
            toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
            metadata: payload.metadata,
            tenant: object(payload.tenant) ? payload.tenant as unknown as TenantRef : undefined,
          });
          // undefined/null is a valid "nothing to report", not a missing reply.
          return { updatedOutput: typeof output === 'string' ? output : (output ?? '') as JsonValue };
        } catch (error) {
          return { continue: false, reason: error instanceof Error ? error.message : String(error) };
        }
      },
      { ...options, sessions: [sessionId] },
      /* failClosed */ true,
    );
  }

  /** Interrupt the turn running right now (the stop button). The turn ends as aborted. */
  async abort(sessionId: string, options: CallOptions = {}): Promise<void> {
    if (!sessionId) throw new TypeError('sessionId is required');
    await this.transport.request(`${sessionId}:abort`, {}, options);
  }

  /**
   * Send one prompt and wait for the turn to finish, collecting the result.
   *
   * `output` is the structured result when the session has an `outputSchema`
   * (the `final_result` tool input, parsed) or a terminal tool returned JSON;
   * `text` is the final assistant text.
   */
  async run(options: { sessionId: string; prompt: string; signal?: AbortSignal; timeoutMs?: number }): Promise<RunResult> {
    const messages: CtenoMessage[] = [];
    let ok = false;
    let error: string | undefined;
    for await (const message of this.send(options)) {
      messages.push(message);
      if (message.type === 'result') { ok = message.ok; error = message.error; }
    }
    const isAnswer = (m: CtenoMessage): m is AssistantMessage =>
      m.type === 'assistant' && (m.kind === undefined || m.kind === 'message');
    let answers = messages.filter(isAnswer);
    if (answers.length === 0) {
      // The final frame can be persisted after the turn boundary reply.
      const history = await this.history(options.sessionId, { limit: 20 }).catch(() => [] as CtenoMessage[]);
      const lastUser = history.map(m => m.type).lastIndexOf('user');
      answers = history.slice(lastUser + 1).filter(isAnswer);
    }
    const text = answers.length > 0 ? answers[answers.length - 1].text : '';
    let output: unknown;
    try { output = JSON.parse(text); } catch { output = undefined; }
    const toolCalls = messages.flatMap(m => {
      if (m.type !== 'assistant' || m.kind !== 'tool-call') return [];
      const data = object(m.data) && object(m.data.content) && object(m.data.content.data) ? m.data.content.data : {};
      return [{ name: String(data.name ?? ''), callId: String(data.callId ?? ''), input: data.input }];
    });
    return { ok, error, text, output, toolCalls, messages };
  }

  /** Read or replace a tenant's admission policy (concurrency, daily quota). */
  async tenantPolicy(tenantId: string, policy?: TenantPolicy, options: CallOptions = {}): Promise<TenantPolicy> {
    const params: Record<string, JsonValue> = { tenantId };
    if (policy) params.policy = policy as unknown as JsonValue;
    const result = await this.call('sdk-tenant-policy', params, { ...options, quiet: true });
    if (!object(result) || !object(result.policy)) throw new SdkError('PROTOCOL', 'sdk-tenant-policy returned no policy', result);
    return result.policy as unknown as TenantPolicy;
  }

  /** Live tenant status: policy, running turns, known end users. */
  async tenantStatus(tenantId: string, options: CallOptions = {}): Promise<Record<string, unknown>> {
    const result = await this.call('sdk-tenant-status', { tenantId }, { ...options, quiet: true });
    if (!object(result)) throw new SdkError('PROTOCOL', 'sdk-tenant-status returned a non-object', result);
    return result;
  }

  /**
   * Send one prompt and stream the turn.
   *
   * Subscribes to host notifications BEFORE dispatching, so no frame emitted
   * between dispatch and subscription is lost.
   */
  async *send(options: {
    sessionId: string; prompt: string;
    signal?: AbortSignal; timeoutMs?: number;
  }): AsyncGenerator<CtenoMessage, void, void> {
    const { sessionId, prompt } = options;
    if (!sessionId) throw new TypeError('sessionId is required');

    const queue: CtenoMessage[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let failure: unknown;

    const push = (message: CtenoMessage) => {
      queue.push(message);
      notify?.();
    };

    const unsubscribe = this.onSessionEvent(sessionId, push);
    try {
      await this.subscribe(options);
      // `wait: true` makes the host hold the reply until the turn completes,
      // so this promise IS the turn boundary. We do not race a timer against
      // the event stream to guess when a turn ended.
      const turn = this.call('send-thread-message', {
        sessionId, message: prompt, wait: true,
      }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 600_000 })
        .then(result => {
          if (object(result) && result.success === false) {
            push({ type: 'result', sessionId, ok: false, error: String(result.error ?? 'send failed') });
          } else {
            push({ type: 'result', sessionId, ok: true });
          }
        })
        .catch(error => { failure = error; })
        .finally(() => { finished = true; notify?.(); });

      while (true) {
        while (queue.length > 0) {
          const message = queue.shift() as CtenoMessage;
          yield message;
          if (message.type === 'result') { await turn; return; }
        }
        if (finished) break;
        await new Promise<void>(resolve => { notify = resolve; });
        notify = null;
      }
      await turn;
      if (failure) throw failure;
    } finally {
      unsubscribe();
    }
  }

  /** List model profiles the host can run. */
  async listProfiles(options: CallOptions = {}): Promise<ProfileInfo[]> {
    const result = await this.call('list-profiles', {}, options);
    const raw = object(result) ? result.profiles : result;
    if (!Array.isArray(raw)) return [];
    return raw.filter(object).map(profile => ({
      id: String(profile.id ?? ''),
      name: typeof profile.name === 'string' ? profile.name : undefined,
      model: object(profile.chat) && typeof profile.chat.model === 'string'
        ? profile.chat.model : undefined,
    }));
  }

  /** List sessions known to the host. */
  async listSessions(options: CallOptions = {}): Promise<SessionInfo[]> {
    const result = await this.call('list-sessions', {}, options);
    const raw = object(result) ? result.sessions : result;
    if (!Array.isArray(raw)) return [];
    return raw.filter(object).map(session => ({
      id: String(session.id ?? ''),
      title: typeof session.title === 'string' ? session.title : undefined,
      workdir: typeof session.path === 'string' ? session.path : undefined,
      active: session.active === true,
      updatedAt: typeof session.activeAt === 'number' ? session.activeAt : undefined,
    }));
  }

  /** Read a session's message history, oldest first. */
  async history(sessionId: string, options: { limit?: number } & CallOptions = {}): Promise<CtenoMessage[]> {
    const result = await this.call('get-session-messages', {
      sessionId, limit: options.limit ?? 100,
    }, options);
    const raw = object(result) ? result.messages : result;
    if (!Array.isArray(raw)) return [];
    return raw.filter(object).map(entry => decodeStoredMessage(entry, sessionId)).filter(Boolean) as CtenoMessage[];
  }

  /** Close a session on the host. */
  async close(sessionId: string, options: CallOptions = {}): Promise<void> {
    await this.call('close-session', { sessionId }, options);
  }

  /**
   * Read a structured trace of what the agent actually did: messages, tool
   * calls and tool results, in order.
   *
   * This is a projection over persisted conversation messages, which is what
   * you want for "show me the run". It is deliberately distinct from the
   * host's durable runtime event log (`list-session-events`), reachable via
   * `call()` if you need that instead.
   */
  async trace(sessionId: string, options: { limit?: number } & CallOptions = {}): Promise<SessionTrace> {
    const result = await this.call('get-session-trace', {
      sessionId, limit: options.limit ?? 300,
    }, options);
    if (!object(result)) throw new SdkError('PROTOCOL', 'get-session-trace returned a non-object');
    if (result.success === false) {
      throw new SdkError('REMOTE', String(result.error ?? 'get-session-trace failed'), result);
    }
    const rawEvents = Array.isArray(result.events) ? result.events : [];
    const summary = object(result.summary) ? result.summary : {};
    return {
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : sessionId,
      events: rawEvents.filter(object).map(event => ({
        seq: typeof event.seq === 'number' ? event.seq : 0,
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
        role: String(event.role ?? ''),
        // The host serializes these in snake_case; camelCase them at the
        // boundary so consumers never see two naming conventions.
        type: String(event.event_type ?? ''),
        text: typeof event.text === 'string' ? event.text : undefined,
        toolName: typeof event.tool_name === 'string' ? event.tool_name : undefined,
        callId: typeof event.call_id === 'string' ? event.call_id : undefined,
        isError: typeof event.is_error === 'boolean' ? event.is_error : undefined,
      })),
      summary: {
        total: typeof summary.total === 'number' ? summary.total : 0,
        toolCalls: typeof summary.toolCalls === 'number' ? summary.toolCalls : 0,
        toolResults: typeof summary.toolResults === 'number' ? summary.toolResults : 0,
      },
    };
  }

  /**
   * Subscribe to daemon hooks over this connection — the SDK half of hook ⇔
   * RPC parity. Same event names (`PreToolUse`, `PreRpc`, `Stop`, …), matcher
   * syntax and outcome shape as a plugin's `surfaces.hooks`, so a hook moves
   * between a plugin and an SDK client unchanged.
   *
   *     const off = await session.hooks.on('PreToolUse', 'shell', ctx =>
   *       ({ decision: 'deny', reason: 'no shell from SDK policy' }));
   *
   * Rules match plugin hooks: a handler that throws, or does not answer within
   * `timeoutSecs` (default 30), fails OPEN (allow). The subscription dies with
   * the connection. Requires the daemon capability `hooks-subscribe-v1`.
   */
  readonly hooks = {
    on: (event: HookEventName, matcher: string | null, handler: HookHandler, options: HookSubscribeOptions = {}) =>
      this.subscribeHooks([{ event, matcher: matcher ?? undefined }], handler, options),
    onMany: (events: Array<{ event: HookEventName; matcher?: string }>, handler: HookHandler, options: HookSubscribeOptions = {}) =>
      this.subscribeHooks(events, handler, options),
  };

  private async subscribeHooks(
    events: Array<{ event: HookEventName; matcher?: string }>,
    handler: HookHandler,
    options: HookSubscribeOptions,
    failClosed = false,
  ): Promise<() => Promise<void>> {
    const hello = await this.transport.request('__rpc.hello', {}, options);
    const capabilities = object(hello) && Array.isArray(hello.capabilities) ? hello.capabilities : [];
    if (!capabilities.includes(HOOKS_SUBSCRIBE_CAPABILITY)) {
      throw new SdkError('PROTOCOL', `Daemon does not support hook subscriptions (${HOOKS_SUBSCRIBE_CAPABILITY})`, hello);
    }
    const params: Record<string, JsonValue> = {
      events: events.map((e): JsonValue => (e.matcher ? { event: e.event, matcher: e.matcher } : { event: e.event })),
    };
    if (options.sessions) params.sessions = options.sessions;
    if (options.timeoutSecs) params.timeoutSecs = options.timeoutSecs;
    // Listen before subscribing so no call can arrive unheard.
    let subscriptionId = '';
    const early: Array<Record<string, unknown>> = [];
    const answer = async (call: Record<string, unknown>) => {
      let outcome: HookOutcome | void;
      try {
        outcome = await handler(call as unknown as HookCall);
      } catch (error) {
        if (failClosed) {
          outcome = { continue: false, reason: String(error) };
        } else {
          console.warn(`[@cteno/sdk] hook handler threw; allowing: ${String(error)}`);
          outcome = undefined;
        }
      }
      try {
        await this.transport.request('__hooks.reply', { callId: String(call.callId), outcome: (outcome ?? {}) as JsonValue });
      } catch { /* call expired or connection closed: the daemon already failed open */ }
    };
    const off = this.transport.onNotification(event => {
      if (event.method !== '__hooks.call' || !object(event.params)) return;
      if (!subscriptionId) { early.push(event.params); return; }
      if (event.params.subscriptionId !== subscriptionId) return;
      void answer(event.params);
    });
    let result: unknown;
    try {
      result = await this.transport.request('__hooks.subscribe', params, options);
    } catch (error) {
      off();
      throw error;
    }
    if (!object(result) || typeof result.subscriptionId !== 'string') {
      off();
      throw new SdkError('PROTOCOL', '__hooks.subscribe returned no subscriptionId', result);
    }
    subscriptionId = result.subscriptionId;
    for (const call of early.splice(0)) if (call.subscriptionId === subscriptionId) void answer(call);
    return async () => {
      off();
      try { await this.transport.request('__hooks.unsubscribe', { subscriptionId }); } catch { /* closed */ }
    };
  }

  /** Release the connection. Does not stop host-side work. */
  dispose(): void { this.transport.close(); }

  /**
   * Call any owner method by its unscoped name.
   *
   * Unlike `CtenoClient.unsafeRawCall` there is no acknowledgement flag here:
   * the whole premise of this module is that reaching the owner socket already
   * means full owner rights, so pretending otherwise would be theatre.
   *
   * What this DOES do is tell you when you have stepped outside the supported
   * surface. Methods graded `stable` (see `method-tiers.ts`) are covered by
   * semver; everything else is a daemon implementation detail that can change
   * without notice. You still get to call it — that is the point of an escape
   * hatch — but you find out now rather than after an upgrade breaks you.
   * Pass `quiet: true` when the dependency is deliberate.
   */
  async call(
    method: string,
    params: JsonValue = {},
    options: CallOptions & { quiet?: boolean } = {},
  ): Promise<unknown> {
    if (!method || method.includes(':')) {
      throw new TypeError('Expected an unscoped method name; machine id is added for you');
    }
    if (!options.quiet) warnIfUnsupported(method);
    return this.transport.request(`${this.machineId}:${method}`, params, options);
  }

  private subscribed = false;
  private async subscribe(options: CallOptions): Promise<void> {
    if (this.subscribed) return;
    // Connection-wide and explicit: the host does not push to a client that
    // never asked, so a one-shot RPC caller is never confused by stray frames.
    await this.transport.request('__rpc.subscribe', {}, options);
    this.subscribed = true;
  }

  /** Translate raw host notifications into typed messages for one session. */
  private onSessionEvent(sessionId: string, emit: (message: CtenoMessage) => void): () => void {
    return this.transport.onNotification(event => {
      if (event.method !== 'local-session-event' || !object(event.params)) return;
      const channel = event.params.channel;
      const payload = event.params.payload;
      if (typeof channel !== 'string' || !object(payload)) return;
      if (payload.sessionId !== sessionId) return;

      if (channel === 'local-session:message-appended' && object(payload.message)) {
        const message = decodeStoredMessage(payload.message, sessionId);
        if (message) emit(message);
      } else if (channel === 'local-session:alive') {
        emit({
          type: 'status', sessionId,
          thinking: payload.thinking === true,
          status: typeof payload.thinkingStatus === 'string' ? payload.thinkingStatus : undefined,
        });
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 * Hooks (same contract as plugin `surfaces.hooks`)
 * ------------------------------------------------------------------ */

export const HOOKS_SUBSCRIBE_CAPABILITY = 'hooks-subscribe-v1';

export type HookEventName =
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest'
  | 'UserPromptSubmit' | 'Stop' | 'SubagentStart' | 'SubagentStop'
  | 'SessionStart' | 'SessionEnd' | 'Notification' | 'PreCompact' | 'PostCompact'
  | 'PreRpc' | 'PostRpc' | 'PostRpcFailure'
  | 'PreConnectorDeliver'
  | 'ClientTool'
  | (string & {});

/** What the daemon sends for one fired hook. */
export interface HookCall {
  callId: string;
  subscriptionId: string;
  hook_event_name: HookEventName;
  session_id: string;
  /** The matched value: tool name, bare RPC method, … */
  matcher: string | null;
  /** Event payload — identical to a command hook's stdin JSON. */
  payload: Record<string, unknown>;
}

/** Same shape a plugin command hook prints on stdout. Empty = allow. */
export interface HookOutcome {
  continue?: boolean;
  /** `note` (PreConnectorDeliver only): keep the event as context, start no turn. */
  decision?: 'allow' | 'deny' | 'ask' | 'defer' | 'note';
  reason?: string;
  additionalContext?: string;
  updatedInput?: unknown;
  updatedOutput?: unknown;
}

export type HookHandler = (call: HookCall) => HookOutcome | void | Promise<HookOutcome | void>;

export interface HookSubscribeOptions extends CallOptions {
  /** Restrict session events to these session ids (machine events always delivered). */
  sessions?: string[];
  /** How long the daemon waits for this client before failing open (default 30). */
  timeoutSecs?: number;
}

/* ------------------------------------------------------------------ *
 * Agent spec (capability `sdk-session-spec-v1`)
 * ------------------------------------------------------------------ */

export const AGENT_SPEC_CAPABILITY = 'sdk-session-spec-v1';

/** Who a tenant session belongs to: one end user of one customer app. */
export interface TenantRef { tenantId: string; userId: string }

export interface ClientToolContext {
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  metadata?: unknown;
  tenant?: TenantRef;
}

/** Returns the tool result (string, or JSON that is serialized). Throw to fail the call. */
export type ClientToolHandler = (input: Record<string, unknown>, context: ClientToolContext) => unknown | Promise<unknown>;

/** A tool the model can call that runs in YOUR process, not in the daemon. */
export interface ClientTool {
  name: string;
  description?: string;
  /** JSON Schema of the tool input (an object schema). */
  inputSchema?: Record<string, unknown>;
  /** How long the daemon waits for your answer (default 60s, max 600s). */
  timeoutMs?: number;
  /** Runs the tool. Omit only if another connection serves it. */
  handler?: ClientToolHandler;
}

/**
 * Per-session configuration. Everything is optional; an empty spec behaves
 * like a normal Cteno session.
 */
export interface AgentSpec {
  /**
   * The session's system prompt. A string REPLACES Cteno's base prompt (a
   * short safety floor is kept); `{mode: 'append'}` adds to it instead.
   */
  systemPrompt?: string | { mode: 'replace' | 'append'; text: string };
  /** Which runtime context blocks are injected every turn, plus your own. */
  context?: {
    datetime?: boolean; language?: boolean; modelIdentity?: boolean;
    skills?: boolean; workspace?: boolean; extra?: string[];
  };
  /**
   * Built-in tool surface. `allow` is a whitelist (exact names or `prefix*`,
   * e.g. `mcp__amap__*`); `deny` removes. With a replaced prompt the default
   * is NO built-in tools.
   */
  tools?: { allow?: string[]; deny?: string[] };
  /** Tools defined and executed by the client. */
  clientTools?: ClientTool[];
  /** Tools whose successful call ends the turn; the call's result is the turn result. */
  terminalTools?: string[];
  /** The turn may not end in plain text; the model is reminded to call a terminal tool. */
  requireTerminalTool?: boolean;
  limits?: {
    /** Model round-trips per turn. */
    maxIterations?: number;
    /** Tool calls per turn; after that only terminal tools remain. */
    maxToolCalls?: number;
    /** Wall-clock budget per turn; the turn is aborted when it expires. */
    turnTimeoutMs?: number;
    /** Output-token ceiling per model request. */
    maxOutputTokens?: number;
  };
  /** JSON Schema of a structured result. Adds and requires the `final_result` tool. */
  outputSchema?: Record<string, unknown>;
  /** Earlier conversation from your own store, given to the model as context. */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** End user this session belongs to. Isolates workdir, memory and quota. */
  tenant?: TenantRef;
  /** Echoed to every client-tool call. */
  metadata?: unknown;
}

export interface CreateOptions extends CallOptions {
  cwd?: string;
  model?: string;
  title?: string;
  permissionMode?: PermissionMode;
  /** Agent identity (`worker`, `browser`, a custom agent id). */
  agentType?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {});
  initialGoal?: { objective: string; tokenBudget?: number };
  /** MCP server ids (or tool prefixes) this session loads; `[]` = none. */
  mcpServers?: string[];
  avatarId?: string;
  description?: string;
  /** Dispatch lineage, when creating on behalf of another session. */
  lineage?: { ownerSessionId?: string; ownerMachineId?: string; graphId?: string; nodeId?: string; toolCallId?: string };
  scheduledTaskId?: string;
  spec?: AgentSpec;
  /** Raw create-thread params merged first (forward compatibility). */
  extraParams?: Record<string, JsonValue>;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  /** Final assistant text. */
  text: string;
  /** Parsed JSON of the final text, when it is JSON (structured output). */
  output?: unknown;
  /** Tool calls the model made this turn, in order. */
  toolCalls: Array<{ name: string; callId: string; input: unknown }>;
  messages: CtenoMessage[];
}

export interface TenantPolicy {
  maxConcurrentTurnsPerUser?: number;
  maxConcurrentTurns?: number;
  maxTurnsPerUserPerDay?: number;
}

/** Wire form of an {@link AgentSpec}: handlers stripped, prompt normalized. */
export function specToWire(spec: AgentSpec): Record<string, JsonValue> {
  const wire: Record<string, JsonValue> = {};
  if (spec.systemPrompt !== undefined) {
    wire.systemPrompt = typeof spec.systemPrompt === 'string'
      ? { mode: 'replace', text: spec.systemPrompt }
      : { mode: spec.systemPrompt.mode, text: spec.systemPrompt.text };
  }
  if (spec.context) wire.context = spec.context as JsonValue;
  if (spec.tools) wire.tools = spec.tools as JsonValue;
  if (spec.clientTools?.length) {
    wire.clientTools = spec.clientTools.map(tool => {
      const out: Record<string, JsonValue> = { name: tool.name };
      if (tool.description) out.description = tool.description;
      if (tool.inputSchema) out.inputSchema = tool.inputSchema as JsonValue;
      if (tool.timeoutMs) out.timeoutMs = tool.timeoutMs;
      return out;
    });
  }
  if (spec.terminalTools?.length) wire.terminalTools = spec.terminalTools;
  if (spec.requireTerminalTool) wire.requireTerminalTool = true;
  if (spec.limits) wire.limits = spec.limits as JsonValue;
  if (spec.outputSchema) wire.outputSchema = spec.outputSchema as JsonValue;
  if (spec.history?.length) wire.history = spec.history as unknown as JsonValue;
  if (spec.tenant) wire.tenant = spec.tenant as unknown as JsonValue;
  if (spec.metadata !== undefined) wire.metadata = spec.metadata as JsonValue;
  return wire;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Methods already warned about, so a call in a loop does not spam the log.
 * Per-process, not per-session: the advice is about the method, not the
 * connection.
 */
const warnedMethods = new Set<string>();

/** Warn once when a caller depends on something outside the supported surface. */
function warnIfUnsupported(method: string): void {
  const tier = methodTier(method);
  if (tier === 'stable' || warnedMethods.has(method)) return;
  warnedMethods.add(method);
  const reason = tier === 'internal'
    ? 'is a daemon internal (credentials, plugin install, browser pane, handshake, or an unsettled placeholder)'
    : 'is not in the supported-method inventory — check the spelling, or it is newer than this SDK';
  console.warn(
    `[@cteno/sdk] call('${method}') ${reason}. It is not covered by semver and may change without notice. ` +
    `Pass { quiet: true } to silence this. Supported methods: import { STABLE_METHODS } from '@cteno/sdk/method-tiers'.`,
  );
}

async function resolveMachineId(transport: Transport, options: CallOptions): Promise<string> {
  const explicit = process.env.CTENO_MACHINE_ID;
  if (explicit) return explicit;
  // `list-local-rpc-methods` is registered UNSCOPED (it is how a client learns
  // the scope it should be using in the first place) and returns the machine
  // id alongside the method list. Because a stale socket file connects but
  // never replies, this call doubles as the liveness probe — reaching a reply
  // is the only proof the daemon behind this inode is alive.
  const info = await transport.request('list-local-rpc-methods', {}, options);
  if (object(info) && typeof info.machineId === 'string' && info.machineId) {
    return info.machineId;
  }
  throw new SdkError('PROTOCOL',
    'Could not determine the daemon machine id; set CTENO_MACHINE_ID to override', info);
}

/**
 * Decode one stored message row.
 *
 * The host stores `text` as a JSON envelope for structured frames and as
 * plain text for simple ones. We surface both: `text` always prints, `data`
 * carries structure when there was any.
 */
function decodeStoredMessage(entry: Record<string, unknown>, sessionId: string): CtenoMessage | null {
  const id = typeof entry.id === 'string' ? entry.id : '';
  const role = entry.role;
  const rawText = typeof entry.text === 'string' ? entry.text : '';
  if (role === 'user') {
    return { type: 'user', id, sessionId, text: extractText(rawText) };
  }
  if (role === 'assistant') {
    let data: unknown;
    try { data = JSON.parse(rawText); } catch { /* Plain text frame. */ }
    const kind = object(data) && object(data.content) && object(data.content.data) && typeof data.content.data.type === 'string'
      ? data.content.data.type
      : object(data) && object(data.content) && typeof data.content.type === 'string' && data.content.type !== 'acp'
        ? data.content.type : undefined;
    return { type: 'assistant', id, sessionId, text: extractText(rawText), data, ...(kind ? { kind } : {}) };
  }
  return null;
}

/** Best-effort plain rendering of a stored frame. */
function extractText(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  if (!object(parsed)) return raw;
  const content = parsed.content;
  if (typeof content === 'string') return content;
  if (object(content)) {
    if (typeof content.text === 'string') return content.text;
    const data = content.data;
    if (object(data) && typeof data.message === 'string') return data.message;
  }
  if (typeof parsed.text === 'string') return parsed.text;
  return raw;
}
