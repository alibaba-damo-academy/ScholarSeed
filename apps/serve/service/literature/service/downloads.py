"""Admit authorized download sources as literature-owned PDF attachments."""

from __future__ import annotations

import json
import re
from contextlib import closing
from dataclasses import asdict, dataclass, replace
from functools import partial
from hashlib import sha256
from pathlib import Path
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.persistence.delivery import DeliveryStore
from service.literature.persistence.downloads import (
    DOWNLOAD_ADMISSION_CONFLICT,
    DOWNLOAD_RECEIPT_INVALID,
    DownloadReceipt,
    admit_download,
)
from service.literature.persistence.files import (
    LiteratureFileBatch,
    managed_object,
    payload_revision,
    read_attachment,
    read_scoped_file,
    scoped_relative,
)
from service.literature.persistence.store import LiteratureRepository, connect
from service.literature.schema import FulltextStatus, LiteratureItem, PublicationType, new_item_id
from service.literature.service.attachment import upload_format
from service.literature.service.duplicates import DeliveryDuplicates
from service.literature.service.fulltexts import PAPER_REF_PREFIX
from service.literature.service.identity import paper_identity
from service.literature.service.result import (
    DOWNLOAD_MANIFEST_FILE,
    DOWNLOADED_STATUS,
    MANAGED_STORAGE,
    SEARCH_CARD_PAPERS,
    SEARCH_FILE_BYTES,
    SEARCH_MAX_PAPERS,
    SEARCH_SHORT,
    SearchPaper,
    prepare_result,
    project_papers,
    project_selected_papers,
)
from service.paths import SERVICE_LITERATURE_FILES_DIR

DOWNLOADS_CARD = "literature-downloads"
DOWNLOAD_SOURCE_INVALID = "download_source_invalid"
DOWNLOAD_SOURCE_REVISION_CONFLICT = "download_source_revision_conflict"
DOWNLOAD_MANIFEST_INVALID = "download_manifest_invalid"
DOWNLOAD_METADATA_CONFLICT = "download_metadata_conflict"
PDF_FILENAME = "paper.pdf"
PDF_SUFFIX = ".pdf"
SOURCE_DOI = "doi"
SOURCE_ARXIV = "arxiv"
SOURCE_DOWNLOAD = "download"
SOURCE_METADATA = "metadata"
ADMISSION_OPERATION = "admission_operation"
ADMISSION_FINGERPRINT = "admission_fingerprint"
DOWNLOADS_VERSION: Final = "1.0"
RUN_STORAGE = "run"
DOWNLOAD_CURSOR_PATTERN = re.compile(r"([a-f0-9]{64}):([1-9][0-9]*)")
DOWNLOAD_RECEIPT_ENTRY_TOO_LARGE = "download_receipt_entry_too_large"


def download_result_bytes(result: dict) -> bytes:
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def parse_download_cursor(cursor: str) -> tuple[str, int]:
    matched = DOWNLOAD_CURSOR_PATTERN.fullmatch(cursor)
    if matched is None:
        raise ValueError(DOWNLOAD_RECEIPT_INVALID)
    return matched[1], int(matched[2])


def download_result_page(result: dict, receipt_id: str, offset: int, byte_limit: int) -> dict:
    entries = [("papers", paper) for paper in result["papers"]]
    entries.extend(("failures", failure) for failure in result["failures"])
    if offset < 0 or offset >= len(entries):
        raise ValueError(DOWNLOAD_RECEIPT_INVALID)
    page = {
        key: value
        for key, value in result.items()
        if key not in ("papers", "failures", "omitted_papers", "omitted_failures")
    }
    page.update(
        {
            "papers": [],
            "failures": [],
            "next_cursor": None,
            "total_papers": len(result["papers"]),
            "total_failures": len(result["failures"]),
        }
    )
    page_size = len(download_result_bytes(page))
    cursor_size = len(download_result_bytes({"next_cursor": None}))
    for index in range(offset, len(entries)):
        kind, entry = entries[index]
        next_cursor = (
            f"{receipt_id}:{index + 1}" if receipt_id and index + 1 < len(entries) else None
        )
        next_cursor_size = len(download_result_bytes({"next_cursor": next_cursor}))
        entry_size = len(download_result_bytes(entry))
        if page[kind]:
            entry_size += len(b",")
        candidate_size = page_size + entry_size + next_cursor_size - cursor_size
        if candidate_size > byte_limit:
            break
        page[kind].append(entry)
        page["next_cursor"] = next_cursor
        page_size = candidate_size
        cursor_size = next_cursor_size
    if not page["papers"] and not page["failures"]:
        raise ValueError(DOWNLOAD_RECEIPT_ENTRY_TOO_LARGE)
    return page


