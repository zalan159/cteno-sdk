"""Owner-socket client: newline-delimited JSON envelopes over a Unix socket.

Wire (identical to the Node SDK):
  request      {"requestId", "method", "params"}       -> {"requestId", "result" | "error"}
  notification {"method", "params"}                    (daemon -> client)
Business methods are scoped by machine id (``<machineId>:create-thread``);
session methods by session id (``<sessionId>:abort``); ``__rpc.*`` /
``__hooks.*`` are connection-level.

Standard library only (asyncio), Python >= 3.9.
"""
from __future__ import annotations

import asyncio
import inspect
import itertools
import json
import os
import re
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Union

AGENT_SPEC_CAPABILITY = "sdk-session-spec-v1"
HOOKS_SUBSCRIBE_CAPABILITY = "hooks-subscribe-v1"
MAX_FRAME_BYTES = 8 * 1024 * 1024


class SdkError(Exception):
    """``code`` is one of TRANSPORT, PROTOCOL, REMOTE, TIMEOUT, CLOSED, QUOTA."""

    def __init__(self, code: str, message: str, detail: Any = None):
        super().__init__(message)
        self.code = code
        self.detail = detail


# --------------------------------------------------------------------------
# Spec
# --------------------------------------------------------------------------

@dataclass
class TenantRef:
    tenant_id: str
    user_id: str


@dataclass
class ClientToolContext:
    session_id: str
    tool_name: str
    tool_use_id: Optional[str] = None
    metadata: Any = None
    tenant: Optional[TenantRef] = None


ClientToolHandler = Callable[[Dict[str, Any], ClientToolContext], Union[Any, Awaitable[Any]]]


@dataclass
class ClientTool:
    """A tool the model calls that runs in THIS process."""
    name: str
    description: str = ""
    input_schema: Dict[str, Any] = field(default_factory=lambda: {"type": "object", "properties": {}})
    handler: Optional[ClientToolHandler] = None
    timeout_ms: Optional[int] = None


@dataclass
class AgentSpec:
    """Per-session configuration; mirrors the Node ``AgentSpec``.

    ``system_prompt``: a string replaces Cteno's base prompt (a short safety
    floor is kept); ``{"mode": "append", "text": ...}`` appends instead.
    ``tools``: ``{"allow": [...], "deny": [...]}`` (exact or ``prefix*``).
    ``limits``: ``{"maxIterations", "maxToolCalls", "turnTimeoutMs", "maxOutputTokens"}``.
    ``history``: ``[{"role": "user"|"assistant", "text": ...}]``.
    """
    system_prompt: Union[str, Dict[str, str], None] = None
    context: Optional[Dict[str, Any]] = None
    tools: Optional[Dict[str, List[str]]] = None
    client_tools: List[ClientTool] = field(default_factory=list)
    terminal_tools: List[str] = field(default_factory=list)
    require_terminal_tool: bool = False
    limits: Optional[Dict[str, int]] = None
    output_schema: Optional[Dict[str, Any]] = None
    history: List[Dict[str, str]] = field(default_factory=list)
    tenant: Optional[TenantRef] = None
    metadata: Any = None


def spec_to_wire(spec: AgentSpec) -> Dict[str, Any]:
    wire: Dict[str, Any] = {}
    if spec.system_prompt is not None:
        wire["systemPrompt"] = ({"mode": "replace", "text": spec.system_prompt}
                                if isinstance(spec.system_prompt, str) else dict(spec.system_prompt))
    if spec.context:
        wire["context"] = spec.context
    if spec.tools:
        wire["tools"] = spec.tools
    if spec.client_tools:
        tools = []
        for tool in spec.client_tools:
            out: Dict[str, Any] = {"name": tool.name, "inputSchema": tool.input_schema}
            if tool.description:
                out["description"] = tool.description
            if tool.timeout_ms:
                out["timeoutMs"] = tool.timeout_ms
            tools.append(out)
        wire["clientTools"] = tools
    if spec.terminal_tools:
        wire["terminalTools"] = list(spec.terminal_tools)
    if spec.require_terminal_tool:
        wire["requireTerminalTool"] = True
    if spec.limits:
        wire["limits"] = spec.limits
    if spec.output_schema:
        wire["outputSchema"] = spec.output_schema
    if spec.history:
        wire["history"] = list(spec.history)
    if spec.tenant:
        wire["tenant"] = {"tenantId": spec.tenant.tenant_id, "userId": spec.tenant.user_id}
    if spec.metadata is not None:
        wire["metadata"] = spec.metadata
    return wire


