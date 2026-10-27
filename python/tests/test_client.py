"""Unit tests against an in-process fake owner socket (wire-level, no model)."""
import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cteno_sdk import AgentSpec, ClientTool, CtenoSession, SdkError, TenantRef, spec_to_wire  # noqa: E402

MACHINE = "cteno-test-machine"


class FakeHost:
    def __init__(self, handlers):
        self.handlers = handlers
        self.dir = tempfile.mkdtemp(prefix="cteno-py-sdk-")
        self.path = os.path.join(self.dir, "host.dev.sock")
        self.writers = []

    async def start(self):
        self.server = await asyncio.start_unix_server(self._serve, path=self.path)
        return self

    async def _serve(self, reader, writer):
        self.writers.append(writer)

        def send(frame):
            writer.write((json.dumps(frame) + "\n").encode())

        while True:
            line = await reader.readline()
            if not line:
                break
            request = json.loads(line)
            method = request["method"]
            unscoped = method[len(MACHINE) + 1:] if method.startswith(MACHINE + ":") else method
            if unscoped == "list-local-rpc-methods":
                send({"requestId": request["requestId"], "result": {"machineId": MACHINE}})
                continue
            if unscoped == "__rpc.subscribe":
                send({"requestId": request["requestId"], "result": {"subscribed": True}})
                continue
            handler = self.handlers.get(unscoped)
            if handler is None:
                send({"requestId": request["requestId"], "error": "Unknown method: " + method})
                continue
            result = handler(request.get("params") or {}, send)
            if asyncio.iscoroutine(result):
                result = await result
            send({"requestId": request["requestId"], "result": result})

    async def close(self):
        for writer in self.writers:
            writer.close()
        self.server.close()


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if sys.version_info < (3, 10) else asyncio.run(coro)


class SpecWireTest(unittest.TestCase):
    def test_string_prompt_is_replace_and_handlers_stay_local(self):
        wire = spec_to_wire(AgentSpec(
            system_prompt="You are X.",
            client_tools=[ClientTool("t1", "d", {"type": "object"}, handler=lambda a, c: 1, timeout_ms=5000)],
            terminal_tools=["t1"], require_terminal_tool=True,
            limits={"maxToolCalls": 3}, tenant=TenantRef("acme", "u1"),
            history=[{"role": "user", "text": "hi"}]))
        self.assertEqual(wire["systemPrompt"], {"mode": "replace", "text": "You are X."})
        self.assertEqual(wire["clientTools"], [{"name": "t1", "inputSchema": {"type": "object"},
                                                "description": "d", "timeoutMs": 5000}])
        self.assertEqual(wire["tenant"], {"tenantId": "acme", "userId": "u1"})
        self.assertTrue(wire["requireTerminalTool"])
        self.assertNotIn("handler", json.dumps(wire))

    def test_empty_spec_is_empty(self):
        self.assertEqual(spec_to_wire(AgentSpec()), {})


class SessionTest(unittest.TestCase):
    def test_create_serves_client_tools_and_run_parses_output(self):
        async def scenario():
            state = {"replies": [], "created": None}

            def create(params, send):
                state["created"] = params
                return {"success": True, "sessionId": "s1"}

            def subscribe(params, send):
                state["subscribe"] = params

                async def fire():
                    await asyncio.sleep(0.05)
                    for call_id, q in (("c1", "noodles"), ("c2", "boom")):
                        send({"method": "__hooks.call", "params": {
                            "callId": call_id, "subscriptionId": "hs-1", "hook_event_name": "ClientTool",
                            "session_id": "s1", "matcher": "search",
                            "payload": {"tool_name": "search", "tool_input": {"q": q},
                                        "tenant": {"tenantId": "acme", "userId": "u1"}}}})
                asyncio.ensure_future(fire())
                return {"subscriptionId": "hs-1"}

            def reply(params, send):
                state["replies"].append(params)
                return {"ok": True}

            def send_message(params, send):
                send({"method": "local-session-event", "params": {
                    "channel": "local-session:message-appended",
                    "payload": {"sessionId": "s1", "message": {"id": "m1", "role": "assistant", "text": json.dumps(
                        {"content": {"type": "acp", "data": {"type": "message", "message": "{\"answer\": 42}"}}})}}}})
                return {"success": True}

            host = await FakeHost({
                "__rpc.hello": lambda p, s: {"capabilities": ["hooks-subscribe-v1", "sdk-session-spec-v1"]},
                "create-thread": create, "__hooks.subscribe": subscribe, "__hooks.reply": reply,
                "send-thread-message": send_message,
                "s1:abort": lambda p, s: {"status": "ok"},
            }).start()
            try:
                client = await CtenoSession.open(host.path)

                async def search(args, ctx):
                    if args["q"] == "boom":
                        raise RuntimeError("upstream down")
                    return {"hits": [args["q"], ctx.tenant.user_id]}

                sid = await client.create(model="m", reasoning_effort="high", spec=AgentSpec(
                    system_prompt="guide", client_tools=[ClientTool("search", handler=search)],
                    tenant=TenantRef("acme", "u1")))
                self.assertEqual(sid, "s1")
                self.assertEqual(state["created"]["modelId"], "m")
                self.assertEqual(state["created"]["reasoningEffort"], "high")
                self.assertEqual(state["subscribe"]["events"], [{"event": "ClientTool", "matcher": "search"}])
                self.assertEqual(state["subscribe"]["sessions"], ["s1"])
                for _ in range(50):
                    if len(state["replies"]) >= 2:
                        break
                    await asyncio.sleep(0.02)
                by_id = {r["callId"]: r["outcome"] for r in state["replies"]}
                self.assertEqual(by_id["c1"], {"updatedOutput": {"hits": ["noodles", "u1"]}})
                self.assertEqual(by_id["c2"], {"continue": False, "reason": "upstream down"})
                result = await client.run("s1", "q")
                self.assertTrue(result.ok)
                self.assertEqual(result.output, {"answer": 42})
                await client.abort("s1")
                client.close()
            finally:
                await host.close()
        run(scenario())

    def test_invalid_spec_surfaces_remote_error(self):
        async def scenario():
            host = await FakeHost({"create-thread": lambda p, s: {
                "success": False, "errorKind": "invalid_sdk_spec", "error": "unknown sdk spec field 'x'"}}).start()
            try:
                client = await CtenoSession.open(host.path)
                with self.assertRaises(SdkError) as raised:
                    await client.create(spec=AgentSpec(system_prompt="x"))
                self.assertEqual(raised.exception.code, "REMOTE")
                self.assertIn("unknown sdk spec field", str(raised.exception))
                client.close()
            finally:
                await host.close()
        run(scenario())


if __name__ == "__main__":
    unittest.main()
