"""List recent sessions, run a task in a new one, then read its history back.

    python sessions.py
"""
import asyncio

from cteno_sdk import CtenoSession


async def main() -> None:
    async with await CtenoSession.open() as cteno:
        # Anything without a dedicated wrapper is reachable by method name.
        listing = await cteno.call("list-sessions", {})
        sessions = listing.get("sessions", []) if isinstance(listing, dict) else []
        print("%d sessions" % len(sessions))
        for s in sessions[:5]:
            meta = s.get("metadata") or {}
            print("  %s  %s" % (s.get("id"), meta.get("name") or s.get("title") or "(untitled)"))

        sid = await cteno.create(cwd=".", title="sdk python sessions example",
                                 permission_mode="bypassPermissions")
        result = await cteno.run(sid, "Count the files (not directories) directly in the working "
                                      "directory. Answer with just the number.", timeout=300)
        print("ok:", result.ok, "answer:", result.text)
        print("tools used:", [c.get("name") for c in result.tool_calls])

        history = await cteno.history(sid)
        print("history: %d messages" % len(history))
        await cteno.close_session(sid)


if __name__ == "__main__":
    asyncio.run(main())
