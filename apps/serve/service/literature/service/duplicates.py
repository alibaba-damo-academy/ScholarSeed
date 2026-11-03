from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, closing
from pathlib import PurePath

from service.content.domain.model import ContentError
from service.content.service.export import EXPORT_ENTRY_LIMIT, open_export_directory
from service.literature.domain.delivery import PDF_SUFFIX, DeliveryItemState, DeliveryTarget
from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.domain.utils import delivery_project_id
from service.literature.persistence import fulltexts
from service.literature.persistence.delivery import DeliveryStore
from service.literature.persistence.files import payload_revision, read_attachment
from service.literature.persistence.store import connect
from service.literature.schema import AttachmentRole
from service.literature.service.identifiers import extract_identifiers
from service.literature.service.identity import paper_identity, source_identity
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.content import ContentPort, RootKind
from service.platform.storage import DirectoryHandle


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


LIBRARY_IDENTIFIER_FIELDS = (("doi", "doi"), ("arxiv", "arxiv"), ("arxiv", "arxiv_id"))
DIRECTORY_DEPTH = 1
DIRECTORY_LABEL = "directory"
DIRECTORY_IDENTITY = "directory_identity"


class DeliveryDuplicates:
    def __init__(
        self,
        content: ContentPort,
        store: DeliveryStore,
        directory: Callable[[str, str, str], AbstractContextManager[DirectoryHandle]],
    ) -> None:
        self._content = content
        self._store = store
        self._directory = directory

    def project_file(self, value: dict, payload: bytes, choice: dict) -> str | None:
        parent = self._content.within_root(
            delivery_project_id(value, choice), RootKind.RESOURCES, choice["parent"]
        )
        if not self._content.exists(delivery_project_id(value, choice), parent):
            return None
        offset = 0
        while True:
            page = self._content.subtree(
                delivery_project_id(value, choice), parent, DIRECTORY_DEPTH, offset
            )
            for node in page.children:
                if PurePath(node.asset.path).suffix.casefold() != PDF_SUFFIX:
                    continue
                try:
                    existing, _ = self._content.read_bytes(
                        delivery_project_id(value, choice), node.asset.path, len(payload) + 1
                    )
                    if existing == payload:
                        return node.asset.path
                except (OSError, ValueError, RuntimeError, ContentError):
                    continue
            offset += len(page.children)
            if offset >= page.total or not page.children:
                return None

    def saved_revision(self, value: dict, paper: dict) -> str | None:
        choice = value["choice"]
        if not choice or not paper["resource_path"]:
            return None
        try:
            if choice["target"] == DeliveryTarget.PROJECT:
                payload, _ = self._content.read_bytes(
                    delivery_project_id(value), paper["resource_path"]
                )
            else:
                with closing(open_export_directory(choice[DIRECTORY_LABEL])) as directory:
                    if list(directory.identity()) != choice[DIRECTORY_IDENTITY]:
                        return None
                    if str(PurePath(paper["resource_path"]).parent) != str(directory.path):
                        return None
                    with os.fdopen(
                        directory.open_regular(PurePath(paper["resource_path"]).name), "rb"
                    ) as handle:
                        payload = handle.read(MAX_IMPORT_BYTES + 1)
                        if len(payload) > MAX_IMPORT_BYTES:
                            return None
            return payload_revision(payload)
        except (OSError, ValueError, RuntimeError, ContentError):
            return None

    @staticmethod
    def library_candidates(paper: dict, connection) -> list[dict]:
        candidates = connection.execute(
            "SELECT i.id,i.title,i.doi,i.arxiv,a.id attachment_id,a.path,a.revision "
            "FROM literature_items i LEFT JOIN literature_attachments a "
            "ON a.literature_id=i.id AND a.role=? ORDER BY i.created_at,i.id",
            (AttachmentRole.PRIMARY,),
        ).fetchall()
        metadata = paper.get("metadata") or {}
        descriptors = [paper]
        descriptors.extend(
            {"identifier_kind": kind, "identifier": metadata.get(field) or ""}
            for kind, field in LIBRARY_IDENTIFIER_FIELDS
        )
        valid = []
        for row in candidates:
            identifiers = (("doi", row["doi"]), ("arxiv", row["arxiv"]))
            if not any(
                same_paper(descriptor, {"identifier_kind": kind, "identifier": identifier})
                for descriptor in descriptors
                for kind, identifier in identifiers
            ):
                continue
            entry = {
                "literature_id": row["id"],
                "attachment_id": row["attachment_id"] or "",
                "path": row["path"] or "",
                "title": row["title"],
                "revision": "",
            }
            if row["path"]:
                try:
                    revision = payload_revision(read_attachment(row["path"]))
                    if row["revision"] and revision == row["revision"]:
                        entry["revision"] = revision
                except (OSError, ValueError):
                    pass
            valid.append(entry)
        return valid

    def target_payloads(self, value: dict, choice: dict) -> Iterator[bytes]:
        if choice["target"] == DeliveryTarget.DIRECTORY:
            with self._directory(value["session_id"], value["id"], choice["ticket"]) as directory:
                for name in sorted(directory.names(EXPORT_ENTRY_LIMIT)):
                    if PurePath(name).suffix.casefold() != PDF_SUFFIX:
                        continue
                    try:
                        with os.fdopen(directory.open_regular(name), "rb") as handle:
                            payload = handle.read(MAX_IMPORT_BYTES + 1)
                            if len(payload) <= MAX_IMPORT_BYTES:
                                yield payload
                    except OSError:
                        continue
            return
        parent = self._content.within_root(
            delivery_project_id(value, choice), RootKind.RESOURCES, choice["parent"]
        )
        if not self._content.exists(delivery_project_id(value, choice), parent):
            return
        offset = 0
        while True:
            page = self._content.subtree(
                delivery_project_id(value, choice), parent, DIRECTORY_DEPTH, offset
            )
            for node in page.children:
                if PurePath(node.asset.path).suffix.casefold() != PDF_SUFFIX:
                    continue
                try:
                    payload, _ = self._content.read_bytes(
                        delivery_project_id(value, choice), node.asset.path, MAX_IMPORT_BYTES
                    )
                    yield payload
                except (OSError, ValueError, RuntimeError, ContentError):
                    continue
            offset += len(page.children)
            if offset >= page.total or not page.children:
                return

    def versions(self, value: dict, paper: dict, choice: dict) -> list[str]:
        revisions = set()
        receipts = (
            attempt
            for batch in self._store.candidates()
            for attempt in (batch, *batch.get("history", []))
        )
        for previous in receipts:
            old_choice = previous["choice"]
            if not old_choice or old_choice["target"] != choice["target"]:
                continue
            same_target = (
                delivery_project_id(previous, old_choice) == delivery_project_id(value, choice)
                and old_choice["parent"] == choice["parent"]
                if choice["target"] == DeliveryTarget.PROJECT
                else old_choice.get(DIRECTORY_IDENTITY) == choice.get(DIRECTORY_IDENTITY)
                and old_choice.get(DIRECTORY_LABEL) == choice.get(DIRECTORY_LABEL)
            )
            if not same_target:
                continue
            for existing in previous["papers"]:
                if same_paper(paper, existing):
                    revision = self.saved_revision(previous, existing)
                    if revision:
                        revisions.add(revision)
        for payload in self.target_payloads(value, choice):
            revision = payload_revision(payload)
            if revision == paper["revision"]:
                revisions.add(revision)
                continue
            try:
                arxiv, doi = extract_identifiers(payload)
            except (RuntimeError, ValueError):
                continue
            if any(
                same_paper(paper, {"identifier_kind": kind, "identifier": identifier})
                for kind, identifier in (("arxiv", arxiv), ("doi", doi))
            ):
                revisions.add(revision)
        conflicts = revisions - {paper["revision"]} if paper["revision"] not in revisions else set()
        if choice["add_to_library"] and paper["library"] != DeliveryItemState.SKIPPED:
            with closing(connect()) as connection:
                library = {
                    entry["revision"] for entry in self.library_candidates(paper, connection)
                }
            if paper["revision"] not in library:
                conflicts.update(library - {""})
        return sorted(conflicts)
