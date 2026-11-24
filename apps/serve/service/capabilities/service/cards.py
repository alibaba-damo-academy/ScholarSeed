"""Session card files, with a legacy reader until each binding is exported."""

from __future__ import annotations

import json
from collections.abc import Callable
from sqlite3 import Connection, Row
from typing import Any

from service.capabilities.service.files import (
    CARDS_DIRECTORY,
    CARDS_FILENAME,
    ComponentFiles,
    session_directory,
)

CARD_FIELDS = ("data", "state", "revision", "content_revision", "status")
CARD_FILE_VERSION = 1
CARD_STORAGE_INVALID = "component_card_storage_invalid"


class Cards:
    def __init__(self, files: ComponentFiles) -> None:
        self.files = files

    def load(self, session_id: str) -> dict[str, dict[str, Any]]:
        try:
            raw = self.files.read((CARDS_DIRECTORY, session_directory(session_id)), CARDS_FILENAME)
        except FileNotFoundError:
            return {}
        document = json.loads(raw)
        if (
            not isinstance(document, dict)
            or document.get("version") != CARD_FILE_VERSION
            or document.get("session_id") != session_id
            or not isinstance(document.get("cards"), dict)
        ):
            raise ValueError(CARD_STORAGE_INVALID)
        return document["cards"]

    def save(
        self,
        session_id: str,
        cards: dict[str, dict[str, Any]],
        checkpoint: Callable[[], None] | None = None,
    ) -> None:
        self.files.write(
            (CARDS_DIRECTORY, session_directory(session_id)),
            CARDS_FILENAME,
            json.dumps(
                {"version": CARD_FILE_VERSION, "session_id": session_id, "cards": cards},
                ensure_ascii=False,
                allow_nan=False,
            ),
            checkpoint,
        )

    def insert(self, session_id: str, binding: str, status: str) -> None:
        cards = self.load(session_id)
        cards[binding] = {
            "data": None,
            "state": {},
            "revision": 0,
            "content_revision": 0,
            "status": status,
            "copy": None,
        }
        self.save(session_id, cards)

    def read(
        self, connection: Connection, row: Row, *, cards: dict[str, dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        if row["external"]:
            records = self.load(row["session_id"]) if cards is None else cards
            data = records.get(row["binding"])
            if not isinstance(data, dict) or not data.keys() >= {*CARD_FIELDS, "copy"}:
                raise ValueError(CARD_STORAGE_INVALID)
            return data
        saved = connection.execute(
            "SELECT content FROM component_copies WHERE binding=? AND revision=?",
            (row["binding"], row["revision"]),
        ).fetchone()
        return {
            "data": json.loads(row["data"]) if row["data"] is not None else None,
            "state": json.loads(row["state"]),
            "revision": row["revision"],
            "content_revision": row["content_revision"],
            "status": row["status"],
            "copy": json.loads(saved["content"]) if saved else None,
        }

    def update(self, connection: Connection, row: Row, card: dict[str, Any]) -> None:
        if row["external"]:
            cards = self.load(row["session_id"])
            cards[row["binding"]] = card
            self.save(row["session_id"], cards)
            return
        connection.execute(
            "UPDATE component_bindings SET data=?,state=?,revision=?,content_revision=?,status=?"
            " WHERE binding=?",
            (
                _encode(card["data"]) if card["data"] is not None else None,
                _encode(card["state"]),
                card["revision"],
                card["content_revision"],
                card["status"],
                row["binding"],
            ),
        )
        if card["copy"] is None:
            connection.execute("DELETE FROM component_copies WHERE binding=?", (row["binding"],))
        else:
            connection.execute(
                "INSERT INTO component_copies(binding,revision,content) VALUES(?,?,?) "
                "ON CONFLICT(binding) DO UPDATE SET revision=excluded.revision,"
                "content=excluded.content",
                (row["binding"], card["revision"], _encode(card["copy"])),
            )

    def export(
        self, connection: Connection, batch_size: int, checkpoint: Callable[[], None]
    ) -> bool:
        first = connection.execute(
            "SELECT session_id FROM component_bindings WHERE external=0 ORDER BY rowid LIMIT 1"
        ).fetchone()
        if first is None:
            return False
        session_id = first["session_id"]
        rows = connection.execute(
            "SELECT * FROM component_bindings WHERE session_id=? AND external=0 "
            "ORDER BY rowid LIMIT ?",
            (session_id, batch_size),
        ).fetchall()
        cards = self.load(session_id)
        for row in rows:
            checkpoint()
            cards[row["binding"]] = self.read(connection, row)
        self.save(session_id, cards, checkpoint)
        bindings = [(row["binding"],) for row in rows]
        connection.executemany("DELETE FROM component_copies WHERE binding=?", bindings)
        connection.executemany(
            "UPDATE component_bindings SET external=1,data=NULL,state='{}',revision=0,"
            "content_revision=0,status='' WHERE binding=?",
            bindings,
        )
        return True


def _encode(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False)