@dataclass
class RunResult:
    ok: bool
    text: str
    output: Any = None
    error: Optional[str] = None
    error_kind: Optional[str] = None
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    messages: List[Dict[str, Any]] = field(default_factory=list)


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------

def _app_data_parents() -> List[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        return [home / "Library" / "Application Support"]
    xdg = os.environ.get("XDG_DATA_HOME")
    return [Path(xdg) if xdg else home / ".local" / "share", home / ".agents"]


# ``host.sock`` or ``host.<tag>.sock``: ``dev``, ``host`` (headless
# ``cteno-host-cli serve``), ``dev-<edition>``, ``<edition>``. The public
# listener ``host.sock.public`` never matches.
_OWNER_SOCKET = re.compile(r"^host(?:\.([A-Za-z0-9_-]+))?\.sock$")


def _is_dev_socket(path: Path) -> bool:
    match = _OWNER_SOCKET.match(path.name)
    tag = (match.group(1) or "") if match else ""
    return tag == "dev" or tag.startswith("dev-")


def _sockets_under(root: Path) -> List[Path]:
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    found = []
    for name in names:
        if not _OWNER_SOCKET.match(name):
            continue
        path = root / name
        try:
            if stat.S_ISSOCK(path.stat().st_mode):
                found.append(path)
        except OSError:
            pass
    return found


def discover_owner_sockets() -> List[Path]:
    """Candidate owner sockets, dev first. ``CTENO_HOST_ROOT`` wins."""
    explicit = os.environ.get("CTENO_HOST_ROOT")
    if explicit:
        return _sockets_under(Path(explicit))
    found: List[Path] = []
    for parent in _app_data_parents():
        try:
            entries = sorted(os.listdir(parent))
        except OSError:
            continue
        for entry in entries:
            if entry.startswith("."):
                found.extend(_sockets_under(parent / entry))
    return sorted(found, key=lambda p: 0 if _is_dev_socket(p) else 1)


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------

class _Transport:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self._reader, self._writer = reader, writer
        self._pending: Dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._listeners: List[Callable[[str, Any], None]] = []
        self._closed = False
        self._task = asyncio.ensure_future(self._pump())

    async def request(self, method: str, params: Any = None, timeout: Optional[float] = 30.0) -> Any:
        if self._closed:
            raise SdkError("CLOSED", "transport closed")
        request_id = "py-%d" % next(self._ids)
        line = json.dumps({"requestId": request_id, "method": method, "params": params or {}},
                          ensure_ascii=False) + "\n"
        data = line.encode()
        if len(data) > MAX_FRAME_BYTES:
            raise SdkError("TRANSPORT", "outbound frame exceeds limit")
        future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future
        try:
            self._writer.write(data)
            await self._writer.drain()
            return await asyncio.wait_for(future, timeout) if timeout else await future
        except asyncio.TimeoutError:
            raise SdkError("TIMEOUT", "local wait timed out for %s; host execution may continue" % method)
        finally:
            self._pending.pop(request_id, None)

    def on_notification(self, listener: Callable[[str, Any], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener) if listener in self._listeners else None

    async def _pump(self) -> None:
        error: Optional[Exception] = None
        try:
            while True:
                line = await self._reader.readline()
                if not line:
                    break
                if len(line) > MAX_FRAME_BYTES:
                    raise SdkError("PROTOCOL", "inbound frame exceeds limit")
                if not line.strip():
                    continue
                message = json.loads(line)
                if not isinstance(message, dict):
                    continue
                request_id = message.get("requestId")
                if isinstance(request_id, str):
                    future = self._pending.get(request_id)
                    if future and not future.done():
                        if message.get("error") is not None:
                            future.set_exception(SdkError("REMOTE", str(message["error"]), message["error"]))
                        else:
                            future.set_result(message.get("result"))
                elif isinstance(message.get("method"), str):
                    for listener in list(self._listeners):
                        try:
                            listener(message["method"], message.get("params"))
                        except Exception:  # listener owns its errors
                            pass
        except (asyncio.CancelledError, Exception) as exc:  # noqa: BLE001
            error = exc if isinstance(exc, Exception) else None
        finally:
            self._closed = True
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(SdkError("CLOSED", "transport closed", error))

    def close(self) -> None:
        self._closed = True
        self._task.cancel()
        try:
            self._writer.close()
        except Exception:
            pass


async def _open_endpoint(endpoint: str, timeout: float) -> "_Transport":
    """Connect to a Unix socket path, or a Windows named pipe (``\\\\.\\pipe\\...``)."""
    if sys.platform == "win32" or endpoint.startswith("\\\\.\\pipe\\"):
        loop = asyncio.get_event_loop()
        if not hasattr(loop, "create_pipe_connection"):
            raise SdkError("TRANSPORT", "named pipes need the Windows proactor event loop")
        reader = asyncio.StreamReader(limit=MAX_FRAME_BYTES)
        protocol = asyncio.StreamReaderProtocol(reader)
        transport, _ = await asyncio.wait_for(
            loop.create_pipe_connection(lambda: protocol, endpoint), timeout)  # type: ignore[attr-defined]
        writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    else:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(endpoint, limit=MAX_FRAME_BYTES), timeout)
    return _Transport(reader, writer)


NO_APPROVER_REASON = (
    "No approver is attached to this SDK session, so tools that need approval are denied. "
    "The developer can allow them with permission_mode or a can_use_tool callback.")


def _envelope_data(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        envelope = json.loads(entry.get("text") or "")
    except (ValueError, TypeError):
        return None
    content = envelope.get("content") if _obj(envelope) else None
    data = content.get("data") if _obj(content) else None
    return data if _obj(data) else None


def permission_request_of(entry: Dict[str, Any], session_id: str,
                          calls: Optional[Dict[str, Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """An approval request carried by a stored message row, or None.

    Two daemon shapes: a parked call (a ``tool-result`` whose output is
    ``{permissionPending: true, cardId}``, answered with ``card-answer``) and
    the older in-turn ``permission-request`` frame (answered on
    ``<session>:permission``). ``calls`` remembers tool-call frames so a parked
    result can name its tool.
    """
    data = _envelope_data(entry)
    if data is None:
        return None
    if calls is None:
        calls = {}
    if data.get("type") == "tool-call" and isinstance(data.get("callId"), str):
        calls[data["callId"]] = {"name": str(data.get("name") or ""), "input": data.get("input")}
        return None
    if data.get("type") == "tool-result" and isinstance(data.get("output"), str):
        try:
            output = json.loads(data["output"])
        except (ValueError, TypeError):
            return None
        if not _obj(output) or output.get("permissionPending") is not True or not isinstance(output.get("cardId"), str):
            return None
        call = calls.get(data.get("callId")) or {}
        return {"session_id": session_id, "id": output["cardId"], "tool_name": call.get("name", ""),
                "input": call.get("input"), "description": None, "via": "card"}
    if data.get("type") != "permission-request" or not data.get("permissionId"):
        return None
    return {"session_id": session_id, "id": str(data["permissionId"]), "tool_name": str(data.get("toolName") or ""),
            "input": data.get("options"), "description": data.get("description"), "via": "session"}


def resumed_card_of(entry: Dict[str, Any]) -> Optional[str]:
    """Card id whose resumed (post-answer) turn this row completes, if any."""
    data = _envelope_data(entry)
    if data is None or data.get("type") != "task_complete":
        return None
    ident = data.get("id")
    if isinstance(ident, str) and ident.startswith("confirmation:"):
        return ident[len("confirmation:"):]
    return None


# --------------------------------------------------------------------------
# Session client
# --------------------------------------------------------------------------

def _obj(value: Any) -> bool:
    return isinstance(value, dict)


def _decode_message(entry: Dict[str, Any], session_id: str) -> Optional[Dict[str, Any]]:
    role, raw = entry.get("role"), entry.get("text") if isinstance(entry.get("text"), str) else ""
    data: Any = None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        pass
    text = raw
    kind = None
    if _obj(data):
        content = data.get("content")
        if isinstance(content, str):
            text = content
        elif _obj(content):
            inner = content.get("data")
            if isinstance(content.get("text"), str):
                text = content["text"]
            elif _obj(inner) and isinstance(inner.get("message"), str):
                text = inner["message"]
            if _obj(inner) and isinstance(inner.get("type"), str):
                kind = inner["type"]
            elif isinstance(content.get("type"), str) and content["type"] != "acp":
                kind = content["type"]
        elif isinstance(data.get("text"), str):
            text = data["text"]
    if role == "user":
        return {"type": "user", "id": entry.get("id", ""), "sessionId": session_id, "text": text}
    if role == "assistant":
        return {"type": "assistant", "id": entry.get("id", ""), "sessionId": session_id,
                "text": text, "data": data, "kind": kind}
    return None


class CtenoSession:
    """A connected owner-RPC client (one socket connection)."""

    def __init__(self, transport: _Transport, machine_id: str, socket_path: str):
        self._t = transport
        self.machine_id = machine_id
        self.socket_path = socket_path
        self._subscribed = False
        self._capabilities: Optional[List[str]] = None
        self.daemon = None  # DaemonHandle when attached to the SDK's own daemon

    # -- lifecycle ---------------------------------------------------------
    @classmethod
    async def open(cls, socket_path: Optional[str] = None, timeout: float = 10.0,
                   home: Optional[str] = None, daemon_env: Optional[Dict[str, str]] = None) -> "CtenoSession":
        """Connect to the SDK's own daemon, starting it if needed.

        The SDK's daemon is separate from any Cteno desktop app: its own data,
        sockets, machine id and logs; local mode; no login. ``socket_path``
        connects to a different daemon instead and is the only way to do so.
        """
        from .daemon import ensure_daemon, DaemonError
        handle = None
        if socket_path:
            endpoint = socket_path
        else:
            try:
                handle = await ensure_daemon(home, env=daemon_env)
            except DaemonError as exc:
                raise SdkError("TRANSPORT", str(exc)) from exc
            endpoint = handle.layout.endpoint
        transport = None
        try:
            transport = await _open_endpoint(endpoint, timeout)
            machine_id = os.environ.get("CTENO_MACHINE_ID") if socket_path else None
            if not machine_id:
                info = await transport.request("list-local-rpc-methods", {}, timeout)
                machine_id = info.get("machineId") if _obj(info) else None
            if not machine_id:
                raise SdkError("PROTOCOL", "could not determine daemon machine id")
            session = cls(transport, machine_id, endpoint)
            session.daemon = handle
            return session
        except Exception as exc:  # noqa: BLE001
            if transport:
                transport.close()
            raise SdkError("TRANSPORT", "Could not reach a Cteno daemon at %s" % endpoint, exc) from exc

    async def configure_model(self, *, base_url: str, model: str, api_key: str, api_format: str = "openai",
                              id: str = "sdk-default", name: Optional[str] = None,
                              supports_vision: bool = False, max_tokens: int = 8192,
                              make_default: bool = True) -> str:
        """Add a BYOK model profile (stored in the SDK daemon's own data dir) and make it the default."""
        endpoint = {"base_url": base_url, "model": model, "api_key": api_key, "temperature": 0.7,
                    "max_tokens": max_tokens, "context_window_tokens": None}
        saved = await self.call("save-profile", {"profile": {
            "id": id, "name": name or model, "api_format": api_format, "chat": endpoint,
            "compress": dict(endpoint, temperature=0.3), "supports_vision": supports_vision}})
        if _obj(saved) and saved.get("success") is False:
            raise SdkError("REMOTE", str(saved.get("error") or "save-profile failed"), saved)
        if make_default:
            made = await self.call("set-default-profile", {"profileId": id})
            if _obj(made) and made.get("success") is False:
                raise SdkError("REMOTE", str(made.get("error") or "set-default-profile failed"), made)
        return id

    async def list_profiles(self) -> List[Dict[str, Any]]:
        result = await self.call("list-profiles", {})
        raw = result.get("profiles") if _obj(result) else result
        return [{"id": str(p.get("id", "")), "name": p.get("name"),
                 "model": (p.get("chat") or {}).get("model") if _obj(p.get("chat")) else None}
                for p in (raw if isinstance(raw, list) else []) if _obj(p)]

    async def __aenter__(self) -> "CtenoSession":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._t.close()

    # -- raw ----------------------------------------------------------------
    async def call(self, method: str, params: Any = None, timeout: Optional[float] = 30.0) -> Any:
        """Call a business method by its unscoped name (machine id added)."""
        if not method or ":" in method:
            raise ValueError("expected an unscoped method name")
        return await self._t.request("%s:%s" % (self.machine_id, method), params or {}, timeout)

    async def capabilities(self) -> List[str]:
        if self._capabilities is None:
            hello = await self._t.request("__rpc.hello", {})
            self._capabilities = list(hello.get("capabilities", [])) if _obj(hello) else []
        return self._capabilities

    # -- sessions -------------------------------------------------------------
    async def create(self, *, cwd: Optional[str] = None, model: Optional[str] = None,
                     title: Optional[str] = None, permission_mode: Optional[str] = None,
                     agent_type: Optional[str] = None, reasoning_effort: Optional[str] = None,
                     initial_goal: Optional[Dict[str, Any]] = None, mcp_servers: Optional[List[str]] = None,
                     spec: Optional[AgentSpec] = None, extra_params: Optional[Dict[str, Any]] = None,
                     timeout: float = 60.0) -> str:
        """Create a session; every create-thread parameter plus the agent spec.

        Client tools with a ``handler`` are served by THIS connection; keep it
        open while the session runs.
        """
        params: Dict[str, Any] = dict(extra_params or {})
        # The daemon resolves a relative path against ITS working directory,
        # so make it absolute here: cwd="." means the caller's directory.
        if cwd:
            cwd = os.path.abspath(os.path.expanduser(cwd))
        for key, value in (("workdir", cwd), ("modelId", model), ("title", title),
                           ("permissionMode", permission_mode), ("agent", agent_type),
                           ("reasoningEffort", reasoning_effort), ("initialGoal", initial_goal)):
            if value:
                params[key] = value
        if spec is not None:
            # An older daemon would ignore the spec (and reject client tools later
            # with an opaque error), so refuse before creating anything.
            if AGENT_SPEC_CAPABILITY not in await self.capabilities():
                raise SdkError("PROTOCOL", "This Cteno daemon does not support agent specs (%s); "
                               "upgrade Cteno to 2.10.10 or newer" % AGENT_SPEC_CAPABILITY)
            params["sdk"] = spec_to_wire(spec)
        result = await self.call("create-thread", params, timeout)
        if not _obj(result):
            raise SdkError("PROTOCOL", "create-thread returned a non-object", result)
        if result.get("success") is False:
            raise SdkError("REMOTE", str(result.get("error") or "create-thread failed"), result)
        session_id = result.get("sessionId") or result.get("threadId")
        if not isinstance(session_id, str) or not session_id:
            raise SdkError("PROTOCOL", "create-thread returned no session id", result)
        try:
            if mcp_servers is not None:
                await self._t.request("%s:set-session-mcp-servers" % session_id, {"serverIds": mcp_servers})
            handled = [t for t in (spec.client_tools if spec else []) if t.handler]
            if handled:
                await self.serve_client_tools(session_id, handled)
        except Exception:
            await self.close_session(session_id)
            raise
        return session_id

    async def serve_client_tools(self, session_id: str, tools: List[ClientTool]) -> Callable[[], Awaitable[None]]:
        """Answer ``ClientTool`` calls for ``session_id`` on this connection (fail-closed)."""
        if HOOKS_SUBSCRIBE_CAPABILITY not in await self.capabilities():
            raise SdkError("PROTOCOL", "daemon does not support hook subscriptions")
        handlers = {t.name: t.handler for t in tools if t.handler}
        subscription = {"id": ""}
        early: List[Dict[str, Any]] = []

        async def answer(call: Dict[str, Any]) -> None:
            payload = call.get("payload") or {}
            name = str(payload.get("tool_name") or call.get("matcher") or "")
            handler = handlers.get(name)
            if handler is None:
                outcome: Dict[str, Any] = {"continue": False, "reason": "no handler for client tool %s" % name}
            else:
                tenant = payload.get("tenant")
                ctx = ClientToolContext(
                    session_id=str(call.get("session_id") or session_id), tool_name=name,
                    tool_use_id=payload.get("tool_use_id"), metadata=payload.get("metadata"),
                    tenant=TenantRef(tenant["tenantId"], tenant["userId"]) if _obj(tenant) else None)
                try:
                    value = handler(dict(payload.get("tool_input") or {}), ctx)
                    if inspect.isawaitable(value):
                        value = await value
                    # None is a valid "nothing to report", not a missing reply.
                    outcome = {"updatedOutput": "" if value is None else value}
                except Exception as exc:  # noqa: BLE001 — the model sees the failure
                    outcome = {"continue": False, "reason": str(exc) or type(exc).__name__}
            try:
                await self._t.request("__hooks.reply", {"callId": call.get("callId"), "outcome": outcome})
            except SdkError:
                pass  # call expired or connection closed
            except Exception as exc:  # noqa: BLE001 — e.g. a result that is not JSON-encodable
                # Never leave the daemon waiting: answer with a failure instead.
                try:
                    await self._t.request("__hooks.reply", {"callId": call.get("callId"), "outcome": {
                        "continue": False, "reason": "client tool %s returned an unencodable result: %s" % (name, exc)}})
                except Exception:  # noqa: BLE001 — connection gone; the daemon times out fail-closed
                    pass

        def listener(method: str, params: Any) -> None:
            if method != "__hooks.call" or not _obj(params):
                return
            if not subscription["id"]:
                early.append(params)
            elif params.get("subscriptionId") == subscription["id"]:
                asyncio.ensure_future(answer(params))

        off = self._t.on_notification(listener)
        try:
            result = await self._t.request("__hooks.subscribe", {
                "events": [{"event": "ClientTool", "matcher": "|".join(handlers)}],
                "sessions": [session_id],
            })
        except Exception:
            off()
            raise
        if not _obj(result) or not isinstance(result.get("subscriptionId"), str):
            off()
            raise SdkError("PROTOCOL", "__hooks.subscribe returned no subscriptionId", result)
        subscription["id"] = result["subscriptionId"]
        for call in early:
            if call.get("subscriptionId") == subscription["id"]:
                asyncio.ensure_future(answer(call))

        async def unsubscribe() -> None:
            off()
            try:
                await self._t.request("__hooks.unsubscribe", {"subscriptionId": subscription["id"]})
            except SdkError:
                pass
        return unsubscribe

    async def run(self, session_id: str, prompt: str, timeout: float = 600.0,
                  can_use_tool: Optional[Callable[[Dict[str, Any]], Any]] = None) -> RunResult:
        """Send one prompt and wait for the turn; collect text / structured output / tool calls.

        Tools that need approval are decided by ``can_use_tool(request)``
        (return True/False or ``{"allow": bool, "reason": str}``, may be async);
        without it they are denied at once. Nothing waits for a human.
        """
        messages: List[Dict[str, Any]] = []
        answered: set = set()
        calls: Dict[str, Dict[str, Any]] = {}
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        # A parked call ends the daemon turn; the host only resumes it once the
        # session is idle, so card answers wait for the turn reply. `pending`
        # holds answered cards whose resumed turn has not completed yet.
        parked: List[Dict[str, Any]] = []
        pending: set = set()
        changed = asyncio.Event()

        async def decide(request: Dict[str, Any]) -> tuple:
            if can_use_tool is None:
                return False, NO_APPROVER_REASON
            try:
                verdict = can_use_tool(request)
                if inspect.isawaitable(verdict):
                    verdict = await verdict
                if isinstance(verdict, dict):
                    return bool(verdict.get("allow")), str(verdict.get("reason") or "Denied by the SDK client")
                return bool(verdict), "Denied by the SDK client"
            except Exception as exc:  # noqa: BLE001
                return False, "can_use_tool raised: %s" % exc

        async def approve(request: Dict[str, Any]) -> None:
            allow, reason = await decide(request)
            params = ({"id": request["id"], "approved": True} if allow else
                      {"id": request["id"], "approved": False, "decision": "denied", "reason": reason})
            try:
                await self._t.request("%s:permission" % session_id, params)
            except SdkError:
                pass

        async def answer_card(request: Dict[str, Any]) -> None:
            allow, reason = await decide(request)
            params: Dict[str, Any] = {"cardId": request["id"], "choiceIds": ["allow_once" if allow else "deny"], "actor": "sdk"}
            if not allow:
                params["note"] = reason
            pending.add(request["id"])
            try:
                await self.call("card-answer", params)
            except SdkError:
                pending.discard(request["id"])
                changed.set()

        def listener(method: str, params: Any) -> None:
            if method != "local-session-event" or not _obj(params):
                return
            payload = params.get("payload")
            if (params.get("channel") == "local-session:message-appended" and _obj(payload)
                    and payload.get("sessionId") == session_id and _obj(payload.get("message"))):
                card = resumed_card_of(payload["message"])
                if card and card in pending:
                    pending.discard(card)
                    changed.set()
                request = permission_request_of(payload["message"], session_id, calls)
                if request and request["id"] not in answered:
                    answered.add(request["id"])
                    if request["via"] == "card":
                        parked.append(request)
                        changed.set()
                    else:
                        asyncio.ensure_future(approve(request))
                decoded = _decode_message(payload["message"], session_id)
                if decoded:
                    messages.append(decoded)

        off = self._t.on_notification(listener)
        try:
            if not self._subscribed:
                await self._t.request("__rpc.subscribe", {})
                self._subscribed = True
            reply = await self.call("send-thread-message",
                                    {"sessionId": session_id, "message": prompt, "wait": True}, timeout)
            failed = _obj(reply) and reply.get("success") is False
            while not failed and (parked or pending):
                while parked:
                    await answer_card(parked.pop(0))
                if not pending:
                    continue
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise SdkError("TIMEOUT", "Turn did not finish after a tool approval; host execution may continue")
                changed.clear()
                try:
                    await asyncio.wait_for(changed.wait(), min(remaining, 0.5))
                except asyncio.TimeoutError:
                    pass
        finally:
            off()
        ok = not (_obj(reply) and reply.get("success") is False)
        error = str(reply.get("error")) if _obj(reply) and reply.get("error") else None
        error_kind = reply.get("errorKind") if _obj(reply) else None

        def is_answer(m: Dict[str, Any]) -> bool:
            return m["type"] == "assistant" and m.get("kind") in (None, "message")

        answers = [m for m in messages if is_answer(m)]
        if not answers and ok:
            history = await self.history(session_id, limit=20)
            users = [i for i, m in enumerate(history) if m["type"] == "user"]
            answers = [m for m in history[(users[-1] + 1 if users else 0):] if is_answer(m)]
        text = answers[-1]["text"] if answers else ""
        try:
            output = json.loads(text)
        except (ValueError, TypeError):
            output = None
        tool_calls = []
        for m in messages:
            if m["type"] == "assistant" and m.get("kind") == "tool-call":
                inner = m["data"]["content"]["data"]
                tool_calls.append({"name": inner.get("name"), "callId": inner.get("callId"), "input": inner.get("input")})
        return RunResult(ok=ok, text=text, output=output, error=error, error_kind=error_kind,
                         tool_calls=tool_calls, messages=messages)

    async def abort(self, session_id: str) -> None:
        """Interrupt the running turn (recorded as aborted)."""
        await self._t.request("%s:abort" % session_id, {})

    async def history(self, session_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        result = await self.call("get-session-messages", {"sessionId": session_id, "limit": limit})
        raw = result.get("messages") if _obj(result) else result
        out = []
        for entry in raw if isinstance(raw, list) else []:
            if _obj(entry):
                decoded = _decode_message(entry, session_id)
                if decoded:
                    out.append(decoded)
        return out

    async def close_session(self, session_id: str) -> None:
        try:
            await self.call("close-session", {"sessionId": session_id})
        except SdkError:
            pass

    # -- tenancy --------------------------------------------------------------
    async def tenant_policy(self, tenant_id: str, policy: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {"tenantId": tenant_id}
        if policy is not None:
            params["policy"] = policy
        result = await self.call("sdk-tenant-policy", params)
        return result.get("policy", {}) if _obj(result) else {}

    async def tenant_status(self, tenant_id: str) -> Dict[str, Any]:
        result = await self.call("sdk-tenant-status", {"tenantId": tenant_id})
        return result if _obj(result) else {}
