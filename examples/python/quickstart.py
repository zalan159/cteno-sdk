"""Five-minute start: open a session, run one prompt, print the answer.

    python quickstart.py "What can you help me with?"

The SDK starts its bundled daemon on first use. Register a model once first
(see "5-minute quickstart" in ../../README.md).
"""
import asyncio
import sys

from cteno_sdk import CtenoSession

PROMPT = sys.argv[1] if len(sys.argv) > 1 else "Reply with one short sentence: what can you help me with?"


async def main() -> None:
    async with await CtenoSession.open() as cteno:
        sid = await cteno.create(cwd=".", permission_mode="bypassPermissions")
        result = await cteno.run(sid, PROMPT, timeout=300)
        print(result.text if result.ok else "turn failed: %s" % result.error)
        await cteno.close_session(sid)


if __name__ == "__main__":
    asyncio.run(main())
