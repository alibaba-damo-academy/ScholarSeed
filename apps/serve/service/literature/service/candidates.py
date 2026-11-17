"""Freeze project bibliography and bounded selection previews for the existing search pool."""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from hashlib import sha256
from pathlib import Path, PurePath

from service.literature.persistence.files import read_scoped_file, scoped_workspace_path
from service.literature.service.enrichment import complete_metadata
from service.literature.service.evidence import CATALOGUE_PAGE, LiteratureEvidenceService
from service.platform.storage import publish_exact_bytes

CANDIDATES_FILE = "02_retrieval/library_candidates.json"
CANDIDATES_SCHEMA = "literature-candidates/v1"
CANDIDATES_MAX_BYTES = 32 * 1024 * 1024
CANDIDATES_MODE = 0o600


@dataclass(frozen=True)
class PreparedCandidates:
    workdir: Path
    relative: str
    payload: bytes
    count: int
    scope: str
    cached: bool = False

    def publish(self) -> dict:
        publish_exact_bytes(
            self.workdir, tuple(PurePath(self.relative).parts), self.payload, CANDIDATES_MODE
        )
        return {
            "library_candidates": {
                "path": self.relative,
                "count": self.count,
                "scope": self.scope,
                "sha256": sha256(self.payload).hexdigest(),
                "model_calls": 0,
            }
        }


def prepare_candidates(
    evidence: LiteratureEvidenceService,
    project_id: str | None,
    workdir: Path,
    workspace: str,
    run_id: str,
) -> PreparedCandidates:
    relative = scoped_workspace_path(workspace, CANDIDATES_FILE)
    cached = True
    try:
        payload = read_scoped_file(workdir, relative, CANDIDATES_MAX_BYTES)
        bundle = json.loads(payload)
        if (
            not isinstance(bundle, dict)
            or not isinstance(bundle.get("sources"), list)
            or bundle.get("scope") != "project_literature"
            or bundle.get("next_offset") is not None
        ):
            raise ValueError("review_candidates_invalid")
        if (bundle.get("schema"), bundle.get("project_id"), bundle.get("run_id")) != (
            CANDIDATES_SCHEMA,
            project_id,
            run_id,
        ):
            raise ValueError("review_candidates_binding_mismatch")
    except FileNotFoundError:
        cached = False
        papers = []
        offset = 0
        # A projectless task never silently searches the personal global library.
        while project_id:
            page = evidence.catalog(project_id, offset, CATALOGUE_PAGE, view="candidates")
            papers.extend(page["sources"])
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
        bundle = {
            "schema": CANDIDATES_SCHEMA,
            "project_id": project_id,
            "run_id": run_id,
            "scope": "project_literature",
            "sources": papers,
            "next_offset": None,
        }
        payload = (json.dumps(bundle, ensure_ascii=False) + "\n").encode()
        if len(payload) > CANDIDATES_MAX_BYTES:
            raise ValueError("review_candidates_too_large")
    return PreparedCandidates(
        workdir, relative, payload, len(bundle["sources"]), bundle["scope"], cached
    )


async def complete_candidates(prepared: PreparedCandidates) -> PreparedCandidates:
    """Enrich only new snapshots, leaving saved tasks and the library untouched."""
    if prepared.cached:
        return prepared
    bundle = json.loads(prepared.payload)
    await complete_metadata(bundle["sources"])
    payload = (json.dumps(bundle, ensure_ascii=False) + "\n").encode()
    if len(payload) > CANDIDATES_MAX_BYTES:
        raise ValueError("review_candidates_too_large")
    return replace(prepared, payload=payload)
