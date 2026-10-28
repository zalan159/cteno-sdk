"""Clean-machine consumer check for cteno-sdk (Python) with the bundled daemon.

Env: MOCK_URL. Prints one JSON line per check; exits non-zero on failure.
"""
import asyncio
import json
import os
import sys
import time

from cteno_sdk import CtenoSession, instance_layout, stop_daemon


def out(check, **kw):
    print(json.dumps(dict(check=check, **kw)), flush=True)


async def main():
    layout = instance_layout()
    t0 = time.monotonic()
    # README quickstart (with the BYOK step).
    async with await CtenoSession.open() as cteno:
        out("open", ok=True, started=cteno.daemon.started, endpoint=cteno.socket_path,
            secs=round(time.monotonic() - t0, 2), root=str(layout.root))
        await cteno.configure_model(base_url=os.environ["MOCK_URL"], model="mock-model", api_key="sk-mock-not-secret")
        sid = await cteno.create(cwd=".")
        result = await cteno.run(sid, "Reply with exactly: hello from Cteno")
        print(result.text if result.ok else result.error)
        out("quickstart", ok=result.ok and "hello from Cteno" in result.text, text=result.text)
        if not result.ok:
            sys.exit(1)
        started = time.monotonic()
        sid2 = await cteno.create(cwd=".")
        denied = await cteno.run(sid2, "PROBE_TOOL: run touch sdk-probe.txt", timeout=120)
        secs = time.monotonic() - started
        out("deny-default", ok=denied.ok and bool(denied.tool_calls) and secs < 60 and not os.path.exists("sdk-probe.txt"),
            secs=round(secs, 1), tools=[c["name"] for c in denied.tool_calls])
        seen = []
        sid3 = await cteno.create(cwd=".")
        allowed = await cteno.run(sid3, "PROBE_TOOL: run touch sdk-probe.txt", timeout=120,
                                  can_use_tool=lambda req: seen.append(req["tool_name"]) or True)
        out("can_use_tool-allow", ok=allowed.ok and bool(seen) and os.path.exists("sdk-probe.txt"), seen=seen)
        if not os.path.exists("sdk-probe.txt"):
            sys.exit(1)
    async with await CtenoSession.open() as again:
        out("reattach", ok=again.daemon.started is False)
    out("stop", ok=await stop_daemon())


asyncio.run(main())
