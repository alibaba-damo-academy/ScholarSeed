from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing
from hashlib import sha256
from uuid import uuid4

from service.literature.domain.delivery import (
    FULLTEXT_BINDING_CONFLICT,
    DeliveryItemState,
    DeliveryState,
)
from service.literature.persistence.store import connect

DOWNLOAD_ADMISSION_CONFLICT = "download_admission_conflict"
DELIVERIES_TABLE = "literature_deliveries"
SOURCE_ALIASES = "source_aliases"
DELIVERIES_DDL = f"""
CREATE TABLE IF NOT EXISTS {DELIVERIES_TABLE} (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL,
    created_at REAL NOT NULL,
    UNIQUE(session_id, run, id)
)
"""


class DeliveryStore:
    def for_session(self, session_id: str, project_id: str) -> tuple[dict, ...]:
        with closing(connect()) as connection:
            if (
                connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (DELIVERIES_TABLE,)
                ).fetchone()
                is None
            ):
                return ()
            rows = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? AND project_id=? ORDER BY created_at,id",
                (session_id, project_id),
            ).fetchall()
        return tuple(json.loads(row["payload"]) for row in rows)

    @staticmethod
    def sources(paper: dict) -> tuple[dict, ...]:
        return (paper, *paper.get(SOURCE_ALIASES, ()))

    def candidates(self) -> tuple[dict, ...]:
        with closing(connect()) as connection, connection:
            self.ensure(connection)
            rows = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} ORDER BY created_at DESC"
            ).fetchall()
        return tuple(json.loads(row["payload"]) for row in rows)

    def session_batches(self, session_id: str) -> tuple[dict, ...]:
        """Every delivery batch one session recorded, newest first, any project scope.

        产品侧「这次会话已经拿到过哪些全文」只需要会话这一层范围: 一个会话只属于一个
        项目, 而 payload 里本来就带着当时记录的 project_id/run, 不需要调用方先猜出来。
        """
        with closing(connect()) as connection:
            self.ensure(connection)
            rows = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? ORDER BY created_at DESC, id",
                (session_id,),
            ).fetchall()
        return tuple(json.loads(row["payload"]) for row in rows)

    def ensure(self, connection: sqlite3.Connection) -> None:
        connection.execute(DELIVERIES_DDL)

    @classmethod
    def _bindings(cls, batches: list[dict], authorization_id: str = "") -> dict[str, dict]:
        bindings: dict[str, dict] = {}
        for batch in batches:
            for paper in batch["papers"]:
                for source in cls.sources(paper):
                    if authorization_id and source.get("authorization_id") != authorization_id:
                        continue
                    previous = bindings.get(source["paper_id"])
                    if previous is not None and previous["revision"] != source["revision"]:
                        raise ValueError(f"{FULLTEXT_BINDING_CONFLICT}: {source['paper_id']}")
                    bindings.setdefault(source["paper_id"], source)
        return bindings

    def bindings(
        self, session_id: str, project_id: str, run: str, *, authorization_id: str = ""
    ) -> dict[str, dict]:
        with closing(connect()) as connection:
            self.ensure(connection)
            rows = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} "
                "WHERE session_id=? AND project_id=? AND (? <> '' OR run=?) ORDER BY created_at, id",
                (session_id, project_id, authorization_id, run),
            ).fetchall()
        return self._bindings([json.loads(row["payload"]) for row in rows], authorization_id)

    def record(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        project_id: str,
        run: str,
        entries: list[dict],
        failures: list[dict],
    ) -> str:
        self.ensure(connection)
        if not connection.in_transaction:
            connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? AND run=? "
            "ORDER BY created_at DESC, id DESC",
            (session_id, run),
        ).fetchall()
        batches = [json.loads(row["payload"]) for row in rows]
        for entry in entries:
            operation = entry.get("admission_operation")
            if not operation:
                continue
            for batch in batches:
                for current in batch["papers"]:
                    for source in self.sources(current):
                        if source.get("admission_operation") == operation and (
                            source["revision"] != entry["revision"]
                            or source.get("admission_fingerprint")
                            != entry.get("admission_fingerprint")
                        ):
                            raise ValueError(DOWNLOAD_ADMISSION_CONFLICT)
        if any(batch["project_id"] != project_id for batch in batches):
            raise ValueError(FULLTEXT_BINDING_CONFLICT)
        bindings = self._bindings(batches)
        grant_ids = {
            entry["authorization_id"] for entry in entries if entry.get("authorization_id")
        }
        if grant_ids:
            grant_rows = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? AND project_id=?",
                (session_id, project_id),
            ).fetchall()
            grant_batches = [json.loads(row["payload"]) for row in grant_rows]
            for grant_id in grant_ids:
                granted = self._bindings(grant_batches, grant_id)
                for entry in entries:
                    if entry.get("authorization_id") != grant_id:
                        continue
                    previous = granted.get(entry["paper_id"])
                    if previous is not None and previous["revision"] != entry["revision"]:
                        raise ValueError(f"{FULLTEXT_BINDING_CONFLICT}: {entry['paper_id']}")
                    granted.setdefault(entry["paper_id"], entry)
        for entry in entries:
            previous_binding = bindings.get(entry["paper_id"])
            if previous_binding is not None and previous_binding["revision"] != entry["revision"]:
                raise ValueError(f"{FULLTEXT_BINDING_CONFLICT}: {entry['paper_id']}")
            bindings.setdefault(entry["paper_id"], entry)
        previous = batches[0] if batches else None
        matching = next(
            (
                batch
                for batch in batches
                if entries
                and not failures
                and all(
                    any(
                        current["paper_id"] == entry["paper_id"]
                        and current.get("identity") == entry.get("identity")
                        and current["revision"] == entry["revision"]
                        and current.get("authorization_id", "") == entry.get("authorization_id", "")
                        and (
                            not current.get("admission_operation")
                            or not entry.get("admission_operation")
                            or current["admission_operation"] == entry["admission_operation"]
                        )
                        for paper in batch["papers"]
                        for current in self.sources(paper)
                    )
                    for entry in entries
                )
            ),
            None,
        )
        if matching is not None:
            previous = matching
        repeated = matching is not None
        continuing = previous is not None and (
            previous["state"] == DeliveryState.ACQUIRING or repeated
        )
        if previous is not None and continuing and not repeated:
            continuing = all(
                (not current.get("admission_operation") or current["revision"] == entry["revision"])
                and current.get("authorization_id", "") == entry.get("authorization_id", "")
                for entry in entries
                for paper in previous["papers"]
                for current in self.sources(paper)
                if current["paper_id"] == entry["paper_id"]
            )
        delivery_id = (
            previous["id"]
            if previous is not None and continuing
            else sha256(json.dumps([session_id, run, uuid4().hex]).encode()).hexdigest()
        )
        value = (
            previous
            if previous is not None and continuing
            else {
                "id": delivery_id,
                "session_id": session_id,
                "project_id": project_id,
                "run": run,
                "state": DeliveryState.ACQUIRING,
                "prompted": False,
                "papers": [],
                "failures": [],
                "choice": None,
                "attempt_id": "",
                "history": [],
            }
        )
        admitted = {
            source["paper_id"]: {key: item for key, item in source.items() if key != SOURCE_ALIASES}
            for paper in value["papers"]
            for source in self.sources(paper)
        }
        failed = {entry["paper_id"]: entry for entry in value["failures"]}
        for entry in entries:
            current = admitted.get(entry["paper_id"], {})
            admitted[entry["paper_id"]] = {
                "saved": DeliveryItemState.PENDING,
                "library": DeliveryItemState.PENDING,
                "resource_path": "",
                "literature_id": "",
                "error": "",
                "library_error": "",
                **current,
                **entry,
            }
            failed.pop(entry["paper_id"], None)
        for failure in failures:
            if failure["paper_id"] not in admitted:
                failed[failure["paper_id"]] = failure
        distinct = {}
        for entry in admitted.values():
            identity = (*entry.get("identity", (entry["paper_id"],)), entry["revision"])
            if identity not in distinct:
                distinct[identity] = entry
            else:
                distinct[identity].setdefault(SOURCE_ALIASES, []).append(entry)
        value["papers"] = list(distinct.values())
        value["failures"] = list(failed.values())
        connection.execute(
            f"INSERT INTO {DELIVERIES_TABLE} VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
            (delivery_id, session_id, project_id, run, json.dumps(value), time.time(), time.time()),
        )
        return delivery_id
