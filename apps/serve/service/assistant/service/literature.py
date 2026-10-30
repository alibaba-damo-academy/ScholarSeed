"""Session-authorized artifact publications linked to literature-owned imports."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from service.assistant.persistence.links import (
    ArtifactLinkCatalog,
    ArtifactLinkError,
    ArtifactLinkRecord,
    LibraryDestination,
    LinkState,
)
from service.assistant.service.links import LibraryLinkProjection
from service.chat.service.artifacts import ArtifactReadError, ArtifactService
from service.content.domain.model import ContentError
from service.literature.domain.model import IMPORT_CONFLICT, LiteratureError
from service.literature.persistence.imports import ImportReceipt, LiteratureImports
from service.literature.persistence.store import load_library
from service.literature.schema import LiteratureItem
from service.literature.service.importer import import_from_bytes, plan_artifact_import
from service.platform.bridge import LiteratureImport, LiteratureImportedItem, LiteratureImportResult
from service.platform.citations import LIBRARY_REF_PREFIX
from service.platform.content import ContentPort, ProjectRef

PROJECT_UNAVAILABLE = "assistant_project_unavailable"
IMPORT_UNAVAILABLE = "literature_import_unavailable"


@dataclass(frozen=True)
class LiteratureLibraryLink:
    record: ArtifactLinkRecord
    items: tuple[LiteratureItem, ...]
    missing_ids: tuple[str, ...]
    error: str = ""


class AssistantLiteratureService:
    def __init__(
        self,
        content: ContentPort,
        artifacts: ArtifactService,
        project_for_session: Callable[[str], ProjectRef | None],
        projection: LibraryLinkProjection,
    ) -> None:
        self._content = content
        self._artifacts = artifacts
        self._project_for_session = project_for_session
        self._links = ArtifactLinkCatalog(content)
        self._projection = projection
        self._imports = LiteratureImports(content)

    def _project(self, session_id: str) -> ProjectRef:
        project = self._project_for_session(session_id)
        if project is None:
            raise ArtifactReadError(PROJECT_UNAVAILABLE)
        return project

    def import_artifact(
        self,
        session_id: str,
        artifact_id: str,
        expected_sha256: str | None = None,
        idempotency_key: str | None = None,
        collection: str = "",
        collection_id: str = "",
    ) -> ImportReceipt:
        project = self._project(session_id)
        return self._import_artifact(
            project,
            session_id,
            artifact_id,
            expected_sha256,
            idempotency_key,
            collection,
            collection_id,
        )

    def _import_artifact(
        self,
        project: ProjectRef,
        session_id: str,
        artifact_id: str,
        expected_sha256: str | None,
        idempotency_key: str | None,
        collection: str,
        collection_id: str = "",
    ) -> ImportReceipt:
        payload, name = self._artifacts.export_document_bytes(
            session_id, artifact_id, expected_sha256
        )
        source_sha256 = sha256(payload).hexdigest()
        source_key = json.dumps([session_id, artifact_id, source_sha256], ensure_ascii=False)
        operation_id = (
            sha256(json.dumps([session_id, idempotency_key]).encode()).hexdigest()
            if idempotency_key
            else None
        )
        plan = plan_artifact_import(
            source_key, name, payload, operation_id, collection, collection_id
        )
        receipt = self._imports.resume(project.id, plan.operation_id, plan.fingerprint)
        if receipt is None:
            self._imports.validate_collection_target(project.id, collection_id)
            self._imports.validate_collections(load_library(project.id), plan.outcome.items)
        link = self._links.reserve(
            project.id,
            session_id,
            artifact_id,
            source_sha256,
            LibraryDestination.LITERATURE,
            plan.operation_id,
            plan.fingerprint,
        )
        if receipt is None:
            receipt = import_from_bytes(self._content, project.id, plan, name, payload)
        link = self._links.complete(link, tuple(item.id for item in receipt.items))
        self._projection.project(link)
        return receipt

    def import_publication(
        self, session_id: str, workdir: Path, query: LiteratureImport
    ) -> LiteratureImportResult:
        project = self._project(session_id)
        artifact_id = self._artifacts.published_artifact_id(
            session_id,
            workdir,
            artifact_id=query.artifact_id,
            path=query.path,
            expected_sha256=query.expected_sha256,
        )
        receipt = self._import_artifact(
            project,
            session_id,
            artifact_id,
            query.expected_sha256,
            query.idempotency_key,
            query.collection,
        )
        return LiteratureImportResult(
            project_id=project.id,
            artifact_id=artifact_id,
            operation_id=receipt.operation_id,
            item_ids=[item.id for item in receipt.items],
            added=receipt.added,
            skipped=receipt.skipped,
            total_items=len(receipt.items),
            items=[
                LiteratureImportedItem(
                    item_id=item.id, title=item.title, ref_id=f"{LIBRARY_REF_PREFIX}{item.id}"
                )
                for item in receipt.items
            ],
        )

    def export_publication_bytes(
        self,
        session_id: str,
        workdir: Path,
        *,
        artifact_id: str | None = None,
        path: str | None = None,
        expected_sha256: str | None = None,
    ) -> tuple[bytes, str]:
        """Resolve one published session document to its exact bytes and original name.

        与 ``import_publication`` 同一套准入: 只认已发布的 artifact, 或会话工作区内的
        相对路径 (绝对路径 / 盘符 / ``..`` 一律拒), 所以 bridge 侧的工具永远拿不到用户
        磁盘上的任意文件。artifact 解析留在 assistant 层, 调用方不直接摸 ArtifactService。
        """

        resolved = self._artifacts.published_artifact_id(
            session_id,
            workdir,
            artifact_id=artifact_id,
            path=path,
            expected_sha256=expected_sha256,
        )
        return self._artifacts.export_document_bytes(session_id, resolved, expected_sha256)

    def library_links(self, session_id: str) -> tuple[LiteratureLibraryLink, ...]:
        project = self._project_for_session(session_id)
        if project is None:
            return ()
        records = self._links.list_session(project.id, session_id)
        recovered = []
        for record in records:
            if record.destination is not LibraryDestination.LITERATURE:
                continue
            try:
                receipt = self._imports.resume(
                    project.id,
                    record.operation_id,
                    record.fingerprint,
                    completed_only=record.state is LinkState.COMPLETED,
                )
                if receipt is None:
                    raise LiteratureError(IMPORT_UNAVAILABLE)
                target_ids = tuple(item.id for item in receipt.items)
                if record.state is LinkState.PENDING:
                    record = self._links.complete(record, tuple(item.id for item in receipt.items))
                elif record.target_ids != target_ids:
                    raise LiteratureError(IMPORT_CONFLICT)
                self._projection.project(record)
                recovered.append((record, ""))
            except (ContentError, LiteratureError, ArtifactLinkError) as error:
                recovered.append((record, error.code))
        current = {item.id: item for item in load_library(project.id).items}
        return tuple(
            LiteratureLibraryLink(
                record,
                tuple(
                    current[item_id]
                    for item_id in record.target_ids
                    if item_id in current and not error
                ),
                tuple(item_id for item_id in record.target_ids if item_id not in current),
                error,
            )
            for record, error in recovered
        )
