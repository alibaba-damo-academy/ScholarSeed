#!/usr/bin/env python3
"""Resolve one ScholarSeed product session without reading conversation content."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

DEFAULT_HOME_DIRNAME = ".scholarseed"
DATABASE_RELATIVE = Path("service/sessions.sqlite3")
SESSION_TABLE = "session_catalog"
EXIT_NOT_FOUND = 2
EXIT_AMBIGUOUS = 3
EXIT_UNAVAILABLE = 4
MAX_CANDIDATES = 20
READ_ACTIONS = frozenset((sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ))
READ_FUNCTIONS = frozenset(("count", "length"))
READ_TRANSACTIONS = frozenset(("BEGIN", "ROLLBACK"))
WINDOWS_PLATFORM = "win32"
TOKEN_QUERY = 0x0008
TOKEN_ELEVATION = 20
WINDOWS_ELEVATED_READER = "windows_elevated_sqlite_reader"
WINDOWS_ELEVATION_UNKNOWN = "windows_sqlite_reader_elevation_unknown"
WINDOWS_READER_GUIDANCE = (
    "Read SQLite from the non-elevated Desktop user session, or use exact-session Trace and logs."
)


class WindowsDatabaseReaderError(ValueError):
    def __init__(self, code: str, detail: str = WINDOWS_READER_GUIDANCE) -> None:
        super().__init__(detail)
        self.code = code


def authorize_read(action, first, second, database, source):
    if action in READ_ACTIONS:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION and second in READ_FUNCTIONS:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_TRANSACTION and first in READ_TRANSACTIONS:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_PRAGMA and first == "table_info":
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", help="product session id or exact title")
    parser.add_argument("--home", type=Path, help="explicit SCHOLARSEED_HOME")
    return parser.parse_args()


def product_home(explicit: Path | None) -> Path:
    fallback = Path.home() / DEFAULT_HOME_DIRNAME
    configured = explicit or Path(os.environ.get("SCHOLARSEED_HOME", "").strip() or fallback)
    return configured.expanduser().resolve()


def output(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _process_token_elevated() -> bool:
    """Read the Win32 token flag using fixed-width ABI types."""
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        security = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel.GetCurrentProcess.argtypes = ()
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel.CloseHandle.restype = ctypes.c_int32
        security.OpenProcessToken.argtypes = (
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
        )
        security.OpenProcessToken.restype = ctypes.c_int32
        security.GetTokenInformation.argtypes = (
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
        )
        security.GetTokenInformation.restype = ctypes.c_int32
        token = ctypes.c_void_p()
        if not security.OpenProcessToken(
            kernel.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        failure: BaseException | None = None
        try:
            elevated = ctypes.c_uint32()
            actual_size = ctypes.c_uint32()
            capacity = ctypes.sizeof(elevated)
            if not security.GetTokenInformation(
                token, TOKEN_ELEVATION, ctypes.byref(elevated), capacity, ctypes.byref(actual_size)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            if actual_size.value != capacity:
                raise OSError("Windows returned an incomplete token elevation value")
            return bool(elevated.value)
        except BaseException as error:
            failure = error
            raise
        finally:
            if not kernel.CloseHandle(token):
                close_error = ctypes.WinError(ctypes.get_last_error())
                if failure is None:
                    raise close_error
                failure.add_note(f"CloseHandle also failed: {close_error}")
    except (OSError, AttributeError) as error:
        raise WindowsDatabaseReaderError(
            WINDOWS_ELEVATION_UNKNOWN,
            f"Could not verify Windows process token elevation. {WINDOWS_READER_GUIDANCE}",
        ) from error


def readonly_database(path: Path) -> sqlite3.Connection:
    if sys.platform == WINDOWS_PLATFORM and _process_token_elevated():
        raise WindowsDatabaseReaderError(WINDOWS_ELEVATED_READER)
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.set_authorizer(authorize_read)
    return connection


def public_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "session_id": str(row["session_id"]),
        "title": str(row["title"] or ""),
        "runtime_id": str(row["runtime_id"] or ""),
        "vendor_thread_id": str(row["vendor_thread_id"] or ""),
        "status": str(row["status"] or ""),
        "updated_at": row["updated_at"],
        **{
            key: row[key]
            for key in (
                "runtime_workdir",
                "project_path",
                "output_root",
                "model_id",
                "policy_id",
                "codex_version",
                "last_turn_id",
                "last_turn_status",
                "last_product_seq",
            )
            if key in row.keys()
        },
    }


def resolve(
    connection: sqlite3.Connection, query: str
) -> tuple[sqlite3.Row | None, list[sqlite3.Row]]:
    exact_id = connection.execute(
        f"SELECT * FROM {SESSION_TABLE} WHERE session_id = ?",
        (query,),
    ).fetchone()
    if exact_id is not None:
        return exact_id, []
    matches = connection.execute(
        f"""
        SELECT * FROM {SESSION_TABLE}
        WHERE title = ?
        ORDER BY updated_at DESC, session_id
        LIMIT ?
        """,
        (query, MAX_CANDIDATES + 1),
    ).fetchall()
    if len(matches) == 1:
        return matches[0], []
    return None, matches


def main() -> int:
    args = arguments()
    query = args.session.strip()
    database = product_home(args.home) / DATABASE_RELATIVE
    if not query:
        output({"resolved": False, "error": "empty_session"})
        return EXIT_NOT_FOUND
    if not database.is_file():
        output({"resolved": False, "error": "session_catalog_missing"})
        return EXIT_UNAVAILABLE
    try:
        connection = readonly_database(database)
        try:
            table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                (SESSION_TABLE,),
            ).fetchone()
            if table is None:
                output({"resolved": False, "error": "session_catalog_table_missing"})
                return EXIT_UNAVAILABLE
            session, matches = resolve(connection, query)
        finally:
            connection.close()
    except WindowsDatabaseReaderError as error:
        output({"resolved": False, "error": error.code, "detail": str(error)})
        return EXIT_UNAVAILABLE
    except sqlite3.Error as error:
        output(
            {
                "resolved": False,
                "error": "session_catalog_unavailable",
                "error_type": type(error).__name__,
            }
        )
        return EXIT_UNAVAILABLE
    if session is not None:
        output({"resolved": True, "session": public_row(session)})
        return 0
    candidates = [public_row(row) for row in matches[:MAX_CANDIDATES]]
    if candidates:
        output(
            {
                "resolved": False,
                "error": "ambiguous_exact_title",
                "candidates": candidates,
                "truncated": len(matches) > MAX_CANDIDATES,
            }
        )
        return EXIT_AMBIGUOUS
    output({"resolved": False, "error": "session_not_found"})
    return EXIT_NOT_FOUND


if __name__ == "__main__":
    sys.exit(main())
