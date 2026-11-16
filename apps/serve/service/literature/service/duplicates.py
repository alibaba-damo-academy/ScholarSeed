from __future__ import annotations

from service.literature.persistence import fulltexts
from service.literature.persistence.delivery import DeliveryStore
from service.literature.persistence.files import payload_revision, read_attachment
from service.literature.service.identity import paper_identity, source_identity
from service.paths import SERVICE_LITERATURE_FILES_DIR


def same_paper(first: dict, second: dict) -> bool:
    try:
        return bool(first.get("identifier") and second.get("identifier")) and paper_identity(
            first["identifier_kind"], first["identifier"]
        ) == paper_identity(second["identifier_kind"], second["identifier"])
    except ValueError:
        return False


def acquired_duplicate(paper: dict, revision: str | None = None) -> dict | None:
    candidates = list(fulltexts.fulltext_candidates())
    candidates.extend(entry for batch in DeliveryStore().candidates() for entry in batch["papers"])
    for entry in candidates:
        if not same_paper(entry, paper):
            continue
        if revision is not None:
            if entry["revision"] != revision:
                continue
        elif source_identity(entry["identifier_kind"], entry["identifier"]) != source_identity(
            paper["identifier_kind"], paper["identifier"]
        ):
            continue
        try:
            payload = read_attachment(str(SERVICE_LITERATURE_FILES_DIR / entry["object_name"]))
            if payload_revision(payload) == entry["revision"]:
                return entry
        except (OSError, ValueError):
            continue
    return None
