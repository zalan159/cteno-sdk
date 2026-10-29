# cteno-sdk (Python)

Run Cteno agents from Python — same protocol and shape as the Node package
`@cteno/sdk`. Standard library only, Python ≥ 3.9, asyncio.

The platform wheels (macOS arm64/x64, Linux x64 with glibc ≥ 2.34, Windows x64;
Linux arm64 is not supported yet)
include the Cteno daemon. `CtenoSession.open()` starts it in local mode on first use:
no desktop app, no account, your own model key.

## Install

```bash
pip install cteno-sdk
```

On a platform without a wheel pip falls back to the sdist, which has no daemon: set
`CTENO_SDK_DAEMON_PATH` to a `cteno-host-cli` binary, or pass `socket_path` to a daemon
you run yourself.

## Quickstart

```python
import asyncio, os
from cteno_sdk import CtenoSession

async def main():
    async with await CtenoSession.open() as cteno:          # starts the bundled daemon if needed
        await cteno.configure_model(base_url="https://api.openai.com/v1", model="gpt-4.1-mini",
                                    api_key=os.environ["OPENAI_API_KEY"])   # once; stays the default
        sid = await cteno.create(cwd=".")
        result = await cteno.run(sid, "Reply with exactly: hello from Cteno")
        print(result.text if result.ok else result.error)   # hello from Cteno
        await cteno.close_session(sid)

asyncio.run(main())
```

`base_url` is used as given: include the API version (`https://api.openai.com/v1`,
`https://api.deepseek.com/anthropic/v1`, `https://generativelanguage.googleapis.com/v1beta`);
the SDK appends only the resource path. A base that is missing or repeats a version
segment makes `configure_model()` raise `SdkError` naming the full URL it would have
requested. `result.ok` is `False` when the turn failed (model 404/401/429, quota,
timeout); `result.error` is the original error text and `result.error_kind` its class.

Tools that are not read-only are denied at once unless you approve them:

```python
result = await cteno.run(sid, "Run the tests", can_use_tool=lambda req: req["tool_name"] == "Bash")
```

`can_use_tool` may be async and may return `{"allow": False, "reason": "..."}`. The
daemon keeps running after your process exits; `await stop_daemon()` stops it.

## Your own agent

```python
import asyncio
from cteno_sdk import CtenoSession, AgentSpec, ClientTool

async def search_places(args, ctx):          # runs in YOUR process
    return {"name": "Quiet Corner Cafe", "keyword": args["keyword"]}

async def main():
    async with await CtenoSession.open() as cteno:      # bundled daemon, or open("/path/to/host.sock")
        sid = await cteno.create(model="my-profile", spec=AgentSpec(
            system_prompt="You are a city guide.",
            tools={"allow": []},
            client_tools=[ClientTool("search_places", "Search places",
                                     {"type": "object", "properties": {"keyword": {"type": "string"}},
                                      "required": ["keyword"]},
                                     handler=search_places)],
            limits={"maxIterations": 10, "turnTimeoutMs": 60_000},
        ))
        result = await cteno.run(sid, "Somewhere quiet for coffee?", timeout=90)
        print(result.ok, result.text, result.tool_calls)
        await cteno.close_session(sid)

asyncio.run(main())
```

`AgentSpec` (custom prompt, client tools, terminal tools, output schema, limits,
history, tenant) is supported by the bundled daemon; with an explicit `socket_path` to
another daemon it needs ≥ 2.10.10 (`"sdk-session-spec-v1" in await cteno.capabilities()`).
See the [repository README](../README.md) for authentication and compatibility, and
the Node [README](../js/README.md) for the full spec field reference (same fields, snake_case here).

## Tests

```bash
python -m unittest discover -s tests
```

## License

MIT. The daemon binaries under `cteno_sdk/_bin` are not MIT; see
`cteno_sdk/_bin/LICENSE.daemon` in the wheel.
