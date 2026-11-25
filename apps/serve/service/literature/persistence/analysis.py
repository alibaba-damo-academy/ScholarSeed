"""Latest successful literature AI projections in the existing literature database."""

from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path

from service.literature.domain.cards import reading_result
from service.literature.persistence.assets import MaterialAssets
from service.literature.persistence.store import chunk_ids, connect

TABLE = "literature_ai_results"
SEGMENT_TABLE = "literature_ai_segments"
JOINED_ATTEMPT_TABLE = "literature_ai_joined_attempts"
TRANSIENT_MODULES = frozenset(("figure_explanation", "formula_latex"))
DOCUMENT_TRANSLATION_MODULE = "document_translation"
INTERPRETATION_KIND = "interpretation"
L1_CHECKPOINT_VERSION = "reading/l1-checkpoint-v1"


def merge_translation(current: dict | None, incoming: dict) -> dict:
    if not current or any(
        current.get(key) != incoming.get(key)
        for key in ("target_language", "revision", "model_key", "structure_version")
    ):
        return incoming
    current = {key: value for key, value in current.items() if key != "content"}
    pages = {page["page"]: page for page in (*current.get("pages", ()), *incoming.get("pages", ()))}
    return {**current, **incoming, "pages": [pages[page] for page in sorted(pages)]}