class DownloadPaperView(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    paper_id: str
    literature_id: str
    attachment_id: str
    title: str
    revision: str
    operation_id: str = ""


class DownloadFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    paper_id: str
    code: str


class DownloadCard(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["1.0"] = DOWNLOADS_VERSION
    session_id: str
    run: str
    project_id: str
    papers: list[DownloadPaperView] = Field(max_length=SEARCH_MAX_PAPERS)
    failures: list[DownloadFailure] = Field(default_factory=list, max_length=SEARCH_MAX_PAPERS)
    omitted_papers: int = Field(default=0, ge=0, le=SEARCH_MAX_PAPERS)
    omitted_failures: int = Field(default=0, ge=0, le=SEARCH_MAX_PAPERS)


def summarize_download_card(card: DownloadCard) -> DownloadCard:
    papers = card.papers[:SEARCH_CARD_PAPERS]
    failures = [
        failure.model_copy(update={"code": failure.code[:SEARCH_SHORT]})
        for failure in card.failures[:SEARCH_CARD_PAPERS]
    ]
    return card.model_copy(
        update={
            "papers": papers,
            "failures": failures,
            "omitted_papers": card.omitted_papers + len(card.papers) - len(papers),
            "omitted_failures": card.omitted_failures + len(card.failures) - len(failures),
        }
    )


def validate_download_card(value: Any) -> dict[str, Any]:
    return DownloadCard.model_validate(value).model_dump(mode="json")


def download_card_slot(value: Any) -> str:
    card = DownloadCard.model_validate(value)
    return json.dumps([card.session_id, card.run, card.project_id])


@dataclass(frozen=True)
class DownloadEntry:
    paper_id: str
    storage: str = RUN_STORAGE
    file_path: str = ""
    ref: str = ""
    revision: str = ""


@dataclass(frozen=True)
class DownloadScope:
    workdir: Path
    run: str
    run_id: str
    round: int
    metadata_sha256: str
    papers: dict[str, SearchPaper]
    identifiers: dict[str, dict[str, str]]


def prepare_download_scope(workdir: Path, run: str) -> DownloadScope:
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
    return DownloadScope(
        workdir,
        scoped_relative(run),
        prepared.card.run_id,
        prepared.card.round,
        prepared.metadata_sha256,
        {paper.id: paper for paper in papers},
        identifiers,
    )


def read_download_manifest(scope: DownloadScope) -> tuple[DownloadEntry, ...]:
    value = json.loads(
        read_scoped_file(
            scope.workdir, scoped_relative(scope.run, DOWNLOAD_MANIFEST_FILE), SEARCH_FILE_BYTES
        )
    )
    if not isinstance(value, dict) or value.get("run_id") != scope.run_id:
        raise ValueError(DOWNLOAD_MANIFEST_INVALID)
    papers = value.get("papers")
    if not isinstance(papers, list) or len(papers) > SEARCH_MAX_PAPERS:
        raise ValueError(DOWNLOAD_MANIFEST_INVALID)
    entries = []
    seen = set()
    for paper in papers:
        if not isinstance(paper, dict):
            raise ValueError(DOWNLOAD_MANIFEST_INVALID)
        if paper.get("status") != DOWNLOADED_STATUS:
            continue
        paper_id = paper.get("paper_id")
        if not isinstance(paper_id, str) or paper_id not in scope.papers or paper_id in seen:
            raise ValueError(DOWNLOAD_MANIFEST_INVALID)
        seen.add(paper_id)
        storage = paper.get("storage") or RUN_STORAGE
        if storage not in (MANAGED_STORAGE, RUN_STORAGE):
            raise ValueError(DOWNLOAD_SOURCE_INVALID)
        fields = {key: paper.get(key) or "" for key in ("file_path", "ref", "revision")}
        if any(not isinstance(field, str) for field in fields.values()):
            raise ValueError(DOWNLOAD_SOURCE_INVALID)
        entries.append(DownloadEntry(paper_id, storage=storage, **fields))
    return tuple(entries)


class DownloadAdmission:
    def __init__(self, repository: LiteratureRepository | None = None) -> None:
        self._repository = repository or LiteratureRepository()

    def admit(
        self, scope: DownloadScope, entry: DownloadEntry, session_id: str, project_id: str
    ) -> DownloadReceipt:
        paper = scope.papers.get(entry.paper_id)
        if paper is None:
            raise ValueError(DOWNLOAD_SOURCE_INVALID)
        acquired: dict | None = None
        if entry.storage == MANAGED_STORAGE:
            acquired = DeliveryStore().acquisition(
                session_id, project_id, scope.run, entry.paper_id, entry.revision
            )
            if acquired is None or entry.ref != PAPER_REF_PREFIX + entry.paper_id:
                raise ValueError(DOWNLOAD_SOURCE_INVALID)
            identities = {
                paper_identity(kind, identifier)
                for kind, identifier in (
                    (SOURCE_DOI, scope.identifiers[paper.id]["doi"]),
                    (SOURCE_ARXIV, scope.identifiers[paper.id]["arxiv_id"]),
                )
                if identifier
            }
            if (
                paper_identity(acquired["identifier_kind"], acquired["identifier"])
                not in identities
            ):
                raise ValueError(DOWNLOAD_SOURCE_INVALID)
            payload = read_attachment(str(SERVICE_LITERATURE_FILES_DIR / acquired["object_name"]))
        elif entry.storage == RUN_STORAGE:
            payload = read_scoped_file(
                scope.workdir, scoped_relative(scope.run, entry.file_path), MAX_IMPORT_BYTES
            )
        else:
            raise ValueError(DOWNLOAD_SOURCE_INVALID)
        revision = payload_revision(payload)
        if entry.revision and entry.revision != revision:
            raise ValueError(DOWNLOAD_SOURCE_REVISION_CONFLICT)
        upload_format(PDF_FILENAME, payload)
        item = LiteratureItem(
            id=new_item_id(),
            title=paper.title,
            authors="; ".join(paper.authors),
            year=paper.year,
            journal=paper.venue or "",
            venue=paper.venue or "",
            doi=paper.doi or "",
            arxiv=scope.identifiers[paper.id]["arxiv_id"],
            abstract=paper.abstract or "",
            url=paper.url or "",
        )
        operation_id = sha256(
            json.dumps([session_id, scope.run, scope.run_id, scope.round, paper.id]).encode()
        ).hexdigest()
        fingerprint = sha256(
            json.dumps([project_id, scope.metadata_sha256, revision]).encode()
        ).hexdigest()
        identifier_kind = SOURCE_DOI if item.doi else SOURCE_ARXIV
        source = {
            "paper_id": paper.id,
            "title": paper.title,
            "identifier_kind": identifier_kind,
            "identifier": item.doi or item.arxiv,
            "identity": (
                list(paper_identity(identifier_kind, item.doi or item.arxiv))
                if item.doi or item.arxiv
                else [SOURCE_DOWNLOAD, operation_id]
            ),
            "revision": revision,
            SOURCE_METADATA: asdict(item),
            ADMISSION_OPERATION: operation_id,
            ADMISSION_FINGERPRINT: fingerprint,
            "run": scope.run,
        }
        if entry.storage == MANAGED_STORAGE:
            assert acquired is not None
            source["object_name"] = acquired["object_name"]
            source["identifier_kind"] = acquired["identifier_kind"]
            source["identifier"] = acquired["identifier"]
            source["identity"] = acquired["identity"]
            with closing(connect()) as connection, connection:
                DeliveryStore().record(connection, session_id, project_id, scope.run, [source], [])
        else:
            previous = DeliveryStore().source(session_id, operation_id)
            if previous is not None and previous[ADMISSION_FINGERPRINT] != fingerprint:
                raise ValueError(DOWNLOAD_ADMISSION_CONFLICT)
            if previous is not None:
                try:
                    existing = read_attachment(
                        str(SERVICE_LITERATURE_FILES_DIR / previous["object_name"])
                    )
                except (OSError, ValueError):
                    existing = b""
                if existing and payload_revision(existing) == revision:
                    return self.admit_payload(previous, payload, session_id, project_id)
            managed = managed_object(operation_id, payload, PDF_SUFFIX)
            source["object_name"] = managed.name
            with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
                batch.stage(managed.name, payload)

                def publish_source() -> None:
                    with closing(connect()) as connection, connection:
                        DeliveryStore().record(
                            connection, session_id, project_id, scope.run, [source], []
                        )

                batch.commit_operation(publish_source)
        return self.admit_payload(source, payload, session_id, project_id)

    def admit_payload(
        self,
        source: dict,
        payload: bytes,
        session_id: str,
        project_id: str,
        *,
        restore: bool = False,
        collection_id: str = "",
    ) -> DownloadReceipt:
        revision = payload_revision(payload)
        if revision != source["revision"]:
            raise ValueError(DOWNLOAD_SOURCE_REVISION_CONFLICT)
        upload_format(PDF_FILENAME, payload)
        metadata = source.get(SOURCE_METADATA)
        item = (
            replace(
                LiteratureItem(
                    **{
                        **metadata,
                        "pubtype": PublicationType(metadata["pubtype"]),
                        "fulltext": FulltextStatus(metadata["fulltext"]),
                    }
                ),
                id=new_item_id(),
            )
            if metadata is not None
            else LiteratureItem(
                id=new_item_id(),
                title=source["title"] or source["paper_id"],
                doi=source["identifier"] if source["identifier_kind"] == SOURCE_DOI else "",
                arxiv=source["identifier"] if source["identifier_kind"] == SOURCE_ARXIV else "",
            )
        )
        operation_id = (
            source.get(ADMISSION_OPERATION)
            or sha256(
                json.dumps(
                    [session_id, project_id, source.get("run", ""), source["identity"], revision]
                ).encode()
            ).hexdigest()
        )
        fingerprint = (
            source.get(ADMISSION_FINGERPRINT)
            or sha256(json.dumps([project_id, source["identity"], revision]).encode()).hexdigest()
        )
        return admit_download(
            self._repository,
            operation_id,
            fingerprint,
            source["paper_id"],
            item,
            payload,
            project_id,
            restore=restore,
            collection_id=collection_id,
            candidates=partial(DeliveryDuplicates.library_candidates, source),
            session_id=session_id,
            run=source.get("run", ""),
        )
