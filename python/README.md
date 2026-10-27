# cteno-sdk (Python)

Python client for a **locally running Cteno daemon** — same owner-socket protocol and
shape as the Node package `@cteno/sdk`. Standard library only, Python ≥ 3.9, asyncio.

Requires a running Cteno daemon on the same machine (the Cteno desktop app runs one).
The SDK never starts one for you.

## Install

Not on PyPI yet:

```bash
pip install "git+https://github.com/zalan159/cteno-sdk#subdirectory=python"
```

## Usage

```python
import asyncio
from cteno_sdk import CtenoSession, AgentSpec, ClientTool

async def search_places(args, ctx):          # runs in YOUR process
    return {"name": "Quiet Corner Cafe", "keyword": args["keyword"]}

async def main():
    async with await CtenoSession.open() as cteno:      # auto-discovery, or open("/path/to/host.sock")
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
history, tenant) needs daemon ≥ 2.10.10; check `"sdk-session-spec-v1" in await cteno.capabilities()`.
See the [repository README](../README.md) for authentication and compatibility, and
the Node [README](../js/README.md) for the full spec field reference (same fields, snake_case here).

## Tests

```bash
python -m unittest discover -s tests
```

## License

MIT
