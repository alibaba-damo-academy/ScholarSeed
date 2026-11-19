#!/usr/bin/env python3
"""Bounded read-only SQLite queries and session metadata presets."""

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

from resolve import (
    DATABASE_RELATIVE,
    WindowsDatabaseReaderError,
    authorize_read,
    product_home,
    readonly_database,
)

DEFAULT_LIMIT = 20
MAX_LIMIT = 200
QUERY_TIMEOUT_SECONDS = 5
PROGRESS_INTERVAL = 1000
MAX_VALUE_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 256 * 1024
READ_FUNCTIONS = frozenset(
    (
        "count",
        "length",
        "min",
        "max",
        "sum",
        "avg",
        "coalesce",
        "ifnull",
        "lower",
        "upper",
        "abs",
        "round",
        "substr",
        "typeof",
    )
)
METADATA_COLUMNS = frozenset(
    (
        "session_id",
        "product_session_id",
        "runtime_id",
        "vendor_thread_id",
        "vendor_session_id",
        "status",
        "state",
        "runtime_workdir",
        "project_path",
        "output_root",
        "last_turn_id",
        "last_turn_status",
        "last_product_seq",
        "opaque_session_ref",
        "adapter_version",
        "runtime_version",
        "protocol_version",
        "selected_model_id",
        "active_model_id",
        "model_id",
        "policy_id",
        "codex_version",
        "product_seq",
        "kind",
        "vendor_turn_id",
        "vendor_item_id",
        "created_at",
        "updated_at",
        "resolved_at",
        "product_request_id",
        "correlation_id",
        "enqueue_seq",
        "native_turn_id",
        "artifact_id",
        "source_product_seq",
        "canonical_path",
        "ordinal",
        "role",
        "turn_id",
        "item_id",
        "phase",
        "snapshot_id",
        "client_turn_id",
        "evidence_id",
        "resolution_state",
        "order_index",
        "publication_id",
        "declaration_id",
        "acknowledged",
        "type",
        "name",
        "tbl_name",
        "rootpage",
        "size_bytes",
        "content_sha256",
    )
)
PROJECT_DATABASE_RELATIVE = Path(".scholarseed/service/project.sqlite3")
EXIT_UNAVAILABLE = 4
QUERIES = {
    "catalog": "SELECT session_id,runtime_id,vendor_thread_id,status,runtime_workdir,project_path,output_root,last_turn_id,last_turn_status,last_product_seq FROM session_catalog WHERE session_id=? ORDER BY session_id",
    "binding": "SELECT runtime_id,opaque_session_ref,adapter_version,runtime_version FROM session_runtime_binding WHERE product_session_id=? ORDER BY product_session_id",
    "model": "SELECT selected_model_id,active_model_id FROM session_model_state WHERE session_id=? ORDER BY session_id",
    "events": "SELECT product_seq,kind,vendor_turn_id,created_at FROM product_event WHERE session_id=? ORDER BY product_seq DESC",
    "terminal": "SELECT product_seq,kind,vendor_turn_id FROM product_event WHERE session_id=? AND kind IN ('turn_completed','turn_failed','turn_interrupted') ORDER BY product_seq DESC",
    "hil": "SELECT product_request_id,status FROM session_hil WHERE session_id=? ORDER BY created_at DESC,product_request_id",
    "uncertainty": "SELECT kind,correlation_id,state FROM session_uncertainty WHERE session_id=? ORDER BY created_at DESC,kind,correlation_id",
    "queue": "SELECT enqueue_seq,state,native_turn_id FROM session_message_queue WHERE session_id=? ORDER BY enqueue_seq DESC",
    "artifacts": "SELECT artifact_id,status,source_product_seq,canonical_path FROM session_artifact WHERE session_id=? ORDER BY source_product_seq DESC,artifact_id",
    "drafts": "SELECT draft.artifact_id,length(draft.content) AS bytes FROM session_artifact_draft AS draft JOIN session_artifact AS artifact ON artifact.artifact_id=draft.artifact_id WHERE artifact.session_id=? ORDER BY draft.artifact_id",
    "history": "SELECT ordinal,role,turn_id,item_id,phase FROM session_portable_history WHERE session_id=? ORDER BY ordinal DESC",
    "snapshots": "SELECT snapshot_id,client_turn_id,created_at FROM assistant_turn_snapshot WHERE session_id=? ORDER BY created_at DESC,snapshot_id",
    "context": "SELECT item.snapshot_id,item.evidence_id,item.kind,item.resolution_state FROM assistant_turn_item AS item JOIN assistant_turn_snapshot AS snapshot ON snapshot.snapshot_id=item.snapshot_id WHERE snapshot.session_id=? ORDER BY item.snapshot_id,item.order_index,item.evidence_id",
    "publications": "SELECT publication_id,turn_id,role FROM chat_artifact_publication WHERE session_id=? ORDER BY created_at DESC,publication_id",
    "declarations": "SELECT declaration_id,publication_id FROM chat_artifact_declaration WHERE session_id=? ORDER BY declaration_id",
    "outbox": "SELECT outbox.publication_id,outbox.acknowledged FROM chat_artifact_outbox AS outbox JOIN chat_artifact_publication AS publication ON publication.publication_id=outbox.publication_id WHERE publication.session_id=? ORDER BY outbox.publication_id",
}
PROJECT_QUERIES = frozenset(("publications", "declarations", "outbox"))


