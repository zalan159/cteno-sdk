"""Cteno Agent SDK for Python — same owner-socket protocol as ``@cteno/sdk/core``.

    import asyncio
    from cteno_sdk import CtenoSession, AgentSpec, ClientTool

    async def main():
        async with await CtenoSession.open() as cteno:
            sid = await cteno.create(model="my-profile", spec=AgentSpec(
                system_prompt="You are a food guide.",
                client_tools=[ClientTool("lookup_place", "Find a place", {"type": "object"},
                                         handler=lambda args, ctx: {"name": args.get("name")})],
            ))
            result = await cteno.run(sid, "Where should I eat?")
            print(result.text)

    asyncio.run(main())

See the repository README for the full guide.
"""
from .client import (
    AGENT_SPEC_CAPABILITY,
    AgentSpec,
    ClientTool,
    ClientToolContext,
    CtenoSession,
    RunResult,
    SdkError,
    TenantRef,
    discover_owner_sockets,
    spec_to_wire,
)

__all__ = [
    "AGENT_SPEC_CAPABILITY",
    "AgentSpec",
    "ClientTool",
    "ClientToolContext",
    "CtenoSession",
    "RunResult",
    "SdkError",
    "TenantRef",
    "discover_owner_sockets",
    "spec_to_wire",
]
__version__ = "0.1.0"
