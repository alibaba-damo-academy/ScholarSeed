"""SqliteFtsStore — 单表 FTS5 全文索引原语 (refact/01 A.6)。

需要全文检索的列正常建, 其余元数据列标 UNINDEXED。逻辑主键 id_column 自维护 (upsert = DELETE
then INSERT)。关键词先安全转义成 FTS5 phrase token。FTS5 不可用时 `is_fts5_available()` 返 False,
调用方退回内存扫描, 不致命。线程安全 (单连接 + 锁)。
"""

from __future__ import annotations

import re
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

from damoatrace.search.protocol import Store
from damoatrace.search.utils import coerce as _coerce
from damoatrace.search.utils import ident as _ident
from damoatrace.search.utils import sanitize_match as _sanitize_match

_FTS5_OK: Optional[bool] = None


def is_fts5_available() -> bool:
    global _FTS5_OK
    if _FTS5_OK is not None:
        return _FTS5_OK
    try:
        con = sqlite3.connect(":memory:")
        try:
            con.execute("CREATE VIRTUAL TABLE _probe USING fts5(x)")
            _FTS5_OK = True
        finally:
            con.close()
    except sqlite3.Error:
        _FTS5_OK = False
    return _FTS5_OK


class SqliteFtsStore(Store):
    """单表 FTS5 索引 (`Store` 名义实现)。"""

    def __init__(
        self,
        db_path: Path | str,
        *,
        table: str,
        columns: Sequence[str],
        fts_columns: Sequence[str],
        id_column: str = "id",
        tokenize: str = "unicode61",
    ):
        if not is_fts5_available():
            raise RuntimeError("sqlite3 FTS5 not available in this build")
        self.table = _ident(table)
        self.columns = list(columns)
        self.id_column = id_column
        fts_set = set(fts_columns)
        if id_column not in self.columns:
            raise ValueError(f"id_column {id_column!r} must be in columns")
        for c in fts_columns:
            if c not in self.columns:
                raise ValueError(f"fts_column {c!r} not in columns")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_ ]*", tokenize or ""):
            raise ValueError(f"unsafe tokenize: {tokenize!r}")
        self._db_path = Path(db_path)
        if str(db_path) != ":memory:":
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._con = sqlite3.connect(str(db_path), check_same_thread=False)
        self._con.row_factory = sqlite3.Row
        self._con.execute("PRAGMA busy_timeout=5000")
        col_defs = ", ".join(
            _ident(c) if c in fts_set else f"{_ident(c)} UNINDEXED" for c in self.columns
        )
        with self._lock:
            self._con.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {self.table} "
                f"USING fts5({col_defs}, tokenize='{tokenize}')"
            )
            self._con.commit()

    def upsert(self, row: dict[str, Any]) -> None:
        self.upsert_many([row])

    def reset_projection(self, version: str) -> bool:
        """Invalidate an old disposable projection, including freed body pages."""
        with self._lock:
            self._con.execute("PRAGMA secure_delete=ON")
            self._con.execute(
                "CREATE TABLE IF NOT EXISTS projection_versions (name TEXT PRIMARY KEY, version TEXT)"
            )
            current = self._con.execute(
                "SELECT version FROM projection_versions WHERE name = ?", (self.table,)
            ).fetchone()
            if current and current[0] == version:
                return False
            self._con.execute(f"DELETE FROM {self.table}")
            self._con.execute(
                "INSERT OR REPLACE INTO projection_versions VALUES (?, ?)", (self.table, version)
            )
            self._con.commit()
            self._con.execute("VACUUM")
            return True

    def upsert_many(self, rows: Iterable[dict[str, Any]]) -> None:
        rows = list(rows)
        if not rows:
            return
        cols = ", ".join(_ident(c) for c in self.columns)
        ph = ", ".join("?" for _ in self.columns)
        idc = _ident(self.id_column)
        with self._lock:
            for row in rows:
                rid = row.get(self.id_column)
                if rid is not None:
                    self._con.execute(f"DELETE FROM {self.table} WHERE {idc} = ?", (rid,))
                vals = [_coerce(row.get(c)) for c in self.columns]
                self._con.execute(f"INSERT INTO {self.table} ({cols}) VALUES ({ph})", vals)
            self._con.commit()

    def search(
        self,
        query: str,
        *,
        limit: int = 50,
        column: Optional[str] = None,
        where: Optional[str] = None,
        where_params: Sequence[Any] = (),
        prefix: bool = False,
        match_any: bool = False,
    ) -> list[dict[str, Any]]:
        match = _sanitize_match(query, column=column, prefix=prefix, match_any=match_any)
        if not match:
            return []
        sql = f"SELECT * FROM {self.table} WHERE {self.table} MATCH ?"
        params: list[Any] = [match]
        if where:
            sql += f" AND ({where})"
            params.extend(where_params)
        sql += f" ORDER BY bm25({self.table}) LIMIT ?"
        params.append(int(limit))
        with self._lock:
            try:
                cur = self._con.execute(sql, params)
                return [dict(r) for r in cur.fetchall()]
            except sqlite3.Error:
                return []

    def count(self) -> int:
        with self._lock:
            cur = self._con.execute(f"SELECT count(*) AS n FROM {self.table}")
            return int(cur.fetchone()["n"])

    def delete(self, row_id: Any) -> bool:
        idc = _ident(self.id_column)
        with self._lock:
            cur = self._con.execute(f"DELETE FROM {self.table} WHERE {idc} = ?", (row_id,))
            self._con.commit()
            return cur.rowcount > 0

    def list_rows(
        self, *, limit: int = 1000, order_by: Optional[str] = None
    ) -> list[dict[str, Any]]:
        sql = f"SELECT * FROM {self.table}"
        if order_by:
            sql += f" ORDER BY {_ident(order_by)}"
        sql += " LIMIT ?"
        with self._lock:
            cur = self._con.execute(sql, (int(limit),))
            return [dict(r) for r in cur.fetchall()]

    def close(self) -> None:
        with self._lock:
            try:
                self._con.close()
            except sqlite3.Error:
                pass