def custom_authorizer(allow_content):
    def authorize(action, first, second, database, source):
        if action == sqlite3.SQLITE_READ:
            if allow_content or not second or second in METADATA_COLUMNS:
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION:
            return sqlite3.SQLITE_OK if second in READ_FUNCTIONS else sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_RECURSIVE:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_TRANSACTION:
            return sqlite3.SQLITE_DENY
        return authorize_read(action, first, second, database, source)

    return authorize


def open_database(path):
    connection = readonly_database(path)
    connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_VALUE_BYTES)
    deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
    connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), PROGRESS_INTERVAL)
    connection.execute("BEGIN")
    return connection


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", nargs="?", help="exact product session ID, not a title")
    parser.add_argument("query", nargs="?", choices=tuple(QUERIES))
    parser.add_argument("--database", type=Path)
    parser.add_argument("--sql")
    parser.add_argument("--params", default="[]", help="JSON array or named-parameter object")
    parser.add_argument(
        "--allow-content",
        action="store_true",
        help="explicitly authorize non-metadata columns; output may be sensitive",
    )
    parser.add_argument("--home", type=Path)
    parser.add_argument("--project", action="store_true")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    if not 1 <= args.limit <= MAX_LIMIT or args.offset < 0:
        parser.error("limit must be 1..200 and offset must be nonnegative")
    custom = args.sql is not None or args.database is not None
    if custom:
        if args.sql is None or args.database is None:
            parser.error("--database and --sql must be supplied together")
        if args.session or args.query or args.home or args.project or args.offset:
            parser.error("custom SQL cannot be combined with session presets or --offset")
    elif not args.session or not args.query or args.allow_content or args.params != "[]":
        parser.error("supply session and query, or --database and --sql")
    if args.project and args.query not in PROJECT_QUERIES:
        parser.error("--project supports publications, declarations and outbox only")
    path = (
        args.database.expanduser().resolve()
        if custom
        else product_home(args.home) / DATABASE_RELATIVE
    )
    connection = None
    try:
        connection = open_database(path)
        if custom:
            parameters = json.loads(args.params)
            if not isinstance(parameters, (list, dict)):
                raise ValueError("parameters_must_be_array_or_object")
            connection.set_authorizer(custom_authorizer(args.allow_content))
            cursor = connection.execute(args.sql, parameters)
            if cursor.description is None:
                raise ValueError("query_must_return_rows")
            rows = []
            output_bytes = 0
            truncated = False
            for row in cursor:
                projected = {
                    key: ({"binary_bytes": len(value)} if isinstance(value, bytes) else value)
                    for key, value in dict(row).items()
                }
                encoded = json.dumps(projected, ensure_ascii=False).encode("utf-8")
                if len(rows) >= args.limit or output_bytes + len(encoded) > MAX_OUTPUT_BYTES:
                    truncated = True
                    break
                rows.append(projected)
                output_bytes += len(encoded)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "database": str(path),
                        "readonly": True,
                        "query": "custom",
                        "limit": args.limit,
                        "truncated": truncated,
                        "content_authorized": args.allow_content,
                        "rows": rows,
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        record = connection.execute(
            "SELECT project_path FROM session_catalog WHERE session_id=?", (args.session,)
        ).fetchone()
        if record is None:
            raise ValueError("session_not_found")
        if args.project:
            if not record["project_path"]:
                raise ValueError("session_has_no_project")
            path = Path(record["project_path"]) / PROJECT_DATABASE_RELATIVE
            if not path.is_absolute():
                raise ValueError("project_path_not_absolute")
            connection.close()
            connection = open_database(path)
        rows = connection.execute(
            QUERIES[args.query] + " LIMIT ? OFFSET ?",
            (args.session, args.limit + 1, args.offset),
        ).fetchall()
        print(
            json.dumps(
                {
                    "ok": True,
                    "database": str(path),
                    "session_id": args.session,
                    "query": args.query,
                    "readonly": True,
                    "offset": args.offset,
                    "limit": args.limit,
                    "truncated": len(rows) > args.limit,
                    "rows": [dict(row) for row in rows[: args.limit]],
                },
                ensure_ascii=False,
            )
        )
        return 0
    except (sqlite3.Error, ValueError) as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "database": str(path),
                    "query": args.query,
                    "error_type": type(error).__name__,
                    "error": str(error),
                    **(
                        {"error_code": error.code}
                        if isinstance(error, WindowsDatabaseReaderError)
                        else {}
                    ),
                },
                ensure_ascii=False,
            )
        )
        return EXIT_UNAVAILABLE
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    sys.exit(main())
