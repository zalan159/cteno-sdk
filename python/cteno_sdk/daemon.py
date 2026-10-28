"""The SDK's own daemon (mirror of ``@cteno/sdk``'s ``daemon.ts``).

``pip install cteno-sdk`` installs a platform wheel that carries a headless
``cteno-host-cli`` under ``cteno_sdk/_bin``. :func:`ensure_daemon` attaches to
the instance this user already started, or starts one.

The instance is isolated from an installed Cteno desktop app: data, sockets,
logs, home data and vault all live under one instance root that the daemon
receives as ``CTENO_ISOLATED_ROOT``; it runs in local mode and never logs in.
Nothing here scans for, or connects to, the app's daemon.
"""
from __future__ import annotations

import asyncio
import json
import os
import platform
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

ENV_TAG = "host"

# Daemons this process spawned. A daemon that exits stays a zombie (its pid
# still "exists") until we reap it, so poll these before probing a lock pid.
_SPAWNED: list = []


def _reap_spawned() -> None:
    for proc in list(_SPAWNED):
        if proc.poll() is not None:
            _SPAWNED.remove(proc)


class DaemonError(Exception):
    pass


def _package_dir() -> Path:
    return Path(__file__).resolve().parent


@dataclass
class DaemonBinary:
    path: Path
    bin_dir: Path
    resource_dir: Path
    version: Optional[str]
    source: str  # "env" | "wheel"


def resolve_daemon_binary() -> DaemonBinary:
    """``CTENO_SDK_DAEMON_PATH`` wins; otherwise the binary inside this wheel."""
    exe = "cteno-host-cli.exe" if sys.platform == "win32" else "cteno-host-cli"
    explicit = os.environ.get("CTENO_SDK_DAEMON_PATH")
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise DaemonError("CTENO_SDK_DAEMON_PATH points at a missing file: %s" % explicit)
        root = path.parent.parent if (path.parent.parent / "skills").is_dir() else path.parent
        return DaemonBinary(path, path.parent, root, None, "env")
    root = _package_dir() / "_bin"
    path = root / "bin" / exe
    if not path.exists():
        raise DaemonError(
            "This cteno-sdk install has no bundled daemon for %s-%s (a pure-Python sdist or an "
            "unsupported platform). Install a platform wheel (pip install --only-binary=:all: "
            "cteno-sdk), set CTENO_SDK_DAEMON_PATH, or pass socket_path to use a daemon you run "
            "yourself." % (sys.platform, platform.machine()))
    version = None
    try:
        version = json.loads((root / "manifest.json").read_text()).get("version")
    except (OSError, ValueError):
        pass
    return DaemonBinary(path, path.parent, root, version, "wheel")


def default_instance_root() -> Path:
    if os.environ.get("CTENO_SDK_HOME"):
        return Path(os.environ["CTENO_SDK_HOME"])
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "cteno-sdk"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local") / "cteno-sdk"
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "cteno-sdk"


def isolated_pipe_name(root: str, env_tag: str = "") -> str:
    """FNV-1a 64 of the root string; mirrors the daemon and the Node SDK."""
    h = 0xCBF29CE484222325
    for byte in root.encode("utf-8"):
        h ^= byte
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    name = r"\\.\pipe\cteno-sdk-%016x" % h
    return name + ("-" + env_tag if env_tag else "")


@dataclass
class InstanceLayout:
    root: Path
    data_dir: Path
    host_root: Path
    log_file: Path
    endpoint: str


def instance_layout(root: Optional[os.PathLike] = None) -> InstanceLayout:
    r = Path(root) if root else default_instance_root()
    host_root = r / "run"
    endpoint = (isolated_pipe_name(str(r), ENV_TAG) if sys.platform == "win32"
                else str(host_root / ("host.%s.sock" % ENV_TAG)))
    return InstanceLayout(r, r / "data", host_root, r / "logs" / "daemon.log", endpoint)


