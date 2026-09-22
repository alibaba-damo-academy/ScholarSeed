"""Latest successful literature AI projections in the existing literature database."""

from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path

from service.literature.persistence.store import connect

TABLE = "literature_ai_results"
SEGMENT_TABLE = "literature_ai_segments"
TRANSIENT_MODULES = frozenset(("figure_explanation",))
DOCUMENT_TRANSLATION_MODULE = "document_translation"
INTERPRETATION_KIND = "interpretation"


def merge_translation(current: dict | None, incoming: dict) -> dict:
    if not current or current.get("target_language") != incoming.get("target_language"):
        return incoming
    current = {key: value for key, value in current.items() if key != "content"}
    pages = {page["page"]: page for page in (*current.get("pages", ()), *incoming.get("pages", ()))}
    return {**current, **incoming, "pages": [pages[page] for page in sorted(pages)]}


class AnalysisStore:
    def __init__(self, database: Path) -> None:
        self.database = database
        with closing(connect(database)) as connection, connection:
            connection.execute(
                f"CREATE TABLE IF NOT EXISTS {TABLE} (literature_id TEXT, revision TEXT, module TEXT, result TEXT NOT NULL, invocation_id TEXT NOT NULL, PRIMARY KEY(literature_id,revision,module))"
            )
            connection.execute(
                f"CREATE TABLE IF NOT EXISTS {SEGMENT_TABLE} (literature_id TEXT, revision TEXT, kind TEXT, prompt_version TEXT, model_key TEXT, segment_hash TEXT, result TEXT NOT NULL, invocation_id TEXT NOT NULL, PRIMARY KEY(literature_id,revision,kind,prompt_version,model_key,segment_hash))"
            )
            connection.execute(
                f"DELETE FROM {TABLE} WHERE module IN ({','.join('?' for _ in TRANSIENT_MODULES)})",
                tuple(TRANSIENT_MODULES),
            )

    def publish(self, result: dict, invocation_id: str) -> None:
        values = result.get("modules") or {result["kind"]: result}
        with closing(connect(self.database)) as connection, connection:
            for module, content in values.items():
                if module in TRANSIENT_MODULES:
                    continue
                if module == DOCUMENT_TRANSLATION_MODULE:
                    row = connection.execute(
                        f"SELECT result FROM {TABLE} WHERE literature_id=? AND revision=? AND module=?",
                        (result["literature_id"], result["revision"], module),
                    ).fetchone()
                    previous = json.loads(row[0]) if row else None
                    content = merge_translation(previous, content)
                    result = merge_translation(previous, result)
                value = {**result, "content": content}
                connection.execute(
                    f"INSERT INTO {TABLE} VALUES (?,?,?,?,?) ON CONFLICT(literature_id,revision,module) DO UPDATE SET result=excluded.result, invocation_id=excluded.invocation_id",
                    (
                        result["literature_id"],
                        result["revision"],
                        module,
                        json.dumps(value, ensure_ascii=False),
                        invocation_id,
                    ),
                )

    def read(self, literature_id: str, revision: str) -> dict:
        with closing(connect(self.database)) as connection:
            rows = connection.execute(
                f"SELECT module,result FROM {TABLE} WHERE literature_id=? AND revision=?",
                (literature_id, revision.removeprefix("sha256:")),
            ).fetchall()
        return {row[0]: json.loads(row[1]) for row in rows}

    def read_segment(
        self,
        literature_id: str,
        revision: str,
        prompt_version: str,
        model_key: str,
        segment_hash: str,
    ) -> dict | None:
        with closing(connect(self.database)) as connection:
            row = connection.execute(
                f"SELECT result FROM {SEGMENT_TABLE} WHERE literature_id=? AND revision=? AND kind=? AND prompt_version=? AND model_key=? AND segment_hash=?",
                (
                    literature_id,
                    revision.removeprefix("sha256:"),
                    INTERPRETATION_KIND,
                    prompt_version,
                    model_key,
                    segment_hash,
                ),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def publish_segment(
        self,
        literature_id: str,
        revision: str,
        prompt_version: str,
        model_key: str,
        segment_hash: str,
        result: dict,
        invocation_id: str,
    ) -> None:
        with closing(connect(self.database)) as connection, connection:
            connection.execute(
                f"INSERT INTO {SEGMENT_TABLE} VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(literature_id,revision,kind,prompt_version,model_key,segment_hash) DO UPDATE SET result=excluded.result, invocation_id=excluded.invocation_id",
                (
                    literature_id,
                    revision.removeprefix("sha256:"),
                    INTERPRETATION_KIND,
                    prompt_version,
                    model_key,
                    segment_hash,
                    json.dumps(result, ensure_ascii=False),
                    invocation_id,
                ),
            )
