"""Contracts for directly invoking the developer session metadata reader."""

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / ".agents/skills/evidence-session/scripts"


class SessionReaderTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "non-Windows import boundary")
    def test_non_windows_commands_do_not_import_windows_ctypes_types(self):
        code = """
import builtins
import importlib
from unittest.mock import patch

original_import = builtins.__import__

def import_without_wintypes(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "ctypes.wintypes" or (name == "ctypes" and "wintypes" in (fromlist or ())):
        raise ImportError("Windows ctypes types are unavailable")
    return original_import(name, globals, locals, fromlist, level)

with patch.object(builtins, "__import__", side_effect=import_without_wintypes):
    for module in ("resolve", "query"):
        assert callable(importlib.import_module(module).main)
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", code], cwd=SCRIPTS, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_windows_reader_requires_verified_unelevated_token_before_opening_sqlite(self):
        code = """
import ctypes
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

import query
import resolve

def check(scenario):
    kernel = Mock()
    security = Mock()

    def open_token(process, access, handle):
        handle._obj.value = 123
        return scenario != "open_failed"

    def get_information(token, information_class, result, capacity, actual_size):
        assert token.value == 123
        assert information_class == 20
        assert capacity == ctypes.sizeof(result._obj)
        result._obj.value = int(scenario == "elevated")
        actual_size._obj.value = 0 if scenario == "truncated" else capacity
        return scenario not in {"information_failed", "information_and_close_failed"}

    def close_handle(token):
        if scenario in {"close_failed", "information_and_close_failed"}:
            ctypes.set_last_error(6)
            return False
        return True

    def load(name, **kwargs):
        if scenario == "dll_failed":
            raise OSError("unavailable")
        assert kwargs == {"use_last_error": True}
        return {"kernel32": kernel, "advapi32": security}[name]

    security.OpenProcessToken.side_effect = open_token
    security.GetTokenInformation.side_effect = get_information
    kernel.CloseHandle.side_effect = close_handle
    last_error = 5

    def set_last_error(code):
        nonlocal last_error
        last_error = code

    with (
        patch.object(resolve, "sys", SimpleNamespace(platform="win32")),
        patch.object(ctypes, "WinDLL", side_effect=load, create=True),
        patch.object(ctypes, "WinError", side_effect=lambda code: OSError(code, "failed"), create=True),
        patch.object(ctypes, "get_last_error", side_effect=lambda: last_error, create=True),
        patch.object(ctypes, "set_last_error", side_effect=set_last_error, create=True),
        patch.object(resolve.sqlite3, "connect") as connect,
    ):
        if scenario == "unelevated":
            resolve.readonly_database(Path.cwd() / "sessions.sqlite3")
            connect.assert_called_once()
        else:
            try:
                resolve.readonly_database(Path.cwd() / "sessions.sqlite3")
            except ValueError as error:
                assert "exact-session Trace and logs" in str(error)
                if scenario == "information_and_close_failed":
                    assert error.__cause__.errno == 5
                    assert any("CloseHandle" in note and "6" in note for note in error.__cause__.__notes__)
                if scenario == "close_failed":
                    assert error.__cause__.errno == 6
            else:
                raise AssertionError(f"unsafe SQLite access: {scenario}")
            connect.assert_not_called()
            if scenario in {"elevated", "dll_failed"}:
                expected = (
                    "windows_elevated_sqlite_reader" if scenario == "elevated"
                    else "windows_sqlite_reader_elevation_unknown"
                )
                with TemporaryDirectory() as directory:
                    home = Path(directory)
                    database = home / resolve.DATABASE_RELATIVE
                    database.parent.mkdir()
                    database.touch()
                    for script, args, field in (
                        (resolve, ["fixture", "--home", str(home)], "error"),
                        (query, ["--database", str(database), "--sql", "SELECT 1"], "error_code"),
                    ):
                        stream = io.StringIO()
                        with patch.object(sys, "argv", ["script", *args]), redirect_stdout(stream):
                            assert script.main() == script.EXIT_UNAVAILABLE
                        assert json.loads(stream.getvalue())[field] == expected
                connect.assert_not_called()
    if scenario in {"dll_failed", "open_failed"}:
        kernel.CloseHandle.assert_not_called()
    else:
        assert kernel.CloseHandle.call_count == (3 if scenario == "elevated" else 1)
        assert kernel.CloseHandle.call_args.args[0].value == 123

for scenario in (
    "unelevated", "elevated", "dll_failed", "open_failed", "information_failed",
    "truncated", "close_failed", "information_and_close_failed",
):
    check(scenario)
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", code],
            cwd=SCRIPTS,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_resolve_and_query_read_an_explicit_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            database = home / "service" / "sessions.sqlite3"
            database.parent.mkdir()
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute(
                    "CREATE TABLE session_catalog (session_id TEXT, title TEXT, runtime_id TEXT, "
                    "vendor_thread_id TEXT, status TEXT, updated_at REAL)"
                )
                connection.execute(
                    "INSERT INTO session_catalog VALUES (?, ?, ?, ?, ?, ?)",
                    ("fixture", "Fixture", "codex", "native", "idle", 1.0),
                )
            for script, args in (
                ("resolve.py", ["fixture", "--home", str(home)]),
                (
                    "query.py",
                    [
                        "--database",
                        str(database),
                        "--sql",
                        "SELECT session_id FROM session_catalog",
                    ],
                ),
            ):
                with self.subTest(script=script):
                    result = subprocess.run(
                        [sys.executable, "-B", str(SCRIPTS / script), *args],
                        cwd=home,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    result_payload = json.loads(result.stdout)
                    if script == "resolve.py":
                        self.assertTrue(result_payload["resolved"])
                        self.assertEqual(result_payload["session"]["session_id"], "fixture")
                    else:
                        self.assertTrue(result_payload["readonly"])
                        self.assertEqual(result_payload["rows"], [{"session_id": "fixture"}])

    def test_scripts_do_not_shadow_standard_library_inspect(self):
        result = subprocess.run(
            [sys.executable, "-B", "-c", "import inspect; assert callable(inspect.signature)"],
            cwd=SCRIPTS,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_direct_metadata_command_preserves_nested_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "trace.jsonl"
            source.write_text(
                json.dumps(
                    {
                        "session_id": "synthetic-session",
                        "span_id": "synthetic-span",
                        "status": "ok",
                        "attributes": {"status": "error"},
                        "body": "must-not-be-projected",
                    }
                )
                + "\n"
            )
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPTS / "metadata.py"), str(source)],
                cwd=directory,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("must-not-be-projected", result.stdout)
            self.assertIn('"status": "error"', result.stdout)
            self.assertIn('"session_id": "synthetic-session"', result.stdout)


if __name__ == "__main__":
    unittest.main()
