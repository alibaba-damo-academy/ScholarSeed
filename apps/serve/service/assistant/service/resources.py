"""AI 会话结果进入资料库的跨域编排。"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any

from service.assistant.persistence.links import (
    LINK_CONFLICT,
    LINK_INVALID,
    ArtifactLinkCatalog,
    ArtifactLinkError,
    ArtifactLinkRecord,
    LibraryDestination,
    LinkState,
)
from service.assistant.persistence.store import AssistantStore
from service.assistant.service.annotations import (
    AnswerAnnotationValidationError,
    text_revision,
    utf16_slice,
)
from service.assistant.service.citations import (
    CITATION_EVIDENCE_UNAVAILABLE,
    CitationService,
    citation_handles,
)
from service.assistant.service.links import LibraryLinkProjection
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.service.artifacts import (
    ARTIFACT_REVISION_CONFLICT,
    ArtifactReadError,
    ArtifactService,
    ResolvedArtifact,
)
from service.chat.service.attachments import AttachmentService
from service.content.domain.model import ContentError
from service.platform.bridge import ResourceImport, ResourceImportResult
from service.platform.content import ContentPort, FileAssetRef, ProjectRef
from service.platform.context import (
    AssistantAnswer,
    AssistantAnswerSource,
    AssistantTurnItem,
    ContextAuthority,
)
from service.platform.files import export_file_name
from service.resources.domain.model import (
    IMPORT_CONFLICT,
    IMPORT_UNAVAILABLE,
    MARKDOWN_SUFFIX,
    AgentImportSourceKind,
    ResourceLocationRef,
    agent_output_location,
)
from service.resources.persistence.catalog import (
    AGENT_IMPORT_SCHEMA_VERSION,
    ResourceAgentImport,
    ResourceAgentImportCatalog,
)
from service.resources.service.writer import ResourceWriter, ResourceWriterError

ASSISTANT_PROJECT_UNAVAILABLE = "assistant_project_unavailable"
ASSISTANT_PROJECT_MISMATCH = "assistant_project_mismatch"
ASSISTANT_ATTACHMENTS_UNAVAILABLE = "assistant_attachments_unavailable"
ANSWER_RESOURCE_NOT_FOUND = "answer_resource_not_found"
ANSWER_RESOURCE_RANGE_INVALID = "answer_resource_range_invalid"
ANSWER_RESOURCE_REVISION_CONFLICT = "answer_resource_revision_conflict"
ANSWER_RESOURCE_SELECTION_MISMATCH = "answer_resource_selection_mismatch"
ANSWER_SELECTION_RANGE_UNIT = "utf16_code_unit"
MARKDOWN_ARTIFACT_SUFFIXES = frozenset((MARKDOWN_SUFFIX, ".markdown"))
MARKDOWN_ARTIFACT_MEDIA_TYPES = frozenset(("text/markdown", "text/x-markdown"))
ARTIFACT_EVIDENCE_EXCERPT_MAX_CHARS = 280
ARTIFACT_EVIDENCE_TITLE = "书深 Agent 产物"
ARTIFACT_EVIDENCE_LABEL = "依据"


@dataclass(frozen=True)
class _AgentImportContext:
    """Immutable conversation and evidence snapshot captured at import time."""

    conversation: dict[str, Any] | None
    evidence_snapshot_id: str | None
    evidence: tuple[dict[str, Any], ...] | None


@dataclass(frozen=True)
class AnswerResourceSource:
    """Stable answer selection identity submitted by the Desktop."""

    answer_id: str
    answer_revision: str
    start_utf16: int
    end_utf16: int
    selected_text_hash: str


@dataclass(frozen=True)
class ResourceLibraryLink:
    record: ArtifactLinkRecord
    asset: FileAssetRef | None
    error: str = ""


class AssistantResourceError(RuntimeError):
    """从会话创建资料失败；`code` 是对前端稳定的错误码。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class AssistantResourceService:
    """把会话文本或已归属产物交给资料库 Writer。

    Session ID 用于访问控制、项目解析和安全定位会话结果。两类导入都把
    目标资料、具体来源、原问题和可选 evidence 写入同一个项目级目录表。
    """

    def __init__(
        self,
        writer: ResourceWriter,
        artifacts: ArtifactService,
        project_for_session: Callable[[str], ProjectRef | None],
        content: ContentPort,
        projection: LibraryLinkProjection,
        attachments: AttachmentService | None = None,
        *,
        events: ProductEventStore,
        assistant: AssistantStore,
        answers: AssistantAnswerSource,
        imports: ResourceAgentImportCatalog,
        citations: CitationService | None = None,
    ) -> None:
        self._writer = writer
        self._artifacts = artifacts
        self._project_for_session = project_for_session
        self._attachments = attachments
        self._content = content
        self._links = ArtifactLinkCatalog(content)
        self._projection = projection
        self._events = events
        self._assistant = assistant
        self._answers = answers
        self._imports = imports
        self._citations = citations

    def resolve_saved_citation(self, project_id: str, path: str, handle: str) -> dict:
        """Only resolve handles retained in this resource's import receipt."""
        citation = self._saved_citation(project_id, path, handle)
        result = self._citation_service().resolve_saved(citation, project_id)
        result["saved_citation"] = {"project_id": project_id, "path": path, "handle": handle}
        return result

    def saved_citation_raw(self, project_id: str, path: str, handle: str) -> bytes:
        citation = self._saved_citation(project_id, path, handle)
        return self._citation_service().saved_raw(citation)

    def saved_citation_preview(self, project_id: str, path: str, handle: str, page: int) -> bytes:
        citation = self._saved_citation(project_id, path, handle)
        return self._citation_service().saved_preview(citation, project_id, page)

    def _citation_service(self) -> CitationService:
        if self._citations is None:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        return self._citations

    def resolve_artifact_citation(
        self, session_id: str, artifact_id: str, revision: str, handle: str
    ) -> dict:
        citation, project_id = self._artifact_citation(session_id, artifact_id, revision, handle)
        result = self._citation_service().resolve_saved(citation, project_id)
        result["artifact_citation"] = {
            "session_id": session_id,
            "artifact_id": artifact_id,
            "revision": revision,
            "handle": handle,
        }
        return result

    def artifact_citation_raw(
        self, session_id: str, artifact_id: str, revision: str, handle: str
    ) -> bytes:
        citation, _ = self._artifact_citation(session_id, artifact_id, revision, handle)
        return self._citation_service().saved_raw(citation)

    def artifact_citation_preview(
        self, session_id: str, artifact_id: str, revision: str, handle: str, page: int
    ) -> bytes:
        citation, project_id = self._artifact_citation(session_id, artifact_id, revision, handle)
        return self._citation_service().saved_preview(citation, project_id, page)

    def _artifact_citation(
        self, session_id: str, artifact_id: str, revision: str, handle: str
    ) -> tuple[dict, str]:
        raw, media_type = self._artifacts.read_raw(session_id, artifact_id)
        source = self._artifacts.provenance(session_id, artifact_id)
        if (
            PurePosixPath(source.source_path).suffix.lower() not in MARKDOWN_ARTIFACT_SUFFIXES
            and media_type.split(";", 1)[0].strip().lower() not in MARKDOWN_ARTIFACT_MEDIA_TYPES
        ):
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        try:
            markdown = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE) from error
        if text_revision(markdown) != revision:
            raise AssistantResourceError(ARTIFACT_REVISION_CONFLICT)
        context = self._import_context(source.session_id, source.turn_id)
        evidence = self._citation_service().markdown_evidence(
            source.session_id, context.evidence_snapshot_id, markdown, allowed_handles=(handle,)
        )
        citation = next(
            (item.get("citation") for item in evidence if item.get("evidence_id") == handle), None
        )
        if not isinstance(citation, dict):
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        project = self._project_for_session(session_id)
        return citation, project.id if project is not None else ""

    def _saved_citation(self, project_id: str, path: str, handle: str) -> dict:
        record = self._imports.get(project_id, path)
        if record is None or self._citations is None:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        evidence = next(
            (item for item in record.evidence or () if item.get("evidence_id") == handle), None
        )
        if evidence is None:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        citation = evidence.get("citation")
        if isinstance(citation, dict):
            return citation
        if evidence.get("reason") == CITATION_EVIDENCE_UNAVAILABLE:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        # Existing receipts predate the self-contained citation metadata. Resolve
        # only their retained handle through the original answer, never arbitrary links.
        if record.source_kind != AgentImportSourceKind.ANSWER or record.source_id is None:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        answer = self._answers.answer(
            session_id=record.source_session_id, answer_id=record.source_id
        )
        if answer is None:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE)
        try:
            return self._citations.resolve(
                record.source_session_id, answer.answer_id, answer.revision, 0, 0, handle
            )
        except ValueError as error:
            raise AssistantResourceError(CITATION_EVIDENCE_UNAVAILABLE) from error

    def import_attachment(
        self,
        session_id: str,
        project_id: str,
        reference_id: str,
        location: ResourceLocationRef,
    ) -> FileAssetRef:
        """Copy a sent attachment through the existing resource writer."""
        project = self._project(session_id, project_id)
        if self._attachments is None:
            raise AssistantResourceError(ASSISTANT_ATTACHMENTS_UNAVAILABLE)
        try:
            source = self._attachments.source_path(session_id, reference_id)
            return self._writer.import_file(project.id, source, location)
        except (ArtifactReadError, ResourceWriterError) as error:
            raise AssistantResourceError(error.code) from error

    def create(
        self,
        session_id: str,
        project_id: str,
        name: str,
        content: str,
        location: ResourceLocationRef | None = None,
        *,
        source: AnswerResourceSource | None = None,
    ) -> FileAssetRef:
        """把 AI 回答内容新建为 Markdown 资料。"""

        project = self._project(session_id, project_id)
        answer = self._validated_answer(session_id, source) if source is not None else None
        captured = None
        if (
            answer is not None
            and source is not None
            and self._citations is not None
            and citation_handles(answer.markdown)
        ):
            captured = self._import_context(session_id, answer.turn_id)
            pdf_evidence = self._citations.selected_evidence(
                session_id, answer.answer_id, answer.revision, source.start_utf16, source.end_utf16
            )
            retained = tuple(
                item
                for item in captured.evidence or ()
                if not (
                    str(item.get("source_id", "")).lower().endswith(".pdf")
                    or item.get("kind") == "literature"
                )
            )
            selected = {item["evidence_id"]: item for item in pdf_evidence}
            captured = replace(
                captured,
                evidence=retained
                + tuple(
                    selected.get(item["evidence_id"], item)
                    for item in self._citations.markdown_evidence(session_id, None, content)
                )
                or None,
            )
        elif self._citations is not None and citation_handles(content):
            captured = self._import_context(session_id, answer.turn_id if answer else None)
            captured = replace(
                captured,
                evidence=(captured.evidence or ())
                + self._citations.markdown_evidence(session_id, None, content),
            )
        try:
            if location is not None:
                asset = self._writer.write_markdown(project.id, location, content)
            else:
                asset = self._writer.write_agent_output(project.id, name, content)
        except ResourceWriterError as error:
            raise AssistantResourceError(error.code) from error
        self._record_import(
            project.id,
            asset,
            source_kind=AgentImportSourceKind.ANSWER,
            context=captured,
            source_session_id=session_id,
            source_turn_id=answer.turn_id if answer is not None else None,
            source_item_id=answer.vendor_item_id if answer is not None else None,
            source_id=answer.answer_id if answer is not None else None,
            source_event_seq=answer.source_product_seq if answer is not None else None,
            source_detail=(
                {
                    "range": {
                        "unit": ANSWER_SELECTION_RANGE_UNIT,
                        "start": source.start_utf16,
                        "end": source.end_utf16,
                    }
                }
                if source is not None
                else None
            ),
        )
        return asset

    def import_artifact(
        self,
        session_id: str,
        project_id: str,
        artifact_id: str,
        expected_sha256: str | None = None,
        location: ResourceLocationRef | None = None,
        idempotency_key: str | None = None,
    ) -> FileAssetRef:
        """把一份结构化会话产物复制进资料库。"""

        project = self._project(session_id, project_id)
        return self._import_artifact(
            project, session_id, artifact_id, expected_sha256, location, idempotency_key
        )

    def import_publication(
        self, session_id: str, workdir: Path, query: ResourceImport
    ) -> ResourceImportResult:
        project = self._project(session_id, "")
        artifact_id = self._artifacts.published_artifact_id(
            session_id,
            workdir,
            artifact_id=query.artifact_id,
            path=query.path,
            expected_sha256=query.expected_sha256,
        )
        location = (
            ResourceLocationRef(parent=query.location.parent, name=query.location.name)
            if query.location is not None
            else None
        )
        asset = self._import_artifact(
            project, session_id, artifact_id, query.expected_sha256, location, query.idempotency_key
        )
        assert asset.asset_id is not None
        return ResourceImportResult(
            project_id=project.id,
            artifact_id=artifact_id,
            asset_id=asset.asset_id,
            path=asset.path,
            name=asset.name,
        )

    def _import_artifact(
        self,
        project: ProjectRef,
        session_id: str,
        artifact_id: str,
        expected_sha256: str | None,
        location: ResourceLocationRef | None,
        idempotency_key: str | None,
    ) -> FileAssetRef:
        try:
            content, name = self._artifacts.export_document_bytes(
                session_id,
                artifact_id,
                expected_sha256,
            )
            target = location or agent_output_location(name)
            source_sha256 = hashlib.sha256(content).hexdigest()
            source = self._artifacts.provenance(session_id, artifact_id)
            context = self._import_context(source.session_id, source.turn_id)
            markdown = self._artifact_markdown(source, context, content)
            if markdown is not None:
                content = markdown.encode("utf-8")
                if self._citations is not None:
                    context = replace(
                        context,
                        evidence=(context.evidence or ())
                        + self._citations.markdown_evidence(
                            source.session_id, context.evidence_snapshot_id, markdown
                        ),
                    )
            target = replace(target, name=export_file_name(target.name, source.media_type, content))
            source_key = json.dumps(
                [session_id, artifact_id, source_sha256],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            plan = self._writer.plan_import(
                (
                    hashlib.sha256(
                        json.dumps([session_id, idempotency_key]).encode("utf-8")
                    ).hexdigest()
                    if idempotency_key is not None
                    else None
                ),
                source_key,
                name,
                content,
                target,
            )
            link = self._links.reserve(
                project.id,
                session_id,
                artifact_id,
                source_sha256,
                LibraryDestination.RESOURCES,
                plan.operation_id,
                plan.fingerprint,
            )
            asset = self._writer.import_once(
                project.id,
                plan.operation_id,
                source_key,
                name,
                content,
                target,
            )
            if not asset.asset_id:
                raise ArtifactLinkError(LINK_INVALID)
            self._record_import(
                project.id,
                asset,
                source_kind=AgentImportSourceKind.ARTIFACT,
                source_session_id=source.session_id,
                source_turn_id=source.turn_id,
                source_item_id=source.item_id,
                source_id=source.artifact_id,
                source_event_seq=source.source_event_seq,
                source_detail=None,
                context=context,
                import_id=link.link_id,
            )
            link = self._links.complete(link, (asset.asset_id,))
            self._projection.project(link)
            self._artifacts.mark_saved(session_id, artifact_id, asset.path)
            return asset
        except ArtifactLinkError as error:
            # The resource API exposes one stable conflict for a reused import request.
            code = IMPORT_CONFLICT if error.code == LINK_CONFLICT else error.code
            raise AssistantResourceError(code) from error
        except (ArtifactReadError, ResourceWriterError) as error:
            raise AssistantResourceError(error.code) from error

    def _record_import(
        self,
        project_id: str,
        asset: FileAssetRef,
        *,
        source_kind: AgentImportSourceKind,
        source_session_id: str,
        source_turn_id: str | None,
        source_item_id: str | None,
        source_id: str | None,
        source_event_seq: int | None,
        source_detail: dict[str, Any] | None,
        context: _AgentImportContext | None = None,
        import_id: str | None = None,
    ) -> None:
        captured = context or self._import_context(source_session_id, source_turn_id)
        now = time.time()
        self._imports.save(
            project_id,
            ResourceAgentImport(
                import_id=import_id or uuid.uuid4().hex,
                resource_path=asset.path,
                resource_revision=None,
                source_kind=source_kind,
                source_session_id=source_session_id,
                source_turn_id=source_turn_id,
                source_item_id=source_item_id,
                source_id=source_id,
                source_event_seq=source_event_seq,
                source_detail=source_detail,
                evidence_snapshot_id=captured.evidence_snapshot_id,
                evidence=captured.evidence,
                conversation=captured.conversation,
                schema_version=AGENT_IMPORT_SCHEMA_VERSION,
                imported_at=now,
                updated_at=now,
            ),
        )

    def _import_context(
        self,
        source_session_id: str,
        source_turn_id: str | None,
    ) -> _AgentImportContext:
        conversation = self._events.user_message_for_turn(
            source_session_id,
            source_turn_id or "",
        )
        snapshot_id = self._snapshot_id(conversation)
        snapshot = (
            self._assistant.snapshot_by_id(source_session_id, snapshot_id)
            if snapshot_id is not None
            else None
        )
        evidence = (
            tuple(
                self._evidence_payload(item)
                for item in snapshot.items
                if self._used_source_evidence(item)
            )
            if snapshot is not None
            else None
        )
        return _AgentImportContext(
            conversation=self._conversation_snapshot(conversation),
            evidence_snapshot_id=snapshot_id,
            evidence=evidence or None,
        )

    def _artifact_markdown(
        self,
        source: ResolvedArtifact,
        context: _AgentImportContext,
        raw: bytes,
    ) -> str | None:
        suffix = PurePosixPath(source.source_path).suffix.lower()
        media_type = (source.media_type or "").split(";", 1)[0].strip().lower()
        if (
            suffix not in MARKDOWN_ARTIFACT_SUFFIXES
            and media_type not in MARKDOWN_ARTIFACT_MEDIA_TYPES
        ):
            return None
        try:
            body = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
        if not context.evidence:
            return body
        return f"{self._evidence_markdown(context.evidence)}\n\n{body}"

    @staticmethod
    def _used_source_evidence(item: AssistantTurnItem) -> bool:
        return (
            item.authority is ContextAuthority.SOURCE_MATERIAL
            and item.used_chars > 0
            and bool(item.excerpt_text.strip())
        )

    @classmethod
    def _evidence_markdown(cls, evidence: tuple[dict[str, Any], ...]) -> str:
        lines = [f"> **{ARTIFACT_EVIDENCE_TITLE}**", ">", f"> **{ARTIFACT_EVIDENCE_LABEL}：**"]
        for index, item in enumerate(evidence, start=1):
            label = cls._inline_markdown(item.get("label") or item.get("source_id") or index)
            source_kind = cls._inline_markdown(item.get("kind") or "")
            source_id = cls._inline_markdown(item.get("source_id") or "")
            anchor = item.get("anchor")
            locator = anchor.get("locator") if isinstance(anchor, dict) else None
            location = cls._inline_markdown(locator or source_id)
            excerpt = cls._inline_markdown(
                item.get("excerpt_text") or "",
                limit=ARTIFACT_EVIDENCE_EXCERPT_MAX_CHARS,
            )
            lines.append(f"> {index}. **{label}**")
            if source_kind:
                lines.append(f">    类型：{source_kind}")
            if location:
                lines.append(f">    位置：{location}")
            if excerpt:
                lines.append(f">    引用：{excerpt}")
        return "\n".join(lines)

    @staticmethod
    def _inline_markdown(value: object, *, limit: int | None = None) -> str:
        text = " ".join(str(value).split())
        if limit is not None and len(text) > limit:
            text = f"{text[:limit].rstrip()}…"
        for character in ("\\", "*", "_", "[", "]"):
            text = text.replace(character, f"\\{character}")
        return text

    def _validated_answer(
        self,
        session_id: str,
        source: AnswerResourceSource,
    ) -> AssistantAnswer:
        answer = self._answers.answer(session_id=session_id, answer_id=source.answer_id)
        if answer is None:
            raise AssistantResourceError(ANSWER_RESOURCE_NOT_FOUND)
        if answer.revision != source.answer_revision:
            raise AssistantResourceError(ANSWER_RESOURCE_REVISION_CONFLICT)
        try:
            selected_text = utf16_slice(answer.markdown, source.start_utf16, source.end_utf16)
        except AnswerAnnotationValidationError as error:
            raise AssistantResourceError(ANSWER_RESOURCE_RANGE_INVALID) from error
        if text_revision(selected_text) != source.selected_text_hash:
            raise AssistantResourceError(ANSWER_RESOURCE_SELECTION_MISMATCH)
        return answer

    @staticmethod
    def _snapshot_id(event: ProductEventRecord | None) -> str | None:
        if event is None:
            return None
        return str(event.payload.get("assistant_snapshot_id") or "").strip() or None

    @staticmethod
    def _conversation_snapshot(event: ProductEventRecord | None) -> dict[str, Any] | None:
        if event is None:
            return None
        return {
            "client_turn_id": str(event.payload.get("client_turn_id") or ""),
            "product_seq": event.product_seq,
            "text": str(event.payload.get("text") or ""),
        }

    @staticmethod
    def _evidence_payload(item: AssistantTurnItem) -> dict[str, Any]:
        anchor = item.ref.anchor
        return {
            "anchor": (
                {
                    "locator": dict(anchor.locator),
                    "preview_text": anchor.preview_text,
                    "selected_text_hash": anchor.selected_text_hash,
                }
                if anchor is not None
                else None
            ),
            "authority": item.authority.value,
            "evidence_id": item.evidence_id,
            "excerpt_hash": item.excerpt_hash,
            "excerpt_text": item.excerpt_text,
            "kind": item.ref.kind.value,
            "label": item.ref.label,
            "origin": item.ref.origin.value,
            "reason": item.reason,
            "retention": item.ref.retention.value,
            "source_id": item.ref.source_id,
            **({"project_id": item.ref.project_id} if item.ref.project_id else {}),
            "source_revision": item.ref.source_revision,
            "state": item.state.value,
            "surface": dict(item.surface),
            "used_chars": item.used_chars,
        }

    def _project(self, session_id: str, project_id: str) -> ProjectRef:
        session_project = self._project_for_session(session_id)
        if session_project is not None:
            if project_id and session_project.id != project_id:
                raise AssistantResourceError(ASSISTANT_PROJECT_MISMATCH)
            return session_project
        if not project_id:
            raise AssistantResourceError(ASSISTANT_PROJECT_UNAVAILABLE)
        try:
            return self._content.project(project_id)
        except ContentError as error:
            raise AssistantResourceError(ASSISTANT_PROJECT_UNAVAILABLE) from error

    def library_links(self, session_id: str) -> tuple[ResourceLibraryLink, ...]:
        """Recover persisted destination results without rereading source publications."""
        results = []
        session_project = self._project_for_session(session_id)
        projects = (session_project,) if session_project is not None else self._content.projects()
        for project in projects:
            try:
                records = self._links.list_session(project.id, session_id)
            except (ArtifactLinkError, ContentError) as error:
                raise AssistantResourceError(error.code) from error
            for record in records:
                if record.destination is not LibraryDestination.RESOURCES:
                    continue
                try:
                    if record.state is LinkState.COMPLETED:
                        # Even a now-missing target must retain its completed fact.
                        self._projection.project(record)
                    asset = self._writer.resume_import(
                        project.id, record.operation_id, record.fingerprint
                    )
                    if asset is None:
                        if record.state is LinkState.COMPLETED:
                            raise ResourceWriterError(IMPORT_UNAVAILABLE)
                        results.append(ResourceLibraryLink(record, None))
                        continue
                    if not asset.asset_id:
                        raise ArtifactLinkError(LINK_INVALID)
                    record = self._links.complete(record, (asset.asset_id,))
                    self._projection.project(record)
                    results.append(ResourceLibraryLink(record, asset))
                except (ResourceWriterError, ArtifactLinkError) as error:
                    # An unavailable target remains a saved relationship, not a new import.
                    results.append(ResourceLibraryLink(record, None, error.code))
        return tuple(results)


__all__ = [
    "ASSISTANT_PROJECT_UNAVAILABLE",
    "ASSISTANT_PROJECT_MISMATCH",
    "ASSISTANT_ATTACHMENTS_UNAVAILABLE",
    "ANSWER_RESOURCE_NOT_FOUND",
    "ANSWER_RESOURCE_RANGE_INVALID",
    "ANSWER_RESOURCE_REVISION_CONFLICT",
    "ANSWER_RESOURCE_SELECTION_MISMATCH",
    "AnswerResourceSource",
    "AssistantResourceError",
    "AssistantResourceService",
]
