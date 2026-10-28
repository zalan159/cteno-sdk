"""Cteno Agent SDK for Python — same owner-socket protocol as ``@cteno/sdk/core``.

    import asyncio
    from cteno_sdk import CtenoSession, AgentSpec, ClientTool

    async def main():
        # Starts (or reuses) the SDK's own local daemon; no Cteno app or login needed.
        async with await CtenoSession.open() as cteno:
            await cteno.configure_model(base_url="https://api.deepseek.com/anthropic",
                                        model="deepseek-chat", api_key=os.environ["DEEPSEEK_API_KEY"],
                                        api_format="anthropic")
            sid = await cteno.create(spec=AgentSpec(
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
from .daemon import (
    DaemonError,
    default_instance_root,
    ensure_daemon,
    instance_layout,
    isolated_pipe_name,
    resolve_daemon_binary,
    stop_daemon,
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
    "DaemonError",
    "default_instance_root",
    "ensure_daemon",
    "instance_layout",
    "isolated_pipe_name",
    "resolve_daemon_binary",
    "stop_daemon",
]
__version__ = "0.2.0"
