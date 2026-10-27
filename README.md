# Cteno SDK

Client libraries for driving a **locally running Cteno daemon**
from your own code: create agent sessions, stream their output, define tools
that execute in your process, and read results back.

| Package | Language | Directory | Status |
|---|---|---|---|
| `@cteno/sdk` | Node.js ≥ 20 (ESM + TypeScript types) | [`js/`](js/) | beta |
| `cteno-sdk` (`import cteno_sdk`) | Python ≥ 3.9, standard library only | [`python/`](python/) | beta |

Both speak the same protocol and have the same shape.

> **You need Cteno installed and running on the same machine.** The SDK is only a
> client. It never starts a daemon and does not contain the agent runtime. If the
> Cteno desktop app is running, a daemon is already running.

## Install

The packages are not on npm / PyPI yet. Install from this repository:

```bash
# Node
git clone https://github.com/zalan159/cteno-sdk && cd cteno-sdk/js
npm install && npm run build && npm pack      # -> cteno-sdk-0.1.0.tgz
cd /your/project && npm install /path/to/cteno-sdk-0.1.0.tgz

# Python
pip install "git+https://github.com/zalan159/cteno-sdk#subdirectory=python"
```

## Minimal example

```ts
import { query } from '@cteno/sdk/core';

for await (const message of query({ prompt: 'Summarize the files in this folder', cwd: '.' })) {
  if (message.type === 'assistant') console.log(message.text);
}
```

```python
import asyncio
from cteno_sdk import CtenoSession

async def main():
    async with await CtenoSession.open() as cteno:
        sid = await cteno.create(cwd=".")
        result = await cteno.run(sid, "Summarize the files in this folder")
        print(result.text)

asyncio.run(main())
```

More in [`examples/`](examples/): multi-turn sessions, client tools, structured output.

## Authentication: your OS user is the credential

There are no API keys or tokens. The daemon publishes an **owner socket**
(a mode `0600` Unix socket, or a named pipe on Windows) — the same endpoint the
Cteno app and its CLI use. The operating system decides who may open it: any
process running as you can, nobody else can. The SDK adds no authorization layer
of its own, because a process that can reach that socket could equally read your
home directory.

- **Discovery** is automatic: the SDK scans for daemon-published sockets and connects
  to the one that answers.
- Override with the `CTENO_HOST_ROOT` environment variable, or pass `socketPath`
  (Node) / a path to `CtenoSession.open()` (Python).
- For a remote daemon, the Node package can ride an already-authenticated Socket.IO
  connection that **you** provide (`@cteno/sdk/socketio`); the SDK never handles
  credentials.

If you need to defend against the calling process, you need a different process
boundary, not a different client library.

## Compatibility

| SDK | Minimum Cteno daemon | Notes |
|---|---|---|
| 0.1.x | 2.10.9 | sessions, streaming, history, traces, hooks |
| 0.1.x | 2.10.10 | per-session agent spec (`spec` / `AgentSpec`: custom prompt, client tools, limits, structured output, tenancy) |

The daemon advertises capabilities over `__rpc.hello` (`sdk-session-spec-v1`,
`hooks-subscribe-v1`). Hook subscriptions check this and fail with a clear error on
an older daemon; before relying on an agent spec, check `sdk-session-spec-v1`
(Python: `await cteno.capabilities()`; Node: `new CtenoClient(transport).hello()`). Methods listed in `@cteno/sdk/method-tiers` as **stable** follow
semver; everything else reachable through `call()` is a daemon internal and may
change without notice.

## Repository layout

```
js/         @cteno/sdk  (TypeScript sources, tests)
python/     cteno-sdk   (Python package, tests)
examples/   runnable examples for both
```

`js/src/generated/` holds wire types generated from the daemon's Rust definitions;
they are committed here so the repository builds on its own. Do not edit them by hand.

## Development

```bash
cd js && npm ci && npm test                       # build + unit tests (fake daemon, no model)
cd python && python -m unittest discover -s tests
```

Tests never talk to a real daemon. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
