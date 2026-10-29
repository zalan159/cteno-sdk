"""Bundled-daemon unit tests (no daemon binary needed)."""
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cteno_sdk import daemon  # noqa: E402
from cteno_sdk.client import permission_request_of, resumed_card_of  # noqa: E402


def row(data):
    return {"text": json.dumps({"content": {"data": data}, "role": "agent"})}


class DaemonTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "Windows endpoints are fixed-length pipe names")
    def test_over_long_home_fails_fast_with_config(self):
        import asyncio
        import time
        start = time.monotonic()
        with self.assertRaises(daemon.DaemonError) as ctx:
            asyncio.run(daemon.ensure_daemon("/tmp/" + "x" * 130, start_timeout=20))
        self.assertLess(time.monotonic() - start, 1.0)
        self.assertEqual(ctx.exception.code, "CONFIG")
        self.assertRegex(str(ctx.exception), r"socket path .*host\.host\.sock is \d+ bytes, max 10[37]")
        self.assertEqual(daemon.socket_path_limit("darwin"), 103)
        self.assertEqual(daemon.socket_path_limit("linux"), 107)
        self.assertIsNone(daemon.socket_path_limit("win32"))

    @unittest.skipIf(sys.platform == "win32", "shell fake daemon")
    def test_fatal_line_fails_fast_with_original_error(self):
        import asyncio
        import shutil
        import tempfile
        import time
        d = tempfile.mkdtemp(prefix="sdkf-")
        fake = os.path.join(d, "cteno-host-cli")
        with open(fake, "w") as f:
            f.write("\n".join([
                "#!/bin/sh",
                'i=0; while [ $i -lt 90 ]; do echo "[inbox] chatter $i"; i=$((i+1)); done',
                'echo "CTENO_DAEMON_FATAL bind_failed: Failed to bind /x/run/host.host.sock: Address already in use" >&2',
                'i=0; while [ $i -lt 110 ]; do echo "[scheduler] chatter $i"; i=$((i+1)); done',
                "exit 78", ""]))
        os.chmod(fake, 0o755)
        saved = os.environ.get("CTENO_SDK_DAEMON_PATH")
        os.environ["CTENO_SDK_DAEMON_PATH"] = fake
        start = time.monotonic()
        try:
            with self.assertRaises(daemon.DaemonError) as ctx:
                asyncio.run(daemon.ensure_daemon(os.path.join(d, "h"), start_timeout=20))
            self.assertLess(time.monotonic() - start, 3.0)
            self.assertIn("CTENO_DAEMON_FATAL bind_failed: Failed to bind /x/run/host.host.sock: Address already in use",
                          str(ctx.exception))
        finally:
            if saved is None:
                os.environ.pop("CTENO_SDK_DAEMON_PATH", None)
            else:
                os.environ["CTENO_SDK_DAEMON_PATH"] = saved
            shutil.rmtree(d, ignore_errors=True)

    def test_layout_under_one_root(self):
        layout = daemon.instance_layout("/tmp/sdk-root")
        self.assertEqual(layout.data_dir, Path("/tmp/sdk-root/data"))
        self.assertEqual(layout.host_root, Path("/tmp/sdk-root/run"))
        self.assertEqual(layout.log_file, Path("/tmp/sdk-root/logs/daemon.log"))
        if sys.platform != "win32":
            self.assertEqual(layout.endpoint, "/tmp/sdk-root/run/host.host.sock")
        self.assertNotIn("com.cteno-host", str(daemon.default_instance_root()))

    def test_env_strips_app_leaks(self):
        layout = daemon.instance_layout("/tmp/r")
        binary = daemon.DaemonBinary(Path("/x/bin/cteno-host-cli"), Path("/x/bin"), Path("/x"), "1", "wheel")
        env = daemon.daemon_environment(layout, binary, base={
            "PATH": "/usr/bin", "HOME": "/h", "CTENO_APP_DATA_DIR": "/gui", "cteno_env": "dev",
            "CTENO_HAPPY_SERVER_URL": "https://cloud", "EXPO_PUBLIC_CTENO_X": "1",
            "SECRET_VAULT_DIR": "/v", "FNOX_AGE_KEY": "k"})
        self.assertEqual(env["HOME"], "/h")
        self.assertTrue(env["PATH"].startswith("/x/bin"))
        self.assertEqual(env["CTENO_ISOLATED_ROOT"], "/tmp/r")
        self.assertEqual(env["CTENO_APP_DATA_DIR"], str(layout.data_dir))
        self.assertEqual(env["CTENO_ENV"], "host")
        for k in ("CTENO_HAPPY_SERVER_URL", "cteno_env", "EXPO_PUBLIC_CTENO_X", "SECRET_VAULT_DIR", "FNOX_AGE_KEY"):
            self.assertNotIn(k, env)

    def test_pipe_name_matches_rust_vectors(self):
        self.assertEqual(daemon.isolated_pipe_name(""), r"\\.\pipe\cteno-sdk-cbf29ce484222325")
        self.assertEqual(daemon.isolated_pipe_name("a"), r"\\.\pipe\cteno-sdk-af63dc4c8601ec8c")
        self.assertEqual(daemon.isolated_pipe_name(r"C:\Users\x\AppData\Local\cteno-sdk", "host"),
                         r"\\.\pipe\cteno-sdk-91d1e156813077ec-host")

    def test_upgrade_policy(self):
        self.assertEqual(daemon.compare_versions("2.10.10", "2.9.28"), 1)
        self.assertEqual(daemon.compare_versions("2.10", "2.10.0"), 0)
        self.assertTrue(daemon.needs_upgrade("2.10.9", "2.10.10"))
        self.assertFalse(daemon.needs_upgrade("2.10.10", "2.10.10"))
        self.assertFalse(daemon.needs_upgrade("2.11.0", "2.10.10"))
        self.assertTrue(daemon.needs_upgrade(None, "2.10.10"))
        self.assertFalse(daemon.needs_upgrade("2.10.9", None))

    def test_card_park_and_resume_rows(self):
        calls = {}
        self.assertIsNone(permission_request_of(row({"type": "tool-call", "callId": "c1", "name": "Bash", "input": {"command": "ls"}}), "s", calls))
        req = permission_request_of(row({"type": "tool-result", "callId": "c1", "output": json.dumps(
            {"verdict": "pending", "proceed": False, "cardId": "card_1", "permissionPending": True})}), "s", calls)
        self.assertEqual((req["id"], req["tool_name"], req["via"]), ("card_1", "Bash", "card"))
        legacy = permission_request_of(row({"type": "permission-request", "permissionId": "p1", "toolName": "edit"}), "s")
        self.assertEqual((legacy["id"], legacy["via"]), ("p1", "session"))
        self.assertEqual(resumed_card_of(row({"type": "task_complete", "id": "confirmation:card_1"})), "card_1")
        self.assertIsNone(resumed_card_of(row({"type": "task_complete", "id": "t1"})))

    def test_lock_held(self):
        import tempfile
        lock = Path(tempfile.mkdtemp()) / "host.lock"
        self.assertFalse(daemon.lock_held(lock))
        lock.write_text("%d\n" % os.getpid())
        self.assertTrue(daemon.lock_held(lock))
        lock.write_text("2147483646\n")
        self.assertFalse(daemon.lock_held(lock))
        lock.write_text("junk")
        self.assertFalse(daemon.lock_held(lock))


if __name__ == "__main__":
    unittest.main()
