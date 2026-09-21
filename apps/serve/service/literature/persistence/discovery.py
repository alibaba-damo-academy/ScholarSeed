"""Keyword discovery over bibliography and current PaperCard text, not receipts."""

from __future__ import annotations

from contextlib import closing
from pathlib import Path
from typing import Any

from service.literature.persistence.cards import CARD_DDL, CARD_TABLE
from service.literature.persistence.store import LITERATURE_DB, connect

TITLE_WEIGHT = 4
FIELD_WEIGHT = 1
MATCH_LIMIT = 3
EXCERPT_CHARACTERS = 360
EXCERPT_LEADING_CHARACTERS = 80
TITLE_FIELD = "title"
CARD_PREFIX = "papercard"
FIELDS_SQL = f"""
WITH fields AS (
    SELECT i.id, i.title, i.created_at, '' AS card_revision,
           f.key AS field, CAST(f.value AS TEXT) AS text
    FROM literature_items i, json_each(json_object(
        'title', i.title, 'authors', i.authors, 'publication', i.publication,
        'doi', i.doi, 'abstract', i.abstract)) f
    WHERE f.value <> ''
    UNION ALL
    SELECT i.id, i.title, i.created_at, c.revision,
           '{CARD_PREFIX}' || substr(f.fullkey, 2), CAST(f.value AS TEXT)
    FROM literature_items i
    JOIN {CARD_TABLE} c ON c.literature_id = i.id
    JOIN json_tree(json_extract(c.payload, '$.paper_card')) f
    WHERE f.type = 'text' AND f.value <> ''
      AND c.rowid = (SELECT max(latest.rowid) FROM {CARD_TABLE} latest
                     WHERE latest.literature_id = i.id)
)
"""


class LiteratureDiscovery:
    def __init__(self, database: Path | str = LITERATURE_DB) -> None:
        self.database = database

    def search(self, query: str, offset: int, limit: int) -> dict:
        terms = tuple(dict.fromkeys(query.lower().split()))
        predicates = ["instr(lower(text), ?) > 0" for _ in terms]
        matched = " OR ".join(predicates) if predicates else "field = ?"
        coverage = " AND ".join(f"max({predicate})" for predicate in predicates)
        having = f"HAVING {coverage}" if coverage else ""
        args: list[object] = list(terms) if terms else [TITLE_FIELD]
        args += [TITLE_FIELD, TITLE_FIELD, TITLE_WEIGHT, FIELD_WEIGHT]
        args += list(terms)
        args += [limit + 1, offset]
        sql = FIELDS_SQL + f""",
        matched AS (SELECT * FROM fields WHERE {matched}),
        ranked AS (
            SELECT id, max(field = ?) AS title_match,
                   sum(CASE WHEN field = ? THEN ? ELSE ? END) AS score,
                   max(created_at) AS created_at
            FROM matched GROUP BY id {having}
            ORDER BY title_match DESC, score DESC, created_at DESC, id LIMIT ? OFFSET ?
        )
        SELECT m.*, r.score FROM ranked r JOIN matched m ON m.id = r.id
        ORDER BY r.title_match DESC, r.score DESC, r.created_at DESC, r.id, m.field
        """
        with closing(connect(self.database)) as connection:
            connection.execute(CARD_DDL)
            rows = connection.execute(sql, args).fetchall()
        results: dict[str, dict[str, Any]] = {}
        for row in rows:
            item = results.setdefault(
                row["id"], {"id": row["id"], "title": row["title"], "matches": []}
            )
            if len(item["matches"]) >= MATCH_LIMIT:
                continue
            text = row["text"]
            positions = [text.lower().find(term) for term in terms if term in text.lower()]
            start = max(0, min(positions, default=0) - EXCERPT_LEADING_CHARACTERS)
            item["matches"].append(
                {
                    "field": row["field"],
                    "text": text[start : start + EXCERPT_CHARACTERS],
                    "card_revision": row["card_revision"],
                }
            )
        items = list(results.values())
        return {
            "items": items[:limit],
            "next_offset": offset + limit if len(items) > limit else None,
        }
