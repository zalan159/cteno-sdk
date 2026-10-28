#!/usr/bin/env python3
# OpenAI-compatible mock: /v1/models, /v1/chat/completions and /v1/responses.
# Reply text: env MOCK_TEXT (default "hello from Cteno"). If the request
# offers a tool named in MOCK_CALL_TOOL and no tool result is present yet,
# the first reply is a tool call (to exercise the permission path). Only for
# prompts containing PROBE_TOOL.
import json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TEXT = os.environ.get("MOCK_TEXT", "hello from Cteno")
CALL = os.environ.get("MOCK_CALL_TOOL", "")
LOG = os.environ.get("MOCK_LOG", os.path.join(__import__("tempfile").gettempdir(), "mock-llm.log"))
# The probe command must create sdk-probe.txt in the session cwd with the
# platform's shell (PowerShell on Windows).
PROBE_CMD = os.environ.get("MOCK_PROBE_CMD", "touch sdk-probe.txt")


def has_tool_result(req):
    blob = json.dumps(req)
    return '"function_call_output"' in blob or '"role": "tool"' in blob or '"tool_result"' in blob


def tool_names(req):
    names = []
    for t in req.get("tools") or []:
        names.append(t.get("name") or (t.get("function") or {}).get("name"))
    return names


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        self._json({"object": "list", "data": [{"id": "mock-model", "object": "model"}]})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        # Only prompts carrying PROBE_TOOL get a tool call, so ordinary turns stay plain.
        wants = "PROBE_TOOL" in json.dumps(req)
        call = CALL if wants and CALL and CALL in tool_names(req) and not has_tool_result(req) else ""
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "stream": bool(req.get("stream")), "call": call, "probe": wants, "ntools": len(tool_names(req)),
                                "outputs": [str(i.get("output"))[:400] for i in (req.get("input") or []) if isinstance(i, dict) and i.get("type") == "function_call_output"]
                                + [str(m.get("content"))[:400] for m in (req.get("messages") or []) if isinstance(m, dict) and m.get("role") == "tool"]}) + "\n")
        if self.path.endswith("/responses"):
            return self.handle_responses(req, call)
        return self.chat(req, call)

    def sse(self, events):
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        for name, obj in events:
            if name:
                self.wfile.write(("event: %s\n" % name).encode())
            self.wfile.write(("data: %s\n\n" % json.dumps(obj)).encode()); self.wfile.flush()

    def handle_responses(self, req, call):
        rid = "resp_%d" % int(time.time() * 1000)
        usage = {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13}
        if call:
            item = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": call,
                    "arguments": json.dumps({"command": PROBE_CMD, "timeout": 30}), "status": "completed"}
        else:
            item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": TEXT, "annotations": []}]}
        done = {"id": rid, "object": "response", "status": "completed", "model": "mock-model", "output": [item], "usage": usage}
        if not req.get("stream"):
            return self._json(done)
        ev = [("response.created", {"type": "response.created", "response": dict(done, status="in_progress", output=[])}),
              ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": dict(item, **({"arguments": ""} if call else {"content": []}))})]
        if call:
            ev.append(("response.function_call_arguments.delta", {"type": "response.function_call_arguments.delta", "output_index": 0, "item_id": "fc_1", "delta": item["arguments"]}))
            ev.append(("response.function_call_arguments.done", {"type": "response.function_call_arguments.done", "output_index": 0, "item_id": "fc_1", "arguments": item["arguments"]}))
        else:
            ev.append(("response.output_text.delta", {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg_1", "delta": TEXT}))
            ev.append(("response.output_text.done", {"type": "response.output_text.done", "output_index": 0, "content_index": 0, "item_id": "msg_1", "text": TEXT}))
        ev.append(("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}))
        ev.append(("response.completed", {"type": "response.completed", "response": done}))
        self.sse(ev)

    def chat(self, req, call):
        base = {"id": "c1", "object": "chat.completion.chunk", "created": int(time.time()), "model": "mock-model"}
        usage = {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}
        if call:
            tc = [{"index": 0, "id": "call_1", "type": "function", "function": {"name": call, "arguments": json.dumps({"command": PROBE_CMD, "timeout": 30})}}]
            msg, finish = {"role": "assistant", "content": None, "tool_calls": tc}, "tool_calls"
        else:
            msg, finish = {"role": "assistant", "content": TEXT}, "stop"
        if not req.get("stream"):
            return self._json({"id": "c1", "object": "chat.completion", "created": base["created"], "model": "mock-model",
                               "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage})
        self.sse([(None, dict(base, choices=[{"index": 0, "delta": msg, "finish_reason": None}])),
                  (None, dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": finish}], usage=usage))])
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()


ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("MOCK_PORT", "18999"))), H).serve_forever()
