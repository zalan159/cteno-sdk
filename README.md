# Cteno SDK

**Run the Cteno agent from your own Node.js or Python code. No desktop app, no account.**

Once published, `npm install @cteno/sdk` or `pip install cteno-sdk` (coming soon) also
installs a small local Cteno daemon for your platform. The first `CtenoSession.open()` starts it in **local mode**:
no login, no Cteno account, your own model key (BYOK). Your code creates agent sessions,
streams their output, runs tools you define in your own process, and reads results back.

If you also use the Cteno desktop app, nothing changes for it: the SDK's daemon keeps
its own data, socket, machine id and logs, and never connects to the app's daemon
unless you pass its socket path explicitly.

[中文说明 / Chinese](README.zh-CN.md)

| Package | Language | Directory | Status |
|---|---|---|---|
| `@cteno/sdk` | Node.js ≥ 20 (ESM, TypeScript types included) | [`js/`](js/) | beta |
| `cteno-sdk` (`import cteno_sdk`) | Python ≥ 3.9, standard library only | [`python/`](python/) | beta |

Both packages use the same protocol and have the same shape.

> **Status: the npm and PyPI packages are coming soon** (they ship with Cteno 2.10.12).
> Until then, use the SDK from source: see [Use from source](#use-from-source-today).
> The `npm install` / `pip install` lines below are marked *coming soon* and will
> not work yet.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [5-minute quickstart](#5-minute-quickstart)
- [Permissions](#permissions-what-runs-without-asking)
- [Common tasks](#common-tasks)
- [The bundled daemon](#the-bundled-daemon)
- [Troubleshooting](#troubleshooting)
- [Compatibility](#compatibility)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)

## Requirements

- Node.js ≥ 20, or Python ≥ 3.9.
- One of the platforms planned for 2.10.12: macOS (Apple silicon; Intel ≥ 10.15),
  Linux x64 with glibc ≥ 2.34 (Ubuntu 22.04+, Debian 12+, RHEL 9+), Windows x64.
  Linux arm64 is not supported yet.
- **An API key for a model provider** with an OpenAI-, Anthropic- or Gemini-compatible
  endpoint (OpenAI, DeepSeek, Moonshot, OpenRouter, a local Ollama/vLLM server, …).
  You register it once with `configureModel()`; see the quickstart.

You do **not** need the Cteno desktop app or a Cteno account.

## Install

### Use from source (today)

The packages are not on npm / PyPI yet, so a source checkout has no bundled daemon.
Point the SDK at a daemon you already have:

- **Cteno desktop app ≥ 2.10.10 running:** pass its socket path to `open()`
  (`socketPath` in Node, `socket_path` in Python), or
- **a `cteno-host-cli` binary:** set `CTENO_SDK_DAEMON_PATH` to it and `open()` starts
  it in the SDK's own data directory.

```bash
git clone https://github.com/zalan159/cteno-sdk && cd cteno-sdk
cd js && npm install && npm run build && cd ..   # Node: build once, then import from ./js
pip install ./python                             # Python: install the source package
```

### From npm / PyPI (coming soon, with Cteno 2.10.12)

```bash
# coming soon — not published yet
npm install @cteno/sdk
pip install cteno-sdk
```

Once published, npm installs only the platform package that matches your machine
(`@cteno/sdk-darwin-arm64`, `@cteno/sdk-darwin-x64`, `@cteno/sdk-linux-x64` or `@cteno/sdk-win32-x64`,
about 20 MB). pip picks the platform wheel the same way. Do not install with
`--omit=optional` / `--no-optional`: the daemon is an optional dependency.

On another platform, or from the pure-Python sdist, the SDK installs but cannot start a
daemon; see [Troubleshooting](#troubleshooting).

## 5-minute quickstart

Register your model once (it is stored in the SDK daemon's own data directory and stays
the default), then ask something. `hello.mjs`:

```js
import { CtenoSession, query } from '@cteno/sdk/core';

const cteno = await CtenoSession.open();            // starts the bundled daemon on first use
await cteno.configureModel({
  baseUrl: 'https://api.openai.com/v1',             // any OpenAI-compatible endpoint
  model: 'gpt-4.1-mini',
  apiKey: process.env.OPENAI_API_KEY,
});
cteno.dispose();

for await (const m of query({ prompt: 'Reply with exactly: hello from Cteno', cwd: '.' })) {
  if (m.type === 'assistant' && (m.kind === undefined || m.kind === 'message')) console.log(m.text);
  if (m.type === 'result') console.log(m.ok ? '[done]' : `[failed] ${m.error}`);
}
```

```console
$ OPENAI_API_KEY=sk-... node hello.mjs
hello from Cteno
[done]
```

The same in Python (`hello.py`):

```python
import asyncio, os
from cteno_sdk import CtenoSession

async def main():
    async with await CtenoSession.open() as cteno:
        await cteno.configure_model(base_url="https://api.openai.com/v1", model="gpt-4.1-mini",
                                    api_key=os.environ["OPENAI_API_KEY"])
        sid = await cteno.create(cwd=".")
        result = await cteno.run(sid, "Reply with exactly: hello from Cteno")
        print(result.text if result.ok else result.error)
        await cteno.close_session(sid)

asyncio.run(main())
```

```console
$ OPENAI_API_KEY=sk-... python hello.py
hello from Cteno
```

The first `open()` on a machine takes a second or two while the daemon starts and
prepares its database; later calls attach to the running daemon instantly. For an
Anthropic- or Gemini-style endpoint pass `apiFormat: 'anthropic'` / `'gemini'`
(`api_format=` in Python).

**What the stream contains.** `query()` / `send()` yield messages with a `type`:

| `type` | Meaning |
|---|---|
| `user` | Your prompt, echoed once the daemon has durably accepted it |
| `assistant` | One agent frame. Plain answer text has no `kind` (or `kind: 'message'`). Structured frames set `kind` (`thinking`, `tool-call`, `tool-result`, `task_started`, `task_complete`, `context_usage`, …), with the parsed frame in `data` |
| `status` | Session started or stopped working. Safe to ignore |
| `result` | The turn finished. Always last. `ok: false` carries `error` |

If you print every `assistant` frame without checking `kind`, you will also see
raw JSON for thinking and tool frames. That is expected; filter on `kind`.

## Permissions: what runs without asking

The SDK runs unattended, so it never waits for a person:

- **Read-only tools** (reading files, searching, listing) run automatically.
- **Every other tool** (shell commands, file edits, network, browser, …) needs
  approval. Without an approver the SDK **denies it immediately** and the model is told
  why, so the turn finishes instead of hanging.
- Pass **`canUseTool`** (`can_use_tool` in Python) to decide yourself:

```js
const result = await session.run({
  sessionId: id,
  prompt: 'Create notes.txt with today\'s date',
  canUseTool: req => req.toolName === 'Bash' && !/rm\s/.test(JSON.stringify(req.input))
    ? { allow: true }
    : { allow: false, reason: 'not allowed by my app' },
});
```

```python
result = await cteno.run(sid, "Create notes.txt with today's date",
                         can_use_tool=lambda req: req["tool_name"] == "Bash")
```

  An allowed call runs and the turn continues; `run()` / `send()` resolve only after
  the whole turn, including the part after your approval, has finished.
- Or set a **permission mode** for the session: `create({ permissionMode })` with
  `acceptEdits` (file edits allowed, other tools still go through `canUseTool`),
  `plan` (no changes) or `bypassPermissions` (everything runs; only for prompts and
  working directories you fully control).

## Common tasks

Every snippet below is also a runnable file in [`examples/`](examples/). To run them
from a clone:

```bash
cd js && npm install && npm run build && cd ..   # build the Node package once
cd examples/node && npm install                  # links ../../js
node list-sessions.mjs

pip install ./python
python examples/python/quickstart.py
```

### List sessions and model profiles

[`examples/node/list-sessions.mjs`](examples/node/list-sessions.mjs)

```js
import { CtenoSession } from '@cteno/sdk/core';

const session = await CtenoSession.open();
for (const s of await session.listSessions()) console.log(s.id, s.title ?? '(untitled)');
console.log((await session.listProfiles()).map(p => p.id));
session.dispose();
```

### Hand off a task and wait for the result

[`examples/node/run-task.mjs`](examples/node/run-task.mjs) ·
[`examples/python/sessions.py`](examples/python/sessions.py)

```js
const id = await session.create({ cwd: '/path/to/project', permissionMode: 'bypassPermissions' });
const result = await session.run({ sessionId: id, prompt: 'Count the files here. Answer with just the number.' });
console.log(result.ok, result.text);                    // true '12'
console.log(result.toolCalls.map(c => c.name));         // [ 'Bash' ]
const trace = await session.trace(id);                  // persisted messages of the session
await session.close(id);
```

`run()` sends one prompt and resolves when the turn finishes. `toolCalls` lists the
tools the model called. Use `send()` instead if you want the turn streamed.

Here `bypassPermissions` lets the shell run; without it the SDK would deny the shell
call (see [Permissions](#permissions-what-runs-without-asking)).

### Watch a turn live, and veto tool calls

[`examples/node/stream-events.mjs`](examples/node/stream-events.mjs)

```js
const unhook = await session.hooks.on('PreToolUse', null, call => {
  if (JSON.stringify(call.payload?.tool_input ?? {}).includes('rm -rf')) {
    return { decision: 'deny', reason: 'blocked by SDK policy' };
  }
}, { sessions: [id] });

for await (const m of session.send({ sessionId: id, prompt: 'Run ls and count the entries.' })) {
  if (m.type === 'assistant' && m.kind === 'tool-call') console.log('tool:', m.data?.content?.data?.name);
  if (m.type === 'result') console.log('done, ok =', m.ok);
}
await unhook();
```

Hooks use the same event names and outcome shape as Cteno plugins (`PreToolUse`,
`PostToolUse`, `Stop`, …). A handler that throws or does not answer in time fails
**open** (the tool runs).

### Multi-turn conversation

[`examples/node/multi-turn.mjs`](examples/node/multi-turn.mjs)

```js
const id = await session.create({ cwd: '.' });
await session.run({ sessionId: id, prompt: 'Pick a random fruit and remember it.' });
const { text } = await session.run({ sessionId: id, prompt: 'Which fruit did you pick?' });
const history = await session.history(id);
```

### Your own agent: system prompt, tools in your process, structured output

Needs Cteno ≥ 2.10.10. [`examples/node/client-tools.mjs`](examples/node/client-tools.mjs) ·
[`examples/python/query.py`](examples/python/query.py)

```js
const id = await session.create({
  spec: {
    systemPrompt: 'You are a city guide. Use search_places, then pick one place.',
    tools: { allow: [] },                                  // no built-in Cteno tools
    clientTools: [{
      name: 'search_places',
      description: 'Search places by keyword',
      inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
      handler: async ({ keyword }) => mySearch(keyword),  // runs in YOUR process
    }],
    outputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    limits: { maxIterations: 6, turnTimeoutMs: 60_000 },
  },
});
const result = await session.run({ sessionId: id, prompt: 'Somewhere quiet for coffee?' });
console.log(result.output);   // { name: 'Quiet Corner Cafe', ... }
```

Keep the `CtenoSession` open while the session runs; it is what answers the client
tool calls. The full field reference is in [`js/README.md`](js/README.md).

## The bundled daemon

**Where it lives.** One directory per user holds everything the SDK's daemon owns:

| OS | Default instance root |
|---|---|
| macOS | `~/Library/Application Support/cteno-sdk` |
| Linux | `$XDG_DATA_HOME/cteno-sdk` or `~/.local/share/cteno-sdk` |
| Windows | `%LOCALAPPDATA%\cteno-sdk` |

Inside: `data/` (database, model profiles, machine id), `home/` (agent memory and
workspace), `run/` (the socket), `logs/daemon.log`. Set `CTENO_SDK_HOME` (or
`open({ daemon: { home } })`, `open(home=...)` in Python) to use another root; each
root is a separate daemon with separate data.

**Lifecycle.** `open()` attaches to the daemon of that root if it is running and starts
it otherwise. The daemon is shared by every SDK process of the same user and root, and
keeps running after your process exits so sessions can finish and the next `open()` is
instant. Stop it with `stopDaemon()` (`from cteno_sdk import stop_daemon`). Your
sessions and data stay on disk.

**Upgrades.** The daemon version is pinned to the SDK version. After you upgrade the
SDK, the next `open()` replaces an older running daemon with the new bundled one;
data is migrated in place. Set `CTENO_SDK_KEEP_DAEMON=1` to always keep the running one.

**Security: your OS user is the credential.** There are no SDK tokens. The daemon
listens on a Unix socket with mode `0600` (a per-root named pipe on Windows) and binds
no TCP port. Any process running as your user can use it; other users cannot.
Your model key is stored in the daemon's data directory with your user's permissions.

**Local mode.** The daemon never logs in, so it has no Cteno account, cloud relay or
sync: sessions, history and memory exist only on this machine, and model calls go to
the endpoint you configured. Cloud features of the Cteno app (remote access from your
phone, sync across devices) are not available to the SDK daemon.

**Next to the Cteno desktop app.** Both run side by side without seeing each other:
separate data directory, socket, machine id, sessions and logs. To drive the app's
daemon instead (for example to see sessions in the app), pass its socket explicitly:
`CtenoSession.open({ socketPath })` / `CtenoSession.open("/path/to/host.sock")`.
`cteno-host-cli status` in the app prints that path as `host_socket_active`.
`discoverOwnerSocket()` (`@cteno/sdk/discover`) can look it up; `open()` never does.

**Your own daemon build.** Set `CTENO_SDK_DAEMON_PATH` to a `cteno-host-cli` binary to
use it instead of the bundled one.

**Remote daemon:** the Node package can ride an already-authenticated Socket.IO
connection that you provide (`@cteno/sdk/socketio`). The SDK never handles
credentials for it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `The platform package @cteno/sdk-<platform> is not installed` | npm skipped optional dependencies. Reinstall without `--omit=optional` / `--no-optional`, or `npm install @cteno/sdk-<platform>` explicitly. |
| From source: `The platform package @cteno/sdk-<platform> is not installed` | A source checkout has no bundled daemon until the npm packages ship. Pass the desktop app's `socketPath`, or set `CTENO_SDK_DAEMON_PATH` (see [Use from source](#use-from-source-today)). |
| `No bundled Cteno daemon for <os>-<arch>` | Your platform has no prebuilt daemon (see [Requirements](#requirements)). Set `CTENO_SDK_DAEMON_PATH` to a `cteno-host-cli` you built, or pass `socketPath` to a daemon you run yourself. |
| Python: `This cteno-sdk install has no bundled daemon` | pip installed the sdist (no wheel for your platform, or `--no-binary`). Use `pip install --only-binary=:all: cteno-sdk` on a supported platform, or set `CTENO_SDK_DAEMON_PATH`. |
| `The bundled Cteno daemon exited during startup` | The error includes the end of `logs/daemon.log` under the instance root. On Linux, `GLIBC_2.34 not found` means the distribution is too old. |
| `result.ok` is false with a model, auth or quota error | Your model profile cannot run: check `baseUrl`, `model`, `apiKey` and `apiFormat`, then call `configureModel()` again (same `id` replaces it). `listProfiles()` shows what is configured. |
| A tool call came back denied: "No approver is attached …" | That is the default for non-read-only tools. Pass `canUseTool`, or choose a `permissionMode` (see [Permissions](#permissions-what-runs-without-asking)). |
| `EACCES` / `permission denied` on the socket | Another OS user started the daemon in this root. Run as the same user, or use your own `CTENO_SDK_HOME`. |
| You expected your sessions in the Cteno desktop app | The SDK uses its own daemon, so its sessions are not in the app. Pass the app's `socketPath` to use the app's daemon instead. |
| `Cannot find package '@cteno/sdk'` when running an example | Run examples from `examples/node` after `npm install` there (see [Common tasks](#common-tasks)), or copy them into your own project. |
| Printed output is full of JSON | You are printing every `assistant` frame. Filter on `kind` as shown in the quickstart. |

## Compatibility

| SDK | Bundled daemon | Platforms with a bundled daemon |
|---|---|---|
| 2.10.12 (coming soon) | Cteno 2.10.12 | macOS arm64 / x64, Linux x64 (glibc ≥ 2.34), Windows x64 |
| 2.10.11 (not published) | Cteno 2.10.11 | – |
| 0.2.0 (not published) | Cteno 2.10.10 | – |
| 0.1.x | none: needs a running Cteno app or `cteno-host-cli serve` ≥ 2.10.9 | – |

With an explicit `socketPath` to another daemon: sessions, streaming, history, traces
and hooks need ≥ 2.10.9; custom agents (`spec` / `AgentSpec`) need ≥ 2.10.10.

| Platform | Tested |
|---|---|
| Linux x64 | clean container install from npm tarball and wheel, no Cteno, no account |
| macOS arm64 | next to a running Cteno desktop app |
| Windows x64 | npm tarball and wheel install |
| macOS x64 | planned for 2.10.12 |
| Linux arm64 | not supported yet (no daemon package) |

The daemon advertises its capabilities through `__rpc.hello`
(`sdk-session-spec-v1`, `hooks-subscribe-v1`). Check before relying on one:
`await cteno.capabilities()` in Python, `new CtenoClient(transport).hello()` in Node.
Methods listed as **stable** in `@cteno/sdk/method-tiers` follow semver. Everything
else reachable through `call()` is a daemon internal and may change without notice
(the SDK warns once when you use one).

## Known limitations

- **No browser automation yet.** The bundled daemon does not include the browser
  engine (it is several hundred MB); browser tools report that the engine is missing.
  On-demand download is planned.
- **Same machine, same OS user.** Remote use goes through the Node Socket.IO adapter
  with a connection you authenticate yourself.
- **The daemon outlives your process.** That is intentional (see
  [The bundled daemon](#the-bundled-daemon)); call `stopDaemon()` if you need it gone,
  for example at the end of a CI job.
- **`trace()` event types:** on Cteno 2.10.x, tool calls and tool results inside
  `trace().events` are reported as `assistant_message` rather than `tool_call` /
  `tool_result`. Use `run()`'s `toolCalls`, or the `kind` of streamed frames, to see
  which tools ran.
- `listSessions()` returns every session of the daemon you are connected to, including
  ones created by other SDK processes of the same user and root.

## Repository layout

```
js/         @cteno/sdk  (TypeScript sources, tests)
python/     cteno-sdk   (Python package, tests)
examples/   runnable examples for both
scripts/    platform packaging (pack-platform.mjs) and install tests (e2e/)
```

`js/src/generated/` holds wire types generated from the daemon's Rust definitions.
They are committed so the repository builds on its own. Do not edit them by hand.

## Development

```bash
cd js && npm ci && npm test                         # build + unit tests (fake daemon, no model)
cd python && python -m unittest discover -s tests
```

Unit tests never talk to a real daemon or model. `scripts/e2e/install-test.sh` installs
packed packages into an empty project and runs the quickstart against a local mock
model; the publish workflow runs it on every platform before anything is published.

## Contributing

Pull requests are welcome. This repository is a published snapshot: the SDK is
developed together with the Cteno daemon in a private upstream repository. An accepted
PR is applied upstream, credited to you with `Co-authored-by`, and comes back here in
the next export; the PR is then closed with a link to that commit instead of being
merged directly. Details are in [CONTRIBUTING.md](CONTRIBUTING.md). Report security
issues privately as described in [SECURITY.md](SECURITY.md).

## License

The SDK client code is [MIT](LICENSE). The daemon binaries in the platform packages
(`@cteno/sdk-<platform>`, `cteno_sdk/_bin` in the wheels) are not MIT; their terms are in
the `LICENSE.daemon` file shipped inside each platform package.