def reading_attachments(database: Path, literature_ids: tuple[str, ...]) -> set[str]:
    """Batch presence projection for current PDF revisions, without loading evidence."""
    if not literature_ids:
        return set()
    with closing(connect(database)) as connection:
        if not connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (TABLE,)
        ).fetchone():
            return set()
        return {
            row[0]
            for chunk in chunk_ids(literature_ids)
            for row in connection.execute(
                f"SELECT a.id FROM literature_attachments a JOIN {TABLE} r "
                "ON r.literature_id=a.literature_id "
                "AND r.revision=REPLACE(a.revision,'sha256:','') "
                f"WHERE r.module=? AND a.literature_id IN ({','.join('?' for _ in chunk)})",
                ("summary", *chunk),
            )
        }


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
                f"CREATE TABLE IF NOT EXISTS {JOINED_ATTEMPT_TABLE} ("
                "owner_id TEXT NOT NULL, attempt_id TEXT NOT NULL, "
                "task_id TEXT NOT NULL, model_key TEXT NOT NULL, PRIMARY KEY(owner_id,attempt_id))"
            )
            connection.execute(
                f"DELETE FROM {TABLE} WHERE module IN ({','.join('?' for _ in TRANSIENT_MODULES)})",
                tuple(TRANSIENT_MODULES),
            )

    def joined_attempt(self, owner_id: str, attempt_id: str) -> tuple[str, str] | None:
        with closing(connect(self.database)) as connection:
            row = connection.execute(
                f"SELECT task_id,model_key FROM {JOINED_ATTEMPT_TABLE} "
                "WHERE owner_id=? AND attempt_id=?",
                (owner_id, attempt_id),
            ).fetchone()
        return (row[0], row[1]) if row else None

    def remember_joined_attempt(
        self, owner_id: str, attempt_id: str, task_id: str, model_key: str
    ) -> tuple[str, str]:
        """Persist the accepted dispatch receipt before acknowledging a join."""
        with closing(connect(self.database)) as connection, connection:
            row = connection.execute(
                f"INSERT INTO {JOINED_ATTEMPT_TABLE} (owner_id,attempt_id,task_id,model_key) "
                "VALUES (?,?,?,?) ON CONFLICT(owner_id,attempt_id) DO NOTHING "
                "RETURNING task_id,model_key",
                (owner_id, attempt_id, task_id, model_key),
            ).fetchone()
            if row is None:
                row = connection.execute(
                    f"SELECT task_id,model_key FROM {JOINED_ATTEMPT_TABLE} "
                    "WHERE owner_id=? AND attempt_id=?",
                    (owner_id, attempt_id),
                ).fetchone()
            return (row[0], row[1])

    def publish(self, result: dict, invocation_id: str) -> None:
        values = result.get("modules") or {result["kind"]: result}
        with closing(connect(self.database)) as connection, connection:
            for module, sourceContent in values.items():
                content = sourceContent
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
                    f"INSERT INTO {TABLE} (literature_id,revision,module,result,invocation_id) VALUES (?,?,?,?,?) ON CONFLICT(literature_id,revision,module) DO UPDATE SET result=excluded.result, invocation_id=excluded.invocation_id",
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
        return {row[0]: reading_result(json.loads(row[1])) for row in rows}

    def summary(self, literature_id: str, revision: str) -> dict | None:
        """Read an existing interpretation only; never schedule generation."""
        with closing(connect(self.database)) as connection:
            row = connection.execute(
                f"SELECT result FROM {TABLE} WHERE literature_id=? AND revision=? AND module=?",
                (literature_id, revision.removeprefix("sha256:"), "summary"),
            ).fetchone()
        return reading_result(json.loads(row[0])) if row else None

    def reading_l1(self, literature_id: str, revision: str, attachment_id: str) -> dict | None:
        saved = self.summary(literature_id, revision)
        if saved and saved.get("l1"):
            return saved
        saved = self.read_segment(literature_id, revision, L1_CHECKPOINT_VERSION, "", attachment_id)
        if saved:
            return saved
        with closing(connect(self.database)) as connection:
            attached = connection.execute(
                "SELECT id FROM literature_attachments WHERE id=? AND literature_id=? "
                "AND REPLACE(revision,'sha256:','')=?",
                (attachment_id, literature_id, revision.removeprefix("sha256:")),
            ).fetchone()
        if attached is None:
            return None
        cached = MaterialAssets(self.database).get(revision)
        if cached:
            # Only an explicit library attachment reaches this path. Cache writes
            # never create library rows; association follows the user's import.
            return {**cached, "literature_id": literature_id, "attachment_id": attachment_id}
        return None

    def reading_metadata(
        self, literature_id: str, revision: str, attachment_id: str
    ) -> dict | None:
        """Project saved L1 eligibility only; never deserialize evidence or PDF bytes."""
        projection = (
            "json_object('revision',json_extract(result,'$.revision'),"
            "'l1',json_object('paper_type',json_extract(result,'$.l1.paper_type')) ,"
            "'metadata',json_object('schema_version',json_extract(result,'$.metadata.schema_version')) ,"
            "'source_snapshot',json_object('source_revision',"
            "json_extract(result,'$.source_snapshot.source_revision')))"
        )
        with closing(connect(self.database)) as connection:
            row = connection.execute(
                f"SELECT {projection} FROM {TABLE} WHERE literature_id=? AND revision=? "
                "AND module=? AND json_type(result,'$.l1')='object' "
                f"UNION ALL SELECT {projection} FROM {SEGMENT_TABLE} "
                "WHERE literature_id=? AND revision=? AND kind=? AND prompt_version=? "
                "AND model_key=? AND segment_hash=? LIMIT 1",
                (
                    literature_id,
                    revision.removeprefix("sha256:"),
                    "summary",
                    literature_id,
                    revision.removeprefix("sha256:"),
                    INTERPRETATION_KIND,
                    L1_CHECKPOINT_VERSION,
                    "",
                    attachment_id,
                ),
            ).fetchone()
        if row:
            return json.loads(row[0])
        with closing(connect(self.database)) as connection:
            attached = connection.execute(
                "SELECT id FROM literature_attachments WHERE id=? AND literature_id=? "
                "AND REPLACE(revision,'sha256:','')=?",
                (attachment_id, literature_id, revision.removeprefix("sha256:")),
            ).fetchone()
        return MaterialAssets(self.database).metadata(revision) if attached else None

    def save_l1(
        self,
        literature_id: str,
        revision: str,
        attachment_id: str,
        result: dict,
        invocation_id: str,
    ) -> None:
        self.publish_segment(
            literature_id, revision, L1_CHECKPOINT_VERSION, "", attachment_id, result, invocation_id
        )

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
        return reading_result(json.loads(row[0])) if row else None

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
                f"INSERT INTO {SEGMENT_TABLE} (literature_id,revision,kind,prompt_version,model_key,segment_hash,result,invocation_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(literature_id,revision,kind,prompt_version,model_key,segment_hash) DO UPDATE SET result=excluded.result, invocation_id=excluded.invocation_id",
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
