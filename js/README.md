# @cteno/sdk

Run Cteno agents from Node.js. Create a session, send a prompt, stream the answer —
or build your own agent on Cteno with your own system prompt and tools that run in
your process.

> **The npm package is coming soon** (with Cteno 2.10.12). Until then, build from
> source and point the SDK at a daemon: see the repository README, "Use from source".

Once published, `npm install @cteno/sdk` also installs the Cteno daemon for your platform
(`@cteno/sdk-<os>-<arch>`, an optional dependency). `CtenoSession.open()` starts it in
local mode on first use: no desktop app, no account, your own model key. Requires
Node ≥ 20.

## Install

```bash
# coming soon — not published yet
npm install @cteno/sdk
```

Register a model once (BYOK; stored in the SDK daemon's own data directory):

```ts
import { CtenoSession } from '@cteno/sdk/core';

const cteno = await CtenoSession.open();
await cteno.configureModel({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: process.env.OPENAI_API_KEY! });
```

See the [repository README](../README.md) for platforms, permissions, the daemon's
lifecycle and troubleshooting.

## One-shot query

```ts
import { query } from '@cteno/sdk/core';

for await (const message of query({ prompt: 'Summarize the files in this folder', cwd: './src' })) {
  if (message.type === 'assistant' && (message.kind === undefined || message.kind === 'message')) {
    console.log(message.text);   // answer text only; structured frames carry `kind`
  }
}
```

`query()` and `send()` yield a discriminated union:

| `type` | Meaning |
|---|---|
| `user` | Your prompt, echoed once the daemon durably accepted it |
| `assistant` | A model frame. `text` always prints; `data` holds the parsed envelope for structured frames (tool calls, task lifecycle) |
| `status` | Session went thinking/idle — progress UI, safe to ignore |
| `result` | Turn finished. `ok: false` carries `error`. Always last |

Breaking out of the loop early aborts your local wait and releases the connection;
the daemon may still be working, exactly like `ctrl-C` on a CLI. Neither a timeout
nor an abort proves the daemon stopped.

## Multi-turn sessions

```ts
import { CtenoSession } from '@cteno/sdk/core';

const session = await CtenoSession.open();
const id = await session.create({ cwd: './src', title: 'refactor', permissionMode: 'bypassPermissions' });

for await (const message of session.send({ sessionId: id, prompt: 'Start with the parser' })) {
  if (message.type === 'assistant') console.log(message.text);
}
const { ok, text } = await session.run({ sessionId: id, prompt: 'Now write tests' });

const history = await session.history(id);
const trace = await session.trace(id);
const profiles = await session.listProfiles();   // model profiles the daemon can run

await session.close(id);
session.dispose();
```

Tools that are not read-only need approval. Without one the SDK denies them at once
(the model is told why), so nothing hangs. Decide per call with `canUseTool`
on `send()` / `run()` / `query()`:

```ts
await session.run({ sessionId: id, prompt: 'Run the tests',
  canUseTool: req => req.toolName === 'Bash' ? { allow: true } : { allow: false, reason: 'no' } });
```

or set `permissionMode` on `create()`: `acceptEdits` (file edits allowed),
`plan` (no mutations), `bypassPermissions` (everything runs — only when you control
the prompt and working directory).

## Your own agent: prompt, client tools, structured output

Needs daemon ≥ 2.10.10 (capability `sdk-session-spec-v1`).

```ts
const id = await session.create({
  model: 'my-profile',
  spec: {
    systemPrompt: 'You are a city guide. Answer with one recommendation.',
    tools: { allow: [] },                               // no built-in Cteno tools
    clientTools: [{
      name: 'search_places',
      description: 'Search places by keyword',
      inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
      handler: async ({ keyword }) => mySearch(String(keyword)),   // runs in YOUR process
    }],
    outputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    limits: { maxIterations: 10, maxToolCalls: 8, turnTimeoutMs: 60_000 },
  },
});
const result = await session.run({ sessionId: id, prompt: 'Somewhere quiet for coffee?' });
console.log(result.output);                              // parsed structured result
```

Keep the `CtenoSession` open while the session runs: it serves the client tools.
After reconnecting, re-attach handlers with `serveClientTools(id, tools)`.

| Spec field | Notes |
|---|---|
| `systemPrompt` | string = replace (a short safety floor is kept); `{ mode: 'append', text }` keeps Cteno's prompt |
| `context` | `datetime` (default on), `language`, `modelIdentity`, `skills`, `workspace`, `extra: string[]` |
| `tools.allow` / `deny` | built-in and MCP tools; `prefix*` patterns |
| `clientTools` | ≤ 64; name `[A-Za-z0-9_-]`; a throwing handler becomes a tool error the model can retry |
| `terminalTools`, `requireTerminalTool` | the turn ends on the first successful terminal call |
| `outputSchema` | adds `final_result`; `run()` returns its parsed input as `output` |
| `limits` | can only tighten daemon defaults |
| `history` | ≤ 200 `user`/`assistant` messages from your own store, context only |
| `tenant` | `{ tenantId, userId }` — isolates workdir, memory and quota per end user |

Tenant sessions are meant for untrusted end users: their built-in tools are capped,
writes are confined to a per-user directory, and per-tenant admission is controlled
with `tenantPolicy()` / `tenantStatus()`.

## Hooks

```ts
const unsubscribe = await session.hooks.on('PreToolUse', 'shell', call => {
  if (JSON.stringify(call.payload.tool_input ?? {}).includes('rm -rf')) return { decision: 'deny', reason: 'not here' };
});
```

## Raw method calls and stability

Anything not wrapped is reachable by the daemon's own method name (the machine-id
scope is added for you):

```ts
await session.call('get-session-trace', { sessionId: id });
```

Methods in `STABLE_METHODS` (`@cteno/sdk/method-tiers`) follow semver. Others are
daemon internals: `call()` still works but warns once; pass `{ quiet: true }` when the
dependency is deliberate.

## The daemon and the connection

`CtenoSession.open()` attaches to the SDK's own daemon (one per user and instance
root, default `~/Library/Application Support/cteno-sdk`, `~/.local/share/cteno-sdk`,
`%LOCALAPPDATA%\cteno-sdk`; override with `CTENO_SDK_HOME` or `open({ daemon: { home } })`)
and starts it if needed. It is separate from a Cteno desktop app on the same machine
and never connects to it unless you pass `socketPath`. The daemon keeps running after
your process exits; `stopDaemon()` from `@cteno/sdk/daemon` stops it.

The connection is the daemon's owner socket — a mode `0600` Unix socket, or a
per-root named pipe on Windows. Your OS user is the credential; there are no tokens.

## Entry points

| Import | What |
|---|---|
| `@cteno/sdk/core` | `query`, `CtenoSession`, agent spec, hooks |
| `@cteno/sdk` | `Transport` interface, `SdkError`, minimal `CtenoClient` |
| `@cteno/sdk/node` | raw Unix-socket / named-pipe transport (explicit path) |
| `@cteno/sdk/daemon` | `ensureDaemon`, `stopDaemon`, `instanceLayout`: the bundled daemon |
| `@cteno/sdk/discover` | find a Cteno app's daemon socket (never used by `open()`) |
| `@cteno/sdk/socketio` | adapter for an injected, already-authenticated Socket.IO client |
| `@cteno/sdk/method-tiers` | stable/internal method classification |

## License

MIT. The daemon binaries in `@cteno/sdk-<platform>` are not MIT; see the
`LICENSE.daemon` file inside that package.
