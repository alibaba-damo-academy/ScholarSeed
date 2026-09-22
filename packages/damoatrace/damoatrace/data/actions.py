"""Optional read-only adapter for a product action database.

The action database is owned by the product that records it. DamoATrace only
reads an explicitly supplied path, either through the API or the
``DAMOATRACE_ACTIONS_DB`` environment variable.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

ACTION_DB_ENV = "DAMOATRACE_ACTIONS_DB"


def _configured_db() -> Optional[Path]:
    raw = os.environ.get(ACTION_DB_ENV)
    return Path(raw).expanduser() if raw else None


def _conn(db: Optional[Path] = None) -> Optional[sqlite3.Connection]:
    path = Path(db) if db is not None else _configured_db()
    if path is None:
        return None
    if not path.exists():
        return None
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def read_service_actions(
    *,
    namespace: Optional[str] = None,
    source: Optional[str] = None,
    session: Optional[str] = None,
    since_seq: int = 0,
    limit: int = 200,
    db: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """读 service_actions, 输出 damoatrace.actions.v1 行 (Evidence Contract 形态)。"""
    conn = _conn(db)
    if conn is None:
        return []
    try:
        where = ["seq > ?"]
        params: List[Any] = [since_seq]
        if namespace:
            where.append("namespace = ?")
            params.append(namespace)
        if source:
            where.append("source = ?")
            params.append(source)
        if session:
            where.append("session_id = ?")
            params.append(session)
        sql = (
            f"SELECT * FROM service_actions WHERE {' AND '.join(where)} "
            f"ORDER BY seq ASC LIMIT ?"
        )
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        return []  # 表还没建 (从未 serve 过)
    finally:
        conn.close()
    out: List[Dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        for jc in ("domain_event_ids", "payload", "evidence_refs"):
            try:
                d[jc] = json.loads(d[jc]) if d[jc] else ([] if jc != "payload" else {})
            except (json.JSONDecodeError, TypeError):
                pass
        out.append(
            {
                "event_id": d["event_id"],
                "seq": d["seq"],
                "ts": d["ts"],
                "namespace": d["namespace"],
                "verb": d["verb"],
                "source": d["source"],
                "actor": {"type": d["actor_type"], "id": d["actor_id"]},
                "outcome": d["outcome"],
                "domain_event_ids": d.get("domain_event_ids", []),
                "entity_type": d.get("entity_type"),
                "entity_id": d.get("entity_id"),
                "memory_relevance": d.get("memory_relevance"),
                "request_id": d.get("request_id"),
                "session_id": d.get("session_id"),
                "task_run_id": d.get("task_run_id"),
                "trace_span_id": d.get("trace_span_id"),
                "error_class": d.get("error_class"),
                "error_text": d.get("error_text"),
                "payload": d.get("payload", {}),
            }
        )
    return out


__all__ = ["ACTION_DB_ENV", "read_service_actions"]