def daemon_environment(layout: InstanceLayout, binary: DaemonBinary,
                       base: Optional[Dict[str, str]] = None,
                       extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Environment for the bundled daemon: nothing inherited from a Cteno app."""
    env = {}
    for key, value in (os.environ if base is None else base).items():
        upper = key.upper()
        if upper.startswith("CTENO_") or upper.startswith("EXPO_PUBLIC_CTENO_"):
            continue
        if upper in ("SECRET_VAULT_DIR", "FNOX_AGE_KEY", "FNOX_AGE_KEY_FILE"):
            continue
        env[key] = value
    path_key = next((k for k in env if k.upper() == "PATH"), "PATH")
    env[path_key] = os.pathsep.join(p for p in (str(binary.bin_dir), env.get(path_key, "")) if p)
    res = binary.resource_dir
    env.update({
        "CTENO_ISOLATED_ROOT": str(layout.root),
        "CTENO_APP_DATA_DIR": str(layout.data_dir),
        "CTENO_HOST_ROOT": str(layout.host_root),
        "CTENO_ENV": ENV_TAG,
        "CTENO_DAEMON_LOG": str(layout.log_file),
        "CTENO_BUILTIN_TOOLS_DIR": str(res / "tools"),
        "CTENO_BUILTIN_SKILLS_DIR": str(res / "skills"),
        "CTENO_BUILTIN_AGENTS_DIR": str(res / "agents"),
        "CTENO_BUILTIN_PLUGINS_DIR": str(res / "plugins"),
        "CTENO_SDK_MANAGED": "1",
    })
    env.update(extra or {})
    return env


_NOT_RUNNING = object()


async def _probe(endpoint: str, timeout: float = 1.5):
    """Running daemon's ``daemon_version`` (None if unknown), or ``_NOT_RUNNING``."""
    from .client import _open_endpoint  # local import: avoid a cycle
    try:
        transport = await _open_endpoint(endpoint, timeout)
    except Exception:  # noqa: BLE001
        return _NOT_RUNNING
    try:
        await transport.request("list-local-rpc-methods", {}, timeout)
        try:
            hello = await transport.request("__rpc.hello", {}, timeout)
            version = hello.get("daemon_version") if isinstance(hello, dict) else None
            return version if isinstance(version, str) else None
        except Exception:  # noqa: BLE001 — very old daemon: no version
            return None
    except Exception:  # noqa: BLE001
        return _NOT_RUNNING
    finally:
        transport.close()


async def _answers(endpoint: str, timeout: float = 1.5) -> bool:
    return (await _probe(endpoint, timeout)) is not _NOT_RUNNING


def compare_versions(a: str, b: str) -> int:
    """Numeric dotted-version compare (``2.10.10`` > ``2.9.28``); suffixes ignored."""
    def parts(v: str):
        out = []
        for n in v.split("-")[0].split("."):
            try:
                out.append(int(n))
            except ValueError:
                out.append(0)
        return out
    x, y = parts(a), parts(b)
    for i in range(max(len(x), len(y))):
        d = (x[i] if i < len(x) else 0) - (y[i] if i < len(y) else 0)
        if d:
            return -1 if d < 0 else 1
    return 0


def needs_upgrade(running: Optional[str], bundled: Optional[str]) -> bool:
    """Replace a running daemon only when it is strictly older than the bundled one."""
    if not bundled:
        return False
    if not running:
        return True
    return compare_versions(running, bundled) < 0


@dataclass
class DaemonHandle:
    layout: InstanceLayout
    binary: Optional[DaemonBinary]
    started: bool
    pid: Optional[int]
    version: Optional[str] = None


def _tail(path: Path, size: int = 2000) -> str:
    try:
        return path.read_text(errors="replace")[-size:] or "(log empty)"
    except OSError:
        return "(no log)"


async def ensure_daemon(home: Optional[os.PathLike] = None, start_timeout: float = 60.0,
                        env: Optional[Dict[str, str]] = None) -> DaemonHandle:
    """Attach to the SDK's daemon for ``home``, starting it if needed."""
    layout = instance_layout(home)
    running = await _probe(layout.endpoint)
    binary: Optional[DaemonBinary] = None
    if running is not _NOT_RUNNING:
        # Upgrade: a daemon left by an older SDK is replaced by the bundled one.
        try:
            binary = resolve_daemon_binary()
        except DaemonError:
            binary = None
        keep = os.environ.get("CTENO_SDK_KEEP_DAEMON") == "1"
        if keep or binary is None or not needs_upgrade(running, binary.version):
            return DaemonHandle(layout, None, False, None, running)
        await stop_daemon(home)
    if binary is None:
        binary = resolve_daemon_binary()
    for d in (layout.data_dir, layout.host_root, layout.log_file.parent):
        d.mkdir(parents=True, exist_ok=True)
    # Nothing answers, so a lock whose pid is dead is stale; older daemons
    # cannot always tell on their own (no `ps` in minimal containers).
    for lock in (layout.host_root / "host.lock", layout.data_dir / "host.owner.lock"):
        if lock.exists() and not lock_held(lock):
            try:
                lock.unlink()
            except OSError:
                pass
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000200 | 0x08000000  # NEW_PROCESS_GROUP | NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    with open(layout.log_file, "ab") as log:
        proc = subprocess.Popen([str(binary.path), "serve"], env=daemon_environment(layout, binary, extra=env),
                                cwd=str(layout.root), stdin=subprocess.DEVNULL, stdout=log, stderr=log, **kwargs)
    _SPAWNED.append(proc)
    deadline = time.monotonic() + start_timeout
    while time.monotonic() < deadline:
        if await _answers(layout.endpoint):
            alive = proc.poll() is None
            return DaemonHandle(layout, binary, alive, proc.pid if alive else None, binary.version)
        if proc.poll() is not None:
            # Lost the host-lock race to a concurrent start: wait for the winner.
            winner = min(deadline, time.monotonic() + 15)
            while time.monotonic() < winner:
                if await _answers(layout.endpoint):
                    return DaemonHandle(layout, binary, False, None)
                await asyncio.sleep(0.2)
            raise DaemonError("The bundled Cteno daemon exited during startup (code %s). Log: %s\n%s"
                              % (proc.returncode, layout.log_file, _tail(layout.log_file)))
        await asyncio.sleep(0.2)
    raise DaemonError("The bundled Cteno daemon did not answer within %ss. Log: %s\n%s"
                      % (start_timeout, layout.log_file, _tail(layout.log_file)))


async def stop_daemon(home: Optional[os.PathLike] = None, timeout: float = 30.0) -> bool:
    """Ask the SDK's daemon for ``home`` to exit. False when none was running."""
    from .client import _open_endpoint
    layout = instance_layout(home)
    try:
        transport = await _open_endpoint(layout.endpoint, 1.5)
    except Exception:  # noqa: BLE001
        return False
    try:
        await transport.request("__rpc.shutdown", {"reason": "cteno-sdk stop_daemon"}, 5)
    except Exception:  # noqa: BLE001 — it may close the connection as it exits
        pass
    finally:
        transport.close()
    # Stopped means the process is gone, not just the socket: the daemon keeps
    # its host lock while draining subprocesses after closing the socket.
    locks = (layout.host_root / "host.lock", layout.data_dir / "host.owner.lock")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not await _answers(layout.endpoint, 0.5) and not any(lock_held(l) for l in locks):
            return True
        await asyncio.sleep(0.2)
    raise DaemonError("The SDK daemon at %s did not stop" % layout.endpoint)


def lock_held(lock_path: Path) -> bool:
    """Is ``host.lock`` held by a live process? A stale file (dead pid) is not held."""
    _reap_spawned()
    try:
        pid = int(lock_path.read_text().strip())
    except (OSError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    # A zombie (exited, not yet reaped by its parent) is not a lock holder.
    try:
        with open("/proc/%d/stat" % pid) as f:
            state = f.read().rsplit(")", 1)[1].split()[0]
        return state not in ("Z", "X")
    except (OSError, IndexError):
        return True
