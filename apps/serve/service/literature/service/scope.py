from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from service.literature.persistence.files import read_scoped_file
from service.literature.service.result import (
    SEARCH_FILE_BYTES,
    SearchPaper,
    prepare_result,
    project_papers,
    project_selected_papers,
)

DOWNLOAD_METADATA_CONFLICT = "download_metadata_conflict"
DOWNLOAD_TURN_STALE = "download_turn_stale"


@dataclass(frozen=True)
class SelectedPaperScope:
    papers: dict[str, SearchPaper]
    identifiers: dict[str, dict[str, str]]


def prepare_selection_scope(workdir: Path, run: str) -> SelectedPaperScope:
    prepared = prepare_result(workdir, run, "selection")
    metadata_bytes = read_scoped_file(workdir, prepared.metadata_path, SEARCH_FILE_BYTES)
    if sha256(metadata_bytes).hexdigest() != prepared.metadata_sha256:
        raise ValueError(DOWNLOAD_METADATA_CONFLICT)
    if prepared.selection_path is None:
        raise ValueError(DOWNLOAD_METADATA_CONFLICT)
    selection_bytes = read_scoped_file(workdir, prepared.selection_path, SEARCH_FILE_BYTES)
    if sha256(selection_bytes).hexdigest() != prepared.selection_sha256:
        raise ValueError(DOWNLOAD_METADATA_CONFLICT)
    metadata = json.loads(metadata_bytes)
    projected_papers = project_papers(metadata["papers"])
    papers = project_selected_papers(
        projected_papers, json.loads(selection_bytes), prepared.card.run_id
    )
    identifiers = {
        paper.id: {kind: str(raw.get(kind) or "").strip() for kind in ("arxiv_id", "doi")}
        for paper, raw in zip(projected_papers, metadata["papers"], strict=True)
    }
    return SelectedPaperScope(
        {paper.id: paper for paper in papers},
        identifiers,
    )
