"""Reusable successful L1 assets, independent of visible library membership."""

from __future__ import annotations

import hashlib
import json
import re
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from service.literature.persistence.store import connect

TABLE = "literature_material_assets"
DDL = f"CREATE TABLE IF NOT EXISTS {TABLE} (revision TEXT NOT NULL, language TEXT NOT NULL, extractor TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(revision,language,extractor))"
FAILURES = "literature_material_failures"
FAILURE_DDL = f"CREATE TABLE IF NOT EXISTS {FAILURES} (id TEXT PRIMARY KEY, revision TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL)"
SOURCES = "literature_material_sources"
SOURCE_DDL = f"CREATE TABLE IF NOT EXISTS {SOURCES} (revision TEXT PRIMARY KEY, title TEXT NOT NULL, doi TEXT NOT NULL, arxiv TEXT NOT NULL, pdf BLOB NOT NULL)"


def title_key(value):
    return "".join(char.casefold() for char in value if char.isalnum())


def identifier_key(value):
    return re.sub(r"^https?://(?:dx\.)?doi.org/", "", value.strip(), flags=re.I).casefold()


class MaterialAssets:
    def __init__(self, database: Path) -> None:
        self.database = database

    def get(self, revision: str, language: str = "", extractor: str = "") -> dict | None:
        with closing(connect(self.database)) as connection:
            connection.execute(DDL)
            where, args = ["revision=?"], [revision.removeprefix("sha256:")]
            for field, value in (("language", language), ("extractor", extractor)):
                if value:
                    where.append(f"{field}=?")
                    args.append(value)
            row = connection.execute(
                f"SELECT payload FROM {TABLE} WHERE {' AND '.join(where)} ORDER BY rowid DESC LIMIT 1",
                args,
            ).fetchone()
        return json.loads(row[0]) if row else None

    def metadata(self, revision: str) -> dict | None:
        with closing(connect(self.database)) as connection:
            connection.execute(DDL)
            row = connection.execute(
                f"SELECT json_object('revision',revision, 'l1',json_object('paper_type',"
                "json_extract(payload,'$.l1.paper_type')), 'metadata',json_object('schema_version',"
                "json_extract(payload,'$.metadata.schema_version')), 'source_snapshot',"
                "json_object('source_revision',json_extract(payload,'$.source_snapshot.source_revision'))) "
                f"FROM {TABLE} WHERE revision=? ORDER BY rowid DESC LIMIT 1",
                (revision.removeprefix("sha256:"),),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, asset: dict) -> None:
        if asset.get("l1", {}).get("extraction_quality", {}).get("status") != "READY":
            raise ValueError("material_asset_not_ready")
        metadata = asset["metadata"]
        revision = asset["source_snapshot"]["source_revision"].removeprefix("sha256:")
        with closing(connect(self.database)) as connection, connection:
            connection.execute(DDL)
            connection.execute(
                f"INSERT OR IGNORE INTO {TABLE} VALUES (?,?,?,?)",
                (
                    revision,
                    asset["response_language"],
                    metadata["extractor_version"],
                    json.dumps(asset, ensure_ascii=False),
                ),
            )

    def save_failure(self, revision: str, language: str, diagnostic: dict) -> str:
        """Local-only attempt record; never returned by asset lookup or published as READY."""
        identifier = uuid4().hex
        with closing(connect(self.database)) as connection, connection:
            connection.execute(FAILURE_DDL)
            connection.execute(
                f"INSERT INTO {FAILURES} VALUES (?,?,?,?)",
                (
                    identifier,
                    revision.removeprefix("sha256:"),
                    language,
                    json.dumps(diagnostic, ensure_ascii=False),
                ),
            )
        return identifier

    def save_source(self, revision: str, paper: dict, payload: bytes) -> None:
        if hashlib.sha256(payload).hexdigest() != revision.removeprefix("sha256:"):
            raise ValueError("material_source_revision_mismatch")
        with closing(connect(self.database)) as connection, connection:
            connection.execute(SOURCE_DDL)
            connection.execute(
                f"INSERT OR IGNORE INTO {SOURCES} VALUES (?,?,?,?,?)",
                (
                    revision.removeprefix("sha256:"),
                    title_key(paper.get("title") or ""),
                    identifier_key(paper.get("doi") or ""),
                    (paper.get("arxiv_id") or paper.get("arxiv") or "").casefold(),
                    payload,
                ),
            )

    def source_for(self, paper: dict) -> bytes | None:
        doi = identifier_key(paper.get("doi") or "")
        arxiv = (paper.get("arxiv_id") or paper.get("arxiv") or "").casefold()
        if not doi and not arxiv:
            return None
        with closing(connect(self.database)) as connection:
            connection.execute(SOURCE_DDL)
            rows = connection.execute(
                f"SELECT pdf FROM {SOURCES} WHERE title=? AND ((?<>'' AND doi=?) OR (?<>'' AND arxiv=?))",
                (title_key(paper.get("title") or ""), doi, doi, arxiv, arxiv),
            ).fetchall()
        return bytes(rows[0][0]) if len(rows) == 1 else None
