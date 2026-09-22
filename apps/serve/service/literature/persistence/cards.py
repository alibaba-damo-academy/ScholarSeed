"""Versioned PaperCard bundles in the existing literature database."""

from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path

from service.literature.domain.cards import normalize_bundle
from service.literature.persistence.store import LITERATURE_DB, connect

CARD_TABLE = "literature_cards"
CARD_DDL = f"CREATE TABLE IF NOT EXISTS {CARD_TABLE} (literature_id TEXT NOT NULL REFERENCES literature_items(id) ON DELETE CASCADE, revision TEXT NOT NULL, payload TEXT NOT NULL, pdf_revision TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL, PRIMARY KEY(literature_id,revision))"


class PaperCards:
    def __init__(self, database: Path | str = LITERATURE_DB) -> None:
        self.database = database

    def save(self, literature_id: str, bundle: dict, origin: str, pdf_revision: str = "") -> dict:
        normalized = normalize_bundle(bundle)
        with closing(connect(self.database)) as connection, connection:
            connection.execute(CARD_DDL)
            connection.execute(
                f"INSERT OR IGNORE INTO {CARD_TABLE} (literature_id,revision,payload,pdf_revision,origin) VALUES (?,?,?,?,?)",
                (
                    literature_id,
                    normalized["revision"],
                    json.dumps(normalized, ensure_ascii=False),
                    pdf_revision,
                    origin,
                ),
            )
        return normalized

    def get(self, literature_id: str, revision: str = "") -> dict | None:
        with closing(connect(self.database)) as connection:
            connection.execute(CARD_DDL)
            suffix = " AND revision=?" if revision else ""
            row = connection.execute(
                f"SELECT payload,pdf_revision,origin FROM {CARD_TABLE} WHERE literature_id=?{suffix} ORDER BY rowid DESC LIMIT 1",
                (literature_id, revision) if revision else (literature_id,),
            ).fetchone()
        return (
            {
                **json.loads(row["payload"]),
                "pdf_revision": row["pdf_revision"],
                "origin": row["origin"],
            }
            if row
            else None
        )

    def match_pdf(self, revision: str) -> str | None:
        with closing(connect(self.database)) as connection:
            connection.execute(CARD_DDL)
            rows = connection.execute(
                f"SELECT DISTINCT literature_id FROM {CARD_TABLE} WHERE pdf_revision=?", (revision,)
            ).fetchall()
        return rows[0][0] if len(rows) == 1 else None
