# @cteno/sdk

Node.js client for a **locally running Cteno daemon**. Create a session, send a
prompt, stream the answer — or build your own agent on Cteno with your own system
prompt and tools that run in your process.

Requires Node ≥ 20 and a running Cteno daemon (the Cteno desktop app runs one).
The SDK never starts a daemon for you.

## Install

Not on npm yet; build a tarball from this repository:

```bash
cd js && npm install && npm run build && npm pack
npm install /path/to/cteno-sdk-0.1.0.tgz      # in your project
```

## One-shot query

```ts
import { query } from '@cteno/sdk/core';

for await (const message of query({ prompt: 'Summarize the files in this folder', cwd: './src' })) {
  if (message.type === 'assistant') console.log(message.text);
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

`permissionMode`: `default` asks for anything not pre-approved (right when a human
watches the Cteno app), `acceptEdits`, `bypassPermissions` (the usual choice for
unattended automation — only when you control the prompt and working directory),
`plan` (no mutations).

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

## Connection and authentication

The SDK talks to the daemon's owner socket — mode `0600` Unix socket or named pipe.
Your OS user is the credential; there are no tokens. Discovery scans for
daemon-published sockets; override with `CTENO_HOST_ROOT` or `socketPath`.

## Entry points

| Import | What |
|---|---|
| `@cteno/sdk/core` | `query`, `CtenoSession`, agent spec, hooks |
| `@cteno/sdk` | `Transport` interface, `SdkError`, minimal `CtenoClient` |
| `@cteno/sdk/node` | raw Unix-socket / named-pipe transport (explicit path) |
| `@cteno/sdk/discover` | socket discovery on its own |
| `@cteno/sdk/socketio` | adapter for an injected, already-authenticated Socket.IO client |
| `@cteno/sdk/method-tiers` | stable/internal method classification |

## License

MIT
