from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing
from copy import deepcopy
from hashlib import sha256
from uuid import uuid4

from service.literature.domain.delivery import (
    DELIVERY_ADMISSION_FIELDS,
    DELIVERY_DESTINATION_FIELDS,
    DELIVERY_NOT_FOUND,
    FULLTEXT_BINDING_CONFLICT,
    DeliveryItemState,
    DeliveryState,
)
from service.literature.persistence.downloads import DOWNLOAD_ADMISSION_CONFLICT
from service.literature.persistence.store import connect

DELIVERIES_TABLE = "literature_deliveries"
SOURCE_ALIASES = "source_aliases"
ATTEMPT_FIELDS = ("id", "session_id", "project_id", "choice", "state", "papers")
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

    def acquisition(
        self, session_id: str, project_id: str, run: str, paper_id: str, revision: str
    ) -> dict | None:
        binding = self.bindings(session_id, project_id, run).get(paper_id)
        return binding if binding is not None and binding["revision"] == revision else None

    def source(self, session_id: str, operation_id: str) -> dict | None:
        with closing(connect()) as connection:
            self.ensure(connection)
            rows = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? ORDER BY created_at DESC",
                (session_id,),
            ).fetchall()
        return next(
            (
                paper
                for row in rows
                for current in json.loads(row["payload"])["papers"]
                for paper in self.sources(current)
                if paper.get("admission_operation") == operation_id
            ),
            None,
        )

    def by_run(self, session_id: str, run: str) -> dict:
        with closing(connect()) as connection, connection:
            self.ensure(connection)
            row = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? AND run=? "
                "ORDER BY created_at DESC, id DESC LIMIT 1",
                (session_id, run),
            ).fetchone()
        if row is None:
            raise ValueError(DELIVERY_NOT_FOUND)
        return json.loads(row["payload"])

    def get(self, session_id: str, delivery_id: str) -> dict:
        with closing(connect()) as connection, connection:
            self.ensure(connection)
            row = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? AND id=?",
                (session_id, delivery_id),
            ).fetchone()
        if row is None:
            raise ValueError(DELIVERY_NOT_FOUND)
        return json.loads(row["payload"])

    def begin(self, session_id: str, delivery_id: str, choice: dict) -> dict:
        def change(value: dict) -> None:
            previous = value["choice"]
            same_destination = previous is not None and all(
                previous.get(key) == choice.get(key) for key in DELIVERY_DESTINATION_FIELDS
            )
            resume = (
                bool(value.get("attempt_id"))
                and value["state"] in (DeliveryState.SAVING, DeliveryState.PARTIAL)
                and same_destination
                and previous is not None
                and all(previous.get(key) == choice.get(key) for key in DELIVERY_ADMISSION_FIELDS)
            )
            if not resume:
                previous_id = value.get("attempt_id") or value["id"]
                if previous is not None:
                    snapshot = deepcopy({key: value[key] for key in ATTEMPT_FIELDS})
                    snapshot["attempt_id"] = previous_id
                    value.setdefault("history", []).append(snapshot)
                value["attempt_id"] = uuid4().hex
                for paper in value["papers"]:
                    operation = (
                        paper.get("save_operation") or f'{previous_id}:{paper["paper_id"]}'
                        if same_destination
                        else f'{value["attempt_id"]}:{paper["paper_id"]}'
                    )
                    retain_saved = same_destination and paper["saved"] == DeliveryItemState.SAVED
                    paper.update(
                        saved=(
                            DeliveryItemState.SAVED if retain_saved else DeliveryItemState.PENDING
                        ),
                        resource_path=paper["resource_path"] if retain_saved else "",
                        library=DeliveryItemState.PENDING,
                        literature_id="",
                        error="",
                        library_error="",
                        save_reused=False,
                        library_reused=False,
                        versions=[],
                        save_operation=operation,
                    )
            value.update(choice=deepcopy(choice), state=DeliveryState.SAVING, prompted=True)

        return self.update(session_id, delivery_id, change)

    def update(self, session_id: str, delivery_id: str, change: Callable[[dict], None]) -> dict:
        with closing(connect()) as connection, connection:
            self.ensure(connection)
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT payload FROM {DELIVERIES_TABLE} WHERE session_id=? AND id=?",
                (session_id, delivery_id),
            ).fetchone()
            if row is None:
                raise ValueError(DELIVERY_NOT_FOUND)
            value = json.loads(row["payload"])
            change(value)
            connection.execute(
                f"UPDATE {DELIVERIES_TABLE} SET payload=?,updated_at=? WHERE id=?",
                (json.dumps(value), time.time(), delivery_id),
            )
        return value
