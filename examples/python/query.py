"""Your own agent from Python: replaced prompt + a client tool + one turn.

    python examples/python/query.py [model-profile-id]

Requires a running Cteno daemon (>= 2.10.10 for AgentSpec) and `pip install ./python`.
"""
import asyncio
import sys

from cteno_sdk import AGENT_SPEC_CAPABILITY, AgentSpec, ClientTool, CtenoSession

PLACES = [
    {"name": "Quiet Corner Cafe", "tags": ["coffee", "quiet"]},
    {"name": "Riverside Noodles", "tags": ["food", "lunch"]},
]


async def search_places(args, ctx):
    keyword = str(args.get("keyword", "")).lower()
    return [p for p in PLACES if keyword in p["tags"]]


async def main() -> None:
    async with await CtenoSession.open() as cteno:
        if AGENT_SPEC_CAPABILITY not in await cteno.capabilities():
            raise SystemExit("daemon lacks %s; upgrade Cteno" % AGENT_SPEC_CAPABILITY)
        sid = await cteno.create(
            model=sys.argv[1] if len(sys.argv) > 1 else None,
            spec=AgentSpec(
                system_prompt="You are a city guide. Use search_places, then recommend one place.",
                tools={"allow": []},
                client_tools=[ClientTool(
                    "search_places", "Search places by keyword",
                    {"type": "object", "properties": {"keyword": {"type": "string"}}, "required": ["keyword"]},
                    handler=search_places)],
                limits={"maxIterations": 6, "maxToolCalls": 4, "turnTimeoutMs": 60_000},
            ),
        )
        result = await cteno.run(sid, "Somewhere quiet for coffee?", timeout=90)
        print("ok:", result.ok, result.error or "")
        print("tool calls:", [c.get("name") for c in result.tool_calls])
        print(result.text)
        await cteno.close_session(sid)


if __name__ == "__main__":
    asyncio.run(main())
