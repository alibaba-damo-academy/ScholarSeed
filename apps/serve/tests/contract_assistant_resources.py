"""Contract for AI conversation results entering the project resource library."""

from __future__ import annotations

import errno
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict, replace
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.assistant.api.routes import register_assistant_routes
from service.assistant.persistence.links import ArtifactLinkCatalog, ArtifactLinkError, LinkState
from service.assistant.persistence.store import AssistantStore
from service.assistant.service.annotations import text_revision
from service.assistant.service.context import AssistantService
from service.assistant.service.links import LibraryLinkProjection
from service.assistant.service.literature import AssistantLiteratureService
from service.assistant.service.resources import AssistantResourceService
from service.chat.active import RUNTIME_ID
from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
)
from service.chat.persistence.artifacts import (
    ArtifactSource,
    ArtifactStatus,
    SessionArtifactStore,
    artifact_identity,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import PRODUCT_EVENT_TABLE, ProductEventStore
from service.chat.service.answers import ProductAnswerSource
from service.chat.service.artifacts import ArtifactService
from service.chat.service.attachments import AttachmentService
from service.chat.service.publication import SessionArtifactStorage
from service.content.domain.model import ROOT_UNAVAILABLE_ERROR, ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.assets import rename_node
from service.content.service.native import (
    WINDOWS,
    copy_descriptor_exclusive,
    exchange_entries,
    publish_descriptor,
    rename_exclusive,
    set_creation_marker,
    sync_published_descriptor,
)
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.space import ProjectSpace
from service.literature.persistence.store import edit_library, load_library
from service.literature.schema import LiteratureCollection, LiteratureView
from service.paths import PROJECT_DB_RELATIVE, SESSION_ATTACHMENT_DIRNAME
from service.persistence.project import transaction
from service.platform.content import ArtifactScope, ArtifactScopeKind, AssetKind, RootKind
from service.platform.context import (
    AssistantTurnItem,
    AssistantTurnSnapshot,
    ContextAuthority,
    ContextOrigin,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ContextRetention,
    ProjectContextPolicy,
    SearchScope,
)
from service.platform.storage import NOFOLLOW, open_directory
from service.resources.api.routes import register_resource_routes
from service.resources.domain.model import AgentImportSourceKind
from service.resources.persistence.catalog import AGENT_IMPORTS_TABLE, ResourceAgentImportCatalog
from service.resources.persistence.imports import ResourceImportCatalog
from service.resources.service.writer import ResourceWriter, ResourceWriterError
from service.workbench.domain.model import WorkbenchFormatPolicy

SESSION_ID = "assistant-resource-session"
UNBOUND_SESSION_ID = "assistant-resource-unbound"
OWNER = SessionPrincipal("local")
ARTIFACT_NAME = "result.bin"
CLIENT_TURN_ID = "client-turn-contract"
SNAPSHOT_ID = "snapshot-contract"
ANSWER_TEXT = "Evidence-backed answer."
ANSWER_SELECTION = "Evidence"


class AssistantResourceContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="assistant-resource-")
        root = Path(self.temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()

        content_catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), content_catalog)
        self.project = registry.create("AI 资料接口")
        self.content = ContentService(registry, content_catalog)

        self.session_catalog = SessionCatalogStore(root / "sessions.sqlite3")
        self.runtime_workdir = root / "sessions" / SESSION_ID
        self.output_root = self.runtime_workdir / "outputs"
        self.output_root.mkdir(parents=True)
        self._register_session(SESSION_ID, self.project.root)

        unbound_root = root / "sessions" / UNBOUND_SESSION_ID
        (unbound_root / "outputs").mkdir(parents=True)
        self._register_session(UNBOUND_SESSION_ID, None)

        self.events = ProductEventStore(self.session_catalog.database)
        self.assistant_store = AssistantStore(self.session_catalog.database)
        self.assistant_store.create_snapshot(
            AssistantTurnSnapshot(
                snapshot_id=SNAPSHOT_ID,
                session_id=SESSION_ID,
                client_turn_id=CLIENT_TURN_ID,
                selection_revision=0,
                project_id=self.project.id,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                model_card_hash="model-card-contract",
                admission_hash="admission-contract",
                question_hash="question-contract",
                items=(
                    AssistantTurnItem(
                        evidence_id="e_01",
                        ref=ContextRef(
                            ref_id="ref-contract",
                            kind=ContextRefKind.FILE,
                            source_id="resources/source.md",
                            source_revision="source-revision-contract",
                            label="Source contract",
                            retention=ContextRetention.SESSION,
                            origin=ContextOrigin.EXPLICIT,
                        ),
                        state=ContextResolutionState.READY,
                        authority=ContextAuthority.SOURCE_MATERIAL,
                        excerpt_text="Evidence used for the contract turn.",
                        excerpt_hash="evidence-hash-contract",
                        used_chars=36,
                    ),
                ),
                created_at=1.5,
            )
        )
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-contract",
            vendor_item_id=CLIENT_TURN_ID,
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={
                "text": "Create the contract artifact.",
                "client_turn_id": CLIENT_TURN_ID,
                "assistant_snapshot_id": SNAPSHOT_ID,
            },
            idempotency_key="assistant-resource-user-message",
            created_at=1.75,
        )
        event = self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-contract",
            vendor_item_id="item-contract",
            kind="tool_completed",
            payload={"type": "artifact.publish", "status": "completed"},
            idempotency_key="assistant-resource-event",
            created_at=2.0,
        )
        answer_event = self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-contract",
            vendor_item_id="answer-item-contract",
            kind=PRODUCT_EVENT_MESSAGE_DELTA,
            payload={"delta": ANSWER_TEXT, "phase": "final_answer"},
            idempotency_key="assistant-resource-answer-delta",
            created_at=2.25,
        )
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-contract",
            vendor_item_id="answer-item-contract",
            kind=PRODUCT_EVENT_TURN_COMPLETED,
            payload={"stop_reason": "completed"},
            idempotency_key="assistant-resource-turn-completed",
            created_at=2.5,
        )
        self.answer_id = f"answer:{answer_event.product_seq}"
        self.artifact_path = self.output_root / ARTIFACT_NAME
        self.artifact_bytes = b"\x00\x01assistant-resource-contract\xff"
        self.artifact_path.write_bytes(self.artifact_bytes)
        self.artifact_sha256 = sha256(self.artifact_bytes).hexdigest()
        self.artifact_store = SessionArtifactStore(self.session_catalog.database)
        self.content.bind_artifact_scope(
            ArtifactScopeKind.SESSION,
            SessionArtifactStorage(self.session_catalog, root / "sessions").resolve,
        )
        captured = self.content.capture_artifact(
            ArtifactScope(ArtifactScopeKind.SESSION, SESSION_ID), f"outputs/{ARTIFACT_NAME}"
        )
        artifact_record = self.artifact_store.index(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-contract",
            vendor_item_id="item-contract",
            source_kind=ArtifactSource.ARTIFACT_PUBLISH,
            source_product_seq=event.product_seq,
            original_path=f"outputs/{ARTIFACT_NAME}",
            canonical_path=str(self.artifact_path),
            role="final",
            status=ArtifactStatus.PUBLISHED,
            mime_type="application/octet-stream",
            content_sha256=self.artifact_sha256,
            size_bytes=len(self.artifact_bytes),
            metadata={"label": ARTIFACT_NAME, "content": asdict(captured)},
            idempotency_key="assistant-resource-artifact",
            created_at=3.0,
        )
        self.artifact_id = artifact_identity(artifact_record)
        self.artifact_reader = ArtifactService(
            self.session_catalog,
            self.artifact_store,
            self.events,
            WorkbenchFormatPolicy(),
        )
        self.artifact_reader.bind_content(self.content)
        self.agent_imports = ResourceAgentImportCatalog(self.content)

        def project_for_session(session_id: str):
            record = self.session_catalog.get(session_id)
            if record is None or not record.project_path:
                return None
            return self.content.project_for_path(record.project_path)

        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.session_catalog
        app.state.assistant = AssistantService(self.assistant_store)
        app.state.content = self.content
        app.state.resource_agent_imports = self.agent_imports
        app.state.assistant_resources = AssistantResourceService(
            ResourceWriter(self.content),
            self.artifact_reader,
            project_for_session,
            self.content,
            LibraryLinkProjection(self.content, self.session_catalog, self.events),
            AttachmentService(self.session_catalog, self.events),
            events=self.events,
            assistant=self.assistant_store,
            answers=ProductAnswerSource(self.events),
            imports=self.agent_imports,
        )
        app.state.assistant_literature = AssistantLiteratureService(
            self.content,
            self.artifact_reader,
            project_for_session,
            LibraryLinkProjection(self.content, self.session_catalog, self.events),
        )
        register_assistant_routes(app)
        register_resource_routes(app)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _register_session(self, session_id: str, project_path: str | None) -> None:
        runtime_workdir = self.session_catalog.database.parent / "sessions" / session_id
        self.session_catalog.register(
            session_id,
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{session_id}",
            vendor_session_id=None,
            runtime_workdir=str(runtime_workdir),
            project_path=project_path,
            output_root=str(runtime_workdir / "outputs"),
            codex_version="contract",
            model_id="contract-model",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=1.0,
        )

    def _publish_artifact(
        self,
        name: str,
        payload: bytes,
        media_type: str,
        *,
        turn_id: str = "turn-contract",
    ) -> tuple[str, Path]:
        path = self.output_root / name
        path.write_bytes(payload)
        event = self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id=turn_id,
            vendor_item_id=f"item-{name}",
            kind="tool_completed",
            payload={"type": "artifact.publish", "status": "completed"},
            idempotency_key=f"assistant-resource-event-{name}",
        )
        captured = self.content.capture_artifact(
            ArtifactScope(ArtifactScopeKind.SESSION, SESSION_ID), f"outputs/{name}"
        )
        record = self.artifact_store.index(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id=turn_id,
            vendor_item_id=f"item-{name}",
            source_kind=ArtifactSource.ARTIFACT_PUBLISH,
            source_product_seq=event.product_seq,
            original_path=f"outputs/{name}",
            canonical_path=str(path),
            role="final",
            status=ArtifactStatus.PUBLISHED,
            mime_type=media_type,
            content_sha256=sha256(payload).hexdigest(),
            size_bytes=len(payload),
            metadata={"label": name, "content": asdict(captured)},
            idempotency_key=f"assistant-resource-artifact-{name}",
        )
        return artifact_identity(record), path

    def sent_attachment(self, path: Path, *, local: bool = False) -> str:
        path = path.resolve()
        reference_id = "sent-attachment"
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="attachment-turn",
            vendor_item_id="attachment-message",
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={
                "text": "read this",
                "refs": [
                    {
                        "type": "file",
                        "id": reference_id,
                        "title": path.name,
                        "path": str(path),
                        "sha256": sha256(path.read_bytes()).hexdigest(),
                        "origin": PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE if local else "",
                    }
                ],
            },
            idempotency_key="sent-attachment-event",
        )
        return reference_id

    def import_attachment(self, reference_id: str):
        return self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/attachment",
            json={
                "reference_id": reference_id,
                "location": {
                    "parent": "附件归档",
                    "name": "实验报告.v2.pdf",
                },
            },
        )

    def test_import_sent_upload_preserves_bytes_and_original(self) -> None:
        path = self.runtime_workdir / SESSION_ATTACHMENT_DIRNAME / "upload.pdf"
        path.parent.mkdir()
        path.write_bytes(self.artifact_bytes)
        result = self.import_attachment(self.sent_attachment(path))
        self.assertEqual(result.status_code, 200, result.text)
        saved, _ = self.content.read_bytes(self.project.id, result.json()["node"]["path"])
        self.assertEqual(saved, self.artifact_bytes)
        self.assertEqual(path.read_bytes(), self.artifact_bytes)
        self.assertEqual(result.json()["node"]["name"], "实验报告.v2.pdf")

    def test_import_sent_local_file_works_without_live_session(self) -> None:
        path = Path(self.temporary.name) / "local.pdf"
        path.write_bytes(self.artifact_bytes)
        result = self.import_attachment(self.sent_attachment(path, local=True))
        self.assertEqual(result.status_code, 200, result.text)

    def test_import_rejects_unsent_cross_session_and_missing_attachment(self) -> None:
        path = self.runtime_workdir / SESSION_ATTACHMENT_DIRNAME / "upload.pdf"
        path.parent.mkdir()
        path.write_bytes(self.artifact_bytes)
        self.assertNotEqual(self.import_attachment(str(path)).status_code, 200)
        reference = self.sent_attachment(path)
        path.unlink()
        result = self.import_attachment(reference)
        self.assertNotEqual(result.status_code, 200)
        self.assertEqual(result.json()["detail"], "session_attachment_not_found")
        with self.assertRaisesRegex(Exception, "session_attachment_not_found"):
            AttachmentService(self.session_catalog, self.events).source_path(
                UNBOUND_SESSION_ID, reference
            )

    def test_import_rejects_changed_attachment(self) -> None:
        path = Path(self.temporary.name) / "local.pdf"
        path.write_bytes(self.artifact_bytes)
        reference = self.sent_attachment(path, local=True)
        path.write_bytes(b"changed")
        result = self.import_attachment(reference)
        self.assertNotEqual(result.status_code, 200)
        self.assertEqual(result.json()["detail"], "session_attachment_changed")

    def test_create_writes_complete_markdown_under_resource_root(self) -> None:
        body = "# AI 摘录\n\n由单次业务请求完整创建。\n"
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/create"

        first = self.client.post(endpoint, json={"name": "研究结论", "content": body})
        second = self.client.post(endpoint, json={"name": "研究结论", "content": body})

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["node"]["path"], "resources/ai_extracts/研究结论.md")
        self.assertEqual(second.json()["node"]["path"], "resources/ai_extracts/研究结论 (2).md")
        target = Path(self.project.root) / first.json()["node"]["path"]
        self.assertEqual(target.read_text(encoding="utf-8"), body)
        provenance = self.agent_imports.get(self.project.id, first.json()["node"]["path"])
        self.assertIsNotNone(provenance)
        assert provenance is not None
        self.assertEqual(provenance.source_kind, AgentImportSourceKind.ANSWER)
        self.assertIsNone(provenance.source_id)

    def test_answer_selection_and_artifact_share_one_provenance_table(self) -> None:
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/create",
            json={
                "name": "回答摘录",
                "content": f"# 回答摘录\n\n{ANSWER_SELECTION}\n",
                "source": {
                    "answer_id": self.answer_id,
                    "answer_revision": text_revision(ANSWER_TEXT),
                    "start_utf16": 0,
                    "end_utf16": len(ANSWER_SELECTION),
                    "selected_text_hash": text_revision(ANSWER_SELECTION),
                },
                "location": {"parent": "研究设计/结论", "name": "低仰角结论"},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["node"]["path"],
            "resources/研究设计/结论/低仰角结论.md",
        )
        provenance = self.agent_imports.get(self.project.id, response.json()["node"]["path"])
        self.assertIsNotNone(provenance)
        assert provenance is not None
        self.assertEqual(provenance.source_kind, AgentImportSourceKind.ANSWER)
        self.assertEqual(provenance.source_id, self.answer_id)
        self.assertEqual(provenance.source_turn_id, "turn-contract")
        self.assertEqual(provenance.source_item_id, "answer-item-contract")
        self.assertIsNotNone(provenance.source_detail)
        self.assertIsNotNone(provenance.evidence)
        assert provenance.source_detail is not None
        assert provenance.evidence is not None
        self.assertEqual(provenance.source_detail["range"]["start"], 0)
        self.assertEqual(provenance.evidence_snapshot_id, SNAPSHOT_ID)
        self.assertEqual(provenance.evidence[0]["evidence_id"], "e_01")
        origin = self.client.get(
            "/api/resource/agent-origin",
            params={"project": self.project.id, "path": response.json()["node"]["path"]},
        )
        self.assertEqual(origin.status_code, 200, origin.text)
        self.assertEqual(
            origin.json(),
            {
                "source_kind": "answer",
                "session_id": SESSION_ID,
                "turn_id": "turn-contract",
                "item_id": "answer-item-contract",
                "source_range": {
                    "unit": "utf16_code_unit",
                    "start": 0,
                    "end": len(ANSWER_SELECTION),
                },
            },
        )

    def test_create_accepts_resource_relative_target_and_creates_parent(self) -> None:
        body = "# 指定目录的回答摘录\n"
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/create",
            json={
                "name": "回答摘录",
                "content": body,
                "location": {"parent": "研究设计/本次新建", "name": "低仰角结论"},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["node"]["path"],
            "resources/研究设计/本次新建/低仰角结论.md",
        )
        target = Path(self.project.root) / response.json()["node"]["path"]
        self.assertEqual(target.read_text(encoding="utf-8"), body)

    def test_import_copies_exact_session_artifact_bytes(self) -> None:
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={"artifact_id": self.artifact_id},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["node"]["path"], f"resources/ai_extracts/{ARTIFACT_NAME}")
        imported = Path(self.project.root) / response.json()["node"]["path"]
        self.assertEqual(imported.read_bytes(), self.artifact_bytes)
        self.assertEqual(self.artifact_path.read_bytes(), self.artifact_bytes)
        provenance = self.agent_imports.get(self.project.id, response.json()["node"]["path"])
        self.assertIsNotNone(provenance)
        assert provenance is not None
        self.assertEqual(provenance.source_session_id, SESSION_ID)
        self.assertEqual(provenance.source_kind, AgentImportSourceKind.ARTIFACT)
        self.assertEqual(provenance.source_turn_id, "turn-contract")
        self.assertEqual(provenance.source_item_id, "item-contract")
        self.assertEqual(provenance.source_id, self.artifact_id)
        self.assertEqual(provenance.evidence_snapshot_id, SNAPSHOT_ID)
        self.assertIsNotNone(provenance.conversation)
        self.assertIsNotNone(provenance.evidence)
        assert provenance.conversation is not None
        assert provenance.evidence is not None
        self.assertEqual(provenance.conversation["text"], "Create the contract artifact.")
        self.assertEqual(provenance.evidence[0]["evidence_id"], "e_01")
        self.assertNotIn("source_artifact_sha256", provenance.__dataclass_fields__)
        origin = self.client.get(
            "/api/resource/agent-origin",
            params={"project": self.project.id, "path": response.json()["node"]["path"]},
        )
        self.assertEqual(origin.status_code, 200, origin.text)
        self.assertEqual(origin.json()["source_kind"], "artifact")
        self.assertEqual(origin.json()["session_id"], SESSION_ID)
        self.assertEqual(origin.json()["turn_id"], "turn-contract")
        self.assertEqual(origin.json()["item_id"], "item-contract")
        located = self.content.locate(self.project.id, RootKind.RESOURCES, str(imported))
        self.assertIsNotNone(located)
        self.assertEqual(located.path if located else None, response.json()["node"]["path"])

        repeated = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={"artifact_id": self.artifact_id},
        )
        current = self.artifact_store.list_session(SESSION_ID)[0]
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["node"]["path"], response.json()["node"]["path"])
        self.assertEqual(current.saved_to, response.json()["node"]["path"])
        self.assertFalse(imported.with_name(f"{imported.stem} (2){imported.suffix}").exists())

    def test_markdown_artifact_writes_used_evidence_before_original_content(self) -> None:
        original = "# Contract report\n\nOriginal artifact body.\n"
        artifact_id, source = self._publish_artifact(
            "contract-report.md",
            original.encode("utf-8"),
            "text/markdown",
        )

        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={
                "artifact_id": artifact_id,
                "location": {"parent": "阶段成果", "name": "报告"},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        imported = Path(self.project.root) / response.json()["node"]["path"]
        body = imported.read_text(encoding="utf-8")
        self.assertTrue(body.startswith("> **书深 Agent 产物**\n>\n> **依据：**"))
        self.assertIn("> 1. **Source contract**", body)
        self.assertIn(">    类型：file", body)
        self.assertIn(">    位置：resources/source.md", body)
        self.assertIn(">    引用：Evidence used for the contract turn.", body)
        self.assertTrue(body.endswith(original))
        self.assertEqual(source.read_text(encoding="utf-8"), original)

        original_node = response.json()["node"]
        provenance = self.agent_imports.get(self.project.id, original_node["path"])
        source.write_text("changed working file", encoding="utf-8")
        renamed = self.client.post(
            "/api/resource/node",
            json={
                "action": "rename",
                "project": self.project.id,
                "path": original_node["path"],
                "name": "renamed.md",
            },
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        repeated = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={"artifact_id": artifact_id, "location": {"parent": "阶段成果", "name": "报告"}},
        )
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["node"]["assetId"], original_node["assetId"])
        self.assertEqual(repeated.json()["node"]["path"], "resources/阶段成果/renamed.md")
        current_origin = self.agent_imports.get(self.project.id, repeated.json()["node"]["path"])
        self.assertEqual(current_origin.import_id, provenance.import_id)
        self.assertEqual(current_origin.evidence, provenance.evidence)
        self.assertEqual(
            (Path(self.project.root) / repeated.json()["node"]["path"]).read_text(), body
        )

    def test_agent_origin_follows_renamed_and_moved_parent_directory(self) -> None:
        imported = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={
                "artifact_id": self.artifact_id,
                "location": {"parent": "阶段成果/待归档", "name": "结果"},
            },
        )
        self.assertEqual(imported.status_code, 200, imported.text)
        original_path = imported.json()["node"]["path"]

        renamed = self.client.post(
            "/api/resource/node",
            json={
                "action": "rename",
                "project": self.project.id,
                "path": "resources/阶段成果",
                "name": "阶段结果",
            },
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        renamed_path = "resources/阶段结果/待归档/结果.bin"
        self.assertIsNone(self.agent_imports.get(self.project.id, original_path))
        self.assertIsNotNone(self.agent_imports.get(self.project.id, renamed_path))

        self.content.create(self.project.id, "resources", "最终归档", AssetKind.DIR)
        moved = self.client.post(
            "/api/resource/node",
            json={
                "action": "move",
                "project": self.project.id,
                "path": "resources/阶段结果",
                "target_dir": "最终归档",
            },
        )
        self.assertEqual(moved.status_code, 200, moved.text)
        moved_path = "resources/最终归档/阶段结果/待归档/结果.bin"
        self.assertIsNone(self.agent_imports.get(self.project.id, renamed_path))
        self.assertIsNotNone(self.agent_imports.get(self.project.id, moved_path))
        origin = self.client.get(
            "/api/resource/agent-origin",
            params={"project": self.project.id, "path": moved_path},
        )
        self.assertEqual(origin.status_code, 200, origin.text)
        self.assertEqual(origin.json()["session_id"], SESSION_ID)

    def test_agent_origin_is_absent_for_an_ordinary_resource(self) -> None:
        created = self.content.create_text(
            self.project.id,
            "resources",
            "ordinary.md",
            "ordinary",
        )
        response = self.client.get(
            "/api/resource/agent-origin",
            params={"project": self.project.id, "path": created.path},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json())

    def bibliography_artifact(self) -> str:
        path = self.output_root / "references.bib"
        payload = b"@article{a,title={First example},year={2026}}\n@article{b,title={Second example},year={2026}}"
        path.write_bytes(payload)
        captured = self.content.capture_artifact(
            ArtifactScope(ArtifactScopeKind.SESSION, SESSION_ID), "outputs/references.bib"
        )
        event = self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-literature",
            vendor_item_id="item-literature",
            kind="tool_completed",
            payload={},
            idempotency_key="bibliography-source-event",
        )
        record = SessionArtifactStore(self.session_catalog.database).index(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-literature",
            vendor_item_id="item-literature",
            source_kind=ArtifactSource.ARTIFACT_PUBLISH,
            source_product_seq=event.product_seq,
            original_path="outputs/references.bib",
            canonical_path=str(path),
            role="final",
            status=ArtifactStatus.PUBLISHED,
            mime_type="text/plain",
            content_sha256=sha256(payload).hexdigest(),
            size_bytes=len(payload),
            metadata={"label": path.name, "content": asdict(captured)},
            idempotency_key="bibliography-publication",
            created_at=4.0,
        )
        return artifact_identity(record)

    def working_artifact(self, name: str, payload: bytes, mime_type: str) -> str:
        path = self.output_root / name
        path.write_bytes(payload)
        event = self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-working",
            vendor_item_id="item-working",
            kind="file_changed",
            payload={"change": "update", "path": f"outputs/{name}"},
            idempotency_key=f"working-source:{name}",
        )
        record = self.artifact_store.index(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-working",
            vendor_item_id="item-working",
            source_kind=ArtifactSource.FILE_CHANGE,
            source_product_seq=event.product_seq,
            original_path=f"outputs/{name}",
            canonical_path=str(path),
            role="intermediate",
            status=ArtifactStatus.COMPLETED,
            mime_type=mime_type,
            content_sha256=sha256(payload).hexdigest(),
            size_bytes=len(payload),
            metadata={"change": "update"},
            idempotency_key=f"working-record:{name}",
        )
        return artifact_identity(record)

    def test_edited_working_artifact_imports_current_bytes_to_resources(self) -> None:
        before = b"before edit\n"
        after = b"after edit\n"
        artifact_id = self.working_artifact("editable.txt", before, "text/plain")
        receipt = self.artifact_reader.write_raw(
            SESSION_ID,
            artifact_id,
            after,
            f"sha256:{sha256(before).hexdigest()}",
        )

        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={
                "artifact_id": artifact_id,
                "expected_sha256": receipt.revision.removeprefix("sha256:"),
                "location": {"parent": "编辑后产物", "name": "editable.txt"},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        imported = Path(self.project.root) / response.json()["node"]["path"]
        self.assertEqual(imported.read_bytes(), after)

    def test_edited_working_bibliography_imports_current_bytes_to_literature(self) -> None:
        before = b"@article{a,title={Before edit},year={2026}}"
        after = b"@article{a,title={After edit},year={2026}}"
        artifact_id = self.working_artifact("editable.bib", before, "text/plain")
        receipt = self.artifact_reader.write_raw(
            SESSION_ID,
            artifact_id,
            after,
            f"sha256:{sha256(before).hexdigest()}",
        )

        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/literature/import",
            json={
                "artifact_id": artifact_id,
                "expected_sha256": receipt.revision.removeprefix("sha256:"),
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["added"], 1)
        self.assertEqual(load_library(self.project.id).items[0].title, "After edit")

    def test_literature_publication_import_links_every_record_and_never_resurrects(self) -> None:
        artifact_id = self.bibliography_artifact()
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/literature/import"
        response = self.client.post(endpoint, json={"artifact_id": artifact_id})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["added"], 2)
        self.assertEqual(len(response.json()["item_ids"]), 2)
        self.assertEqual(len(load_library(self.project.id).items), 2)
        self.assertEqual(
            self.client.post(endpoint, json={"artifact_id": artifact_id}).json(), response.json()
        )
        with edit_library(self.project.id) as edit:
            edit.view = LiteratureView()
        links = self.client.get(f"/api/assistant/sessions/{SESSION_ID}/literature/links")
        self.assertEqual(links.status_code, 200, links.text)
        link = links.json()["links"][0]
        self.assertEqual(link["state"], "completed")
        self.assertEqual(link["items"], [])
        self.assertEqual(link["missing_ids"], response.json()["item_ids"])
        self.assertEqual(
            self.client.post(endpoint, json={"artifact_id": artifact_id}).json(), response.json()
        )
        self.assertEqual(load_library(self.project.id).items, ())

    def test_literature_routes_require_session_before_source_or_destination_access(self) -> None:
        with patch.object(
            self.content, "project_for_path", side_effect=AssertionError("no project access")
        ):
            imported = self.client.post(
                "/api/assistant/sessions/missing/literature/import",
                json={"artifact_id": self.artifact_id},
            )
            links = self.client.get("/api/assistant/sessions/missing/literature/links")
        self.assertEqual(imported.status_code, 404)
        self.assertEqual(links.status_code, 404)

    def test_literature_invalid_format_does_not_reserve_link(self) -> None:
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/literature/import",
            json={"artifact_id": self.artifact_id},
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"], "unsupported_format")
        self.assertEqual(
            ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID), ()
        )

    def test_literature_import_appends_and_replays_only_with_idempotency_key(self) -> None:
        with edit_library(self.project.id) as edit:
            edit.view = LiteratureView(
                collections=(LiteratureCollection("教学", 0), LiteratureCollection("其他", 0))
            )
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/literature/import"
        artifact_id = self.bibliography_artifact()
        first = self.client.post(endpoint, json={"artifact_id": artifact_id, "collection": "教学"})
        self.assertEqual(first.status_code, 200, first.text)
        second = self.client.post(endpoint, json={"artifact_id": artifact_id, "collection": "其他"})
        self.assertEqual(second.status_code, 200, second.text)
        # 文献库不做重复判定（proposal 91）：同一份产物再入库是新增一批，
        # 且第一批的分类归属不会被后来的导入改写。
        self.assertEqual(second.json()["added"], 2)
        self.assertFalse(set(first.json()["item_ids"]) & set(second.json()["item_ids"]))
        items = {item.id: item for item in load_library(self.project.id).items}
        self.assertEqual(len(items), 4)
        for item_id in first.json()["item_ids"]:
            self.assertEqual(items[item_id].collection, "教学")
        for item_id in second.json()["item_ids"]:
            self.assertEqual(items[item_id].collection, "其他")
        # 只有调用方显式声明幂等键时，重放才复用同一份收据而不再追加。
        keyed = {"artifact_id": artifact_id, "idempotency_key": "retry-once"}
        third = self.client.post(endpoint, json=keyed)
        self.assertEqual(third.status_code, 200, third.text)
        replay = self.client.post(endpoint, json=keyed)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json(), third.json())
        self.assertEqual(len(load_library(self.project.id).items), 6)

    def test_missing_literature_import_collection_does_not_reserve_link(self) -> None:
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/literature/import",
            json={"artifact_id": self.bibliography_artifact(), "collection": "不存在"},
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"], "literature_import_collection_unavailable")
        self.assertEqual(
            ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID), ()
        )

    def test_literature_revision_conflict_does_not_reserve_link(self) -> None:
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/literature/import",
            json={"artifact_id": self.bibliography_artifact(), "expected_sha256": "0" * 64},
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(
            ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID), ()
        )

    def test_literature_completed_links_do_not_read_source_again(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/literature"
        response = self.client.post(
            endpoint + "/import", json={"artifact_id": self.bibliography_artifact()}
        )
        self.assertEqual(response.status_code, 200, response.text)
        with patch.object(
            ArtifactService, "export_bytes", side_effect=AssertionError("no source access")
        ):
            links = self.client.get(endpoint + "/links")
        self.assertEqual(links.status_code, 200, links.text)
        self.assertIsNone(links.json()["links"][0]["error"])
        self.assertEqual(len(links.json()["links"][0]["items"]), 2)

    def test_literature_link_receipt_mismatch_is_not_displayed_as_valid(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/literature"
        response = self.client.post(
            endpoint + "/import", json={"artifact_id": self.bibliography_artifact()}
        )
        self.assertEqual(response.status_code, 200, response.text)
        # A valid but incomplete target list must still match the whole owner receipt.
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            connection.execute(
                "UPDATE assistant_artifact_links SET target_ids = ?",
                (json.dumps(response.json()["item_ids"][:1]),),
            )
        links = self.client.get(endpoint + "/links")
        self.assertEqual(links.status_code, 200, links.text)
        self.assertEqual(links.json()["links"][0]["error"], "literature_import_conflict")
        self.assertEqual(links.json()["links"][0]["items"], [])

    def test_one_unreserved_literature_link_does_not_hide_completed_links(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/literature"
        artifact_id = self.bibliography_artifact()
        response = self.client.post(endpoint + "/import", json={"artifact_id": artifact_id})
        self.assertEqual(response.status_code, 200, response.text)
        catalog = ArtifactLinkCatalog(self.content)
        original = catalog.list_session(self.project.id, SESSION_ID)[0]
        catalog.reserve(
            self.project.id,
            SESSION_ID,
            artifact_id,
            original.source_sha256,
            original.destination,
            "interrupted-before-owner-reservation",
            "1" * 64,
        )
        links = self.client.get(endpoint + "/links")
        self.assertEqual(links.status_code, 200, links.text)
        records = links.json()["links"]
        self.assertEqual(len(records), 2)
        valid = next(record for record in records if record["link_id"] == original.link_id)
        self.assertIsNone(valid["error"])
        self.assertEqual(len(valid["items"]), 2)
        pending = next(record for record in records if record["link_id"] != original.link_id)
        self.assertEqual(pending["error"], "literature_import_unavailable")
        self.assertEqual(pending["state"], "pending")

    def test_import_accepts_resource_relative_target_and_expected_sha(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        response = self.client.post(
            endpoint,
            json={
                "artifact_id": self.artifact_id,
                "expected_sha256": self.artifact_sha256,
                "location": {"parent": "阶段成果", "name": "原始数据"},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["node"]["path"],
            "resources/阶段成果/原始数据.bin",
        )
        imported = Path(self.project.root) / response.json()["node"]["path"]
        self.assertEqual(imported.read_bytes(), self.artifact_bytes)

    def test_artifact_import_commits_one_durable_library_link(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        payload = {"artifact_id": self.artifact_id}
        first = self.client.post(endpoint, json=payload)
        repeated = self.client.post(endpoint, json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(repeated.json(), first.json())
        links = ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID)
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0].artifact_id, self.artifact_id)
        self.assertEqual(links[0].source_sha256, self.artifact_sha256)
        self.assertEqual(links[0].state, LinkState.COMPLETED)
        self.assertEqual(links[0].target_ids, (first.json()["node"]["assetId"],))
        self.assertTrue(links[0].projected)
        linked = [
            event
            for event in self.events.replay(SESSION_ID)
            if event.kind == "artifact_library_linked"
        ]
        self.assertEqual(len(linked), 1)
        self.assertEqual(linked[0].payload["target_ids"], list(links[0].target_ids))

    def test_unbound_artifact_import_isolated_per_project(self) -> None:
        with transaction(self.session_catalog.database) as connection:
            connection.execute(
                "UPDATE session_catalog SET project_path = NULL WHERE session_id = ?",
                (SESSION_ID,),
            )
        second_project = self.content.create_project("第二项目")
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        first = self.client.post(
            endpoint,
            json={"project_id": self.project.id, "artifact_id": self.artifact_id},
        )
        second = self.client.post(
            endpoint,
            json={"project_id": second_project.id, "artifact_id": self.artifact_id},
        )

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        first_links = ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID)
        second_links = ArtifactLinkCatalog(self.content).list_session(second_project.id, SESSION_ID)
        self.assertEqual(len(first_links), 1)
        self.assertEqual(len(second_links), 1)
        self.assertNotEqual(first_links[0].link_id, second_links[0].link_id)
        self.assertTrue(first_links[0].projected)
        self.assertTrue(second_links[0].projected)
        linked = [
            event
            for event in self.events.replay(SESSION_ID)
            if event.kind == "artifact_library_linked"
        ]
        self.assertEqual(len(linked), 2)
        self.assertEqual(
            {event.payload["project_id"] for event in linked},
            {self.project.id, second_project.id},
        )
        links = self.client.get(f"/api/assistant/sessions/{SESSION_ID}/resources/links")
        self.assertEqual(links.status_code, 200, links.text)
        self.assertEqual(len(links.json()["links"]), 2)

    def test_link_event_commit_before_ack_recovers_once_after_target_rename(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources"
        with patch.object(
            ArtifactLinkCatalog, "acknowledge", side_effect=ArtifactLinkError("ack_interrupted")
        ):
            failed = self.client.post(f"{endpoint}/import", json={"artifact_id": self.artifact_id})
        self.assertEqual(failed.status_code, 400)
        catalog = ArtifactLinkCatalog(self.content)
        link = catalog.list_session(self.project.id, SESSION_ID)[0]
        self.assertFalse(link.projected)
        events = self.events.replay(SESSION_ID)
        target = self.content.asset(self.project.id, link.target_ids[0])
        self.content.rename(self.project.id, target.path, "renamed.bin")
        with transaction(self.session_catalog.database) as connection:
            connection.execute(
                "UPDATE session_catalog SET runtime_id = ?, vendor_thread_id = ? WHERE session_id = ?",
                ("another-runtime", "another-thread", SESSION_ID),
            )
        recovered = self.client.get(f"{endpoint}/links")
        self.assertEqual(recovered.status_code, 200, recovered.text)
        self.assertTrue(catalog.list_session(self.project.id, SESSION_ID)[0].projected)
        self.assertEqual(self.events.replay(SESSION_ID), events)
        self.assertTrue(recovered.json()["links"][0]["node"]["path"].endswith("renamed.bin"))

    def test_delayed_link_projection_uses_delivery_time_not_intent_time(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources"
        with patch.object(
            LibraryLinkProjection, "project", side_effect=ArtifactLinkError("delivery_interrupted")
        ):
            failed = self.client.post(f"{endpoint}/import", json={"artifact_id": self.artifact_id})
        self.assertEqual(failed.status_code, 400)
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE assistant_artifact_links SET created_at = ?", (1.0,))
        before = self.session_catalog.get(SESSION_ID)
        self.assertIsNotNone(before)
        recovered = self.client.get(f"{endpoint}/links")
        self.assertEqual(recovered.status_code, 200, recovered.text)
        after = self.session_catalog.get(SESSION_ID)
        self.assertIsNotNone(after)
        assert before is not None and after is not None
        self.assertGreaterEqual(after.updated_at, before.updated_at)
        self.assertGreater(self.events.replay(SESSION_ID)[-1].created_at, 1.0)

    def test_conflicting_committed_link_event_cannot_ack_outbox(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources"
        with patch.object(
            ArtifactLinkCatalog, "acknowledge", side_effect=ArtifactLinkError("ack_interrupted")
        ):
            self.client.post(f"{endpoint}/import", json={"artifact_id": self.artifact_id})
        link = ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID)[0]
        with transaction(self.session_catalog.database) as connection:
            connection.execute(
                f"UPDATE {PRODUCT_EVENT_TABLE} SET payload = ? WHERE session_id = ? AND idempotency_key = ?",
                (
                    json.dumps({"target_ids": ["different-target"]}),
                    SESSION_ID,
                    f"artifact_library_linked:{self.project.id}:{link.link_id}",
                ),
            )
        result = self.client.get(f"{endpoint}/links")
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["links"][0]["error"], "artifact_library_link_invalid")
        self.assertFalse(
            ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID)[0].projected
        )

    def test_library_link_intent_is_durable_before_resource_creation(self) -> None:
        catalog = ArtifactLinkCatalog(self.content)
        observed = []

        def interrupted(*args, **kwargs):
            links = catalog.list_session(self.project.id, SESSION_ID)
            self.assertEqual(len(links), 1)
            self.assertEqual(links[0].state, LinkState.PENDING)
            self.assertEqual(links[0].target_ids, ())
            observed.append(links[0].link_id)
            raise ResourceWriterError("interrupted_before_resource")

        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        with patch.object(ResourceWriter, "import_once", side_effect=interrupted):
            response = self.client.post(endpoint, json={"artifact_id": self.artifact_id})
        self.assertEqual(response.status_code, 400)
        recovered = self.client.post(endpoint, json={"artifact_id": self.artifact_id})
        self.assertEqual(recovered.status_code, 200, recovered.text)
        links = catalog.list_session(self.project.id, SESSION_ID)
        self.assertEqual([link.link_id for link in links], observed)
        self.assertEqual(links[0].state, LinkState.COMPLETED)

    def test_completed_resource_pending_link_recovers_without_duplicate(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        payload = {"artifact_id": self.artifact_id}
        with patch.object(
            ArtifactLinkCatalog,
            "complete",
            side_effect=ArtifactLinkError("interrupted_link_commit"),
        ):
            failed = self.client.post(endpoint, json=payload)
        self.assertEqual(failed.status_code, 400)
        catalog = ArtifactLinkCatalog(self.content)
        pending = catalog.list_session(self.project.id, SESSION_ID)[0]
        self.assertEqual(pending.state, LinkState.PENDING)
        materialized = ResourceWriter(self.content).resume_import(
            self.project.id, pending.operation_id, pending.fingerprint
        )
        self.content.write_text(
            self.project.id, materialized.path, "user change after interrupted response"
        )
        recovered = self.client.post(endpoint, json=payload)
        self.assertEqual(recovered.status_code, 200, recovered.text)
        self.assertEqual(recovered.json()["node"]["assetId"], materialized.asset_id)
        self.assertEqual(
            (Path(self.project.root) / materialized.path).read_text(),
            "user change after interrupted response",
        )
        completed = catalog.list_session(self.project.id, SESSION_ID)
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0].target_ids, (materialized.asset_id,))

    def test_distinct_import_destinations_keep_independent_links(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        assets = []
        for name in ("first", "second"):
            response = self.client.post(
                endpoint,
                json={"artifact_id": self.artifact_id, "location": {"parent": "", "name": name}},
            )
            self.assertEqual(response.status_code, 200, response.text)
            assets.append(response.json()["node"]["assetId"])
        links = ArtifactLinkCatalog(self.content).list_session(self.project.id, SESSION_ID)
        self.assertEqual({link.target_ids[0] for link in links}, set(assets))
        self.assertEqual(len(links), 2)
        self.assertEqual(
            ArtifactLinkCatalog(self.content).list_session(self.project.id, UNBOUND_SESSION_ID), ()
        )

    def test_link_query_recovers_completed_destination_without_source_read(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources"
        with patch.object(
            ArtifactLinkCatalog,
            "complete",
            side_effect=ArtifactLinkError("interrupted_link_commit"),
        ):
            self.client.post(f"{endpoint}/import", json={"artifact_id": self.artifact_id})
        with patch.object(
            ArtifactService, "export_bytes", side_effect=AssertionError("source read")
        ):
            response = self.client.get(f"{endpoint}/links")
        self.assertEqual(response.status_code, 200, response.text)
        link = response.json()["links"][0]
        self.assertEqual(link["state"], "completed")
        self.assertEqual(link["target_ids"], [link["node"]["assetId"]])
        self.assertIsNone(link["error"])
        self.assertNotIn("fingerprint", link)
        self.assertNotIn("operation_id", link)

    def test_link_query_reopens_renamed_asset_and_marks_deleted_target_unavailable(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources"
        imported = self.client.post(
            f"{endpoint}/import", json={"artifact_id": self.artifact_id}
        ).json()["node"]
        renamed = self.content.rename(self.project.id, imported["path"], "renamed.bin")
        response = self.client.get(f"{endpoint}/links")
        link = response.json()["links"][0]
        self.assertEqual(link["node"]["path"], renamed.path)
        self.assertEqual(link["target_ids"], [imported["assetId"]])
        target = Path(self.project.root) / renamed.path
        target.unlink()
        unavailable = self.client.get(f"{endpoint}/links").json()["links"][0]
        self.assertEqual(unavailable["state"], "completed")
        self.assertEqual(unavailable["target_ids"], link["target_ids"])
        self.assertIsNone(unavailable["node"])
        self.assertTrue(unavailable["error"])
        self.assertFalse(target.exists())

    def test_link_query_does_not_create_unreserved_destination(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources"
        with patch.object(
            ResourceWriter,
            "import_once",
            side_effect=ResourceWriterError("interrupted_before_reservation"),
        ):
            self.client.post(f"{endpoint}/import", json={"artifact_id": self.artifact_id})
        with patch.object(self.content, "prepare_bytes", side_effect=AssertionError("new target")):
            response = self.client.get(f"{endpoint}/links")
        self.assertEqual(response.status_code, 200)
        link = response.json()["links"][0]
        self.assertEqual(link["state"], "pending")
        self.assertIsNone(link["node"])

    def test_link_query_requires_existing_accessible_session(self) -> None:
        response = self.client.get("/api/assistant/sessions/unknown-session/resources/links")
        self.assertEqual(response.status_code, 404)

    def test_link_query_reports_unavailable_project_root(self) -> None:
        shutil.rmtree(self.project.root)
        response = self.client.get(f"/api/assistant/sessions/{SESSION_ID}/resources/links")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], ROOT_UNAVAILABLE_ERROR)

    def test_projectless_session_has_no_destination_links(self) -> None:
        for destination in ("resources", "literature"):
            with self.subTest(destination=destination):
                response = self.client.get(
                    f"/api/assistant/sessions/{UNBOUND_SESSION_ID}/{destination}/links"
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"links": []})
                rejected = self.client.post(
                    f"/api/assistant/sessions/{UNBOUND_SESSION_ID}/{destination}/import",
                    json={"artifact_id": self.artifact_id},
                )
                self.assertEqual(rejected.status_code, 409)
                self.assertEqual(rejected.json()["detail"], "assistant_project_unavailable")

    def test_projectless_session_can_save_to_an_explicit_project(self) -> None:
        response = self.client.post(
            f"/api/assistant/sessions/{UNBOUND_SESSION_ID}/resources/create",
            json={
                "project_id": self.project.id,
                "name": "全局对话结论",
                "content": "# 全局对话结论\n",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        saved = Path(self.project.root) / response.json()["node"]["path"]
        self.assertEqual(saved.read_text(encoding="utf-8"), "# 全局对话结论\n")

    def test_corrupt_library_link_cannot_be_normalized_into_success(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources"
        imported = self.client.post(f"{endpoint}/import", json={"artifact_id": self.artifact_id})
        self.assertEqual(imported.status_code, 200)
        catalog = ArtifactLinkCatalog(self.content)
        record = catalog.list_session(self.project.id, SESSION_ID)[0]
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            original = dict(connection.execute("SELECT * FROM assistant_artifact_links").fetchone())
        invalid = (
            ("projected", 2),
            ("projected", "false"),
            ("created_at", float("inf")),
            ("source_sha256", "invalid"),
            ("fingerprint", "invalid"),
            ("target_ids", json.dumps([record.target_ids[0], record.target_ids[0]])),
        )
        for field, value in invalid:
            with self.subTest(field=field, value=value):
                with transaction(database) as connection:
                    connection.execute(f"UPDATE assistant_artifact_links SET {field} = ?", (value,))
                with self.assertRaises(ArtifactLinkError):
                    catalog.complete(record, record.target_ids)
                response = self.client.get(f"{endpoint}/links")
                self.assertEqual(response.status_code, 400)
                with transaction(database) as connection:
                    row = dict(
                        connection.execute("SELECT * FROM assistant_artifact_links").fetchone()
                    )
                    self.assertEqual(row[field], value)
                    connection.execute(
                        f"UPDATE assistant_artifact_links SET {field} = ?", (original[field],)
                    )

    def test_import_persists_null_optional_context_when_turn_has_no_snapshot(self) -> None:
        artifact_name = "without-evidence.bin"
        artifact_path = self.output_root / artifact_name
        artifact_bytes = b"artifact-without-turn-evidence"
        artifact_path.write_bytes(artifact_bytes)
        event = self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-without-evidence",
            vendor_item_id="item-without-evidence",
            kind="tool_completed",
            payload={"type": "artifact.publish", "status": "completed"},
            idempotency_key="assistant-resource-event-without-evidence",
            created_at=4.0,
        )
        captured = self.content.capture_artifact(
            ArtifactScope(ArtifactScopeKind.SESSION, SESSION_ID), f"outputs/{artifact_name}"
        )
        record = self.artifact_store.index(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{SESSION_ID}",
            vendor_turn_id="turn-without-evidence",
            vendor_item_id="item-without-evidence",
            source_kind=ArtifactSource.ARTIFACT_PUBLISH,
            source_product_seq=event.product_seq,
            original_path=f"outputs/{artifact_name}",
            canonical_path=str(artifact_path),
            role="final",
            status=ArtifactStatus.PUBLISHED,
            mime_type="application/octet-stream",
            content_sha256=sha256(artifact_bytes).hexdigest(),
            size_bytes=len(artifact_bytes),
            metadata={"label": artifact_name, "content": asdict(captured)},
            idempotency_key="assistant-resource-artifact-without-evidence",
            created_at=5.0,
        )
        artifact_id = artifact_identity(record)

        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={"artifact_id": artifact_id},
        )

        self.assertEqual(response.status_code, 200, response.text)
        provenance = self.agent_imports.get(self.project.id, response.json()["node"]["path"])
        self.assertIsNotNone(provenance)
        assert provenance is not None
        self.assertEqual(provenance.source_kind, AgentImportSourceKind.ARTIFACT)
        self.assertEqual(provenance.source_id, artifact_id)
        self.assertIsNone(provenance.evidence_snapshot_id)
        self.assertIsNone(provenance.evidence)
        self.assertIsNone(provenance.conversation)
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with sqlite3.connect(database) as connection:
            columns = {
                str(row[1]): int(row[3])
                for row in connection.execute(f"PRAGMA table_info({AGENT_IMPORTS_TABLE})")
            }
            stored = connection.execute(
                f"""
                SELECT evidence_json, conversation_snapshot_json
                FROM {AGENT_IMPORTS_TABLE}
                WHERE resource_path = ?
                """,
                (response.json()["node"]["path"],),
            ).fetchone()
        self.assertEqual(columns["evidence_json"], 0)
        self.assertFalse(any("sha256" in name for name in columns))
        self.assertEqual(stored, (None, None))

    def test_import_rejects_stale_sha_before_creating_target(self) -> None:
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={
                "artifact_id": self.artifact_id,
                "expected_sha256": "0" * 64,
                "location": {"parent": "阶段成果", "name": "不会创建.bin"},
            },
        )

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(
            response.json()["detail"],
            "session_artifact_revision_conflict",
        )
        self.assertFalse(Path(self.project.root, "resources", "阶段成果").exists())

    def test_import_uses_edited_publication_draft(self) -> None:
        artifact_id, path = self._publish_artifact("draft.txt", b"original", "text/plain")
        reader = ArtifactService(
            self.session_catalog, self.artifact_store, self.events, WorkbenchFormatPolicy()
        )
        reader.bind_content(self.content)
        reader.write_raw(
            SESSION_ID, artifact_id, b"edited", f"sha256:{sha256(b'original').hexdigest()}"
        )
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={"artifact_id": artifact_id, "expected_sha256": sha256(b"edited").hexdigest()},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            (Path(self.project.root) / response.json()["node"]["path"]).read_bytes(), b"edited"
        )
        self.assertEqual(path.read_bytes(), b"original")

    def test_import_uses_published_bytes_after_working_source_changes(self) -> None:
        self.artifact_path.write_bytes(b"changed working source")
        response = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={
                "artifact_id": self.artifact_id,
                "expected_sha256": self.artifact_sha256,
                "location": {"parent": "版本归档", "name": "原始交付.bin"},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        imported = Path(self.project.root) / response.json()["node"]["path"]
        self.assertEqual(imported.read_bytes(), self.artifact_bytes)

    def test_import_rejects_unknown_artifact_and_unbound_project(self) -> None:
        missing = self.client.post(
            f"/api/assistant/sessions/{SESSION_ID}/resources/import",
            json={"artifact_id": "missing"},
        )
        unbound = self.client.post(
            f"/api/assistant/sessions/{UNBOUND_SESSION_ID}/resources/create",
            json={"name": "不会创建", "content": "content"},
        )

        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["detail"], "session_artifact_not_found")
        self.assertEqual(unbound.status_code, 409)
        self.assertEqual(unbound.json()["detail"], "assistant_project_unavailable")

    def test_legacy_project_keeps_ai_outputs_inside_its_resource_root(self) -> None:
        legacy_root = Path(self.temporary.name) / "legacy-project"
        legacy_root.mkdir()
        catalog = ContentCatalog(Path(self.temporary.name) / "legacy-content.sqlite3")
        registry = ProjectRegistry(str(legacy_root), catalog)
        project = registry.seed_workspace()
        self.assertIsNotNone(project)

        content = ContentService(registry, catalog)
        created = ResourceWriter(content).write_agent_output(
            project.id,
            "旧项目摘录",
            "legacy content",
        )

        self.assertEqual(created.path, "ai_extracts/旧项目摘录.md")
        self.assertEqual((legacy_root / created.path).read_text(encoding="utf-8"), "legacy content")
        located = content.locate(project.id, RootKind.RESOURCES, str(legacy_root / created.path))
        self.assertIsNotNone(located)
        self.assertEqual(located.path if located else None, created.path)

    def test_concurrent_imports_reuse_exact_parent_without_overwriting(self) -> None:
        writer = ResourceWriter(self.content)
        payloads = tuple(bytes([index]) * 8192 for index in range(8))
        with ThreadPoolExecutor(max_workers=len(payloads)) as executor:
            results = tuple(
                executor.map(
                    lambda payload: writer.import_bytes(self.project.id, "parallel.bin", payload),
                    payloads,
                )
            )
        self.assertEqual(len({result.path for result in results}), len(payloads))
        for result, payload in zip(results, payloads):
            self.assertEqual((Path(self.project.root) / result.path).read_bytes(), payload)
            self.assertEqual(Path(result.path).parent.as_posix(), "resources/ai_extracts")
        resources = Path(self.project.root) / "resources"
        self.assertEqual([path.name for path in resources.iterdir()], ["ai_extracts"])
        self.assertFalse(
            any(path.name.startswith(".create-") for path in (resources / "ai_extracts").iterdir())
        )

    def test_import_parent_file_is_not_adopted_or_renamed(self) -> None:
        parent = Path(self.project.root) / "resources" / "ai_extracts"
        parent.write_bytes(b"user-owned")
        with self.assertRaises(ResourceWriterError) as caught:
            ResourceWriter(self.content).import_bytes(self.project.id, "report.md", b"report")
        self.assertEqual(caught.exception.code, "directory_conflict")
        self.assertEqual(parent.read_bytes(), b"user-owned")
        self.assertFalse(parent.with_name("ai_extracts (2)").exists())

    def test_import_never_replaces_dangling_symlink(self) -> None:
        parent = Path(self.project.root) / "resources" / "ai_extracts"
        parent.mkdir()
        link = parent / "report.md"
        link.symlink_to("missing.md")
        result = ResourceWriter(self.content).import_bytes(self.project.id, "report.md", b"report")
        self.assertTrue(link.is_symlink())
        self.assertEqual(result.name, "report (2).md")
        self.assertEqual((Path(self.project.root) / result.path).read_bytes(), b"report")

    def test_failed_staging_does_not_publish_partial_resource(self) -> None:
        parent = Path(self.project.root) / "resources" / "ai_extracts"
        parent.mkdir()
        original_sync = os.fsync

        def sync(descriptor: int) -> None:
            # 仅注入普通文件的落盘失败; 目录清理仍走真实文件系统。
            if stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OSError("injected staging failure")
            original_sync(descriptor)

        with patch("service.content.service.assets.os.fsync", side_effect=sync):
            with self.assertRaises(ResourceWriterError) as caught:
                ResourceWriter(self.content).import_bytes(self.project.id, "report.md", b"report")
        self.assertEqual(caught.exception.code, "write_failed")
        self.assertEqual(list(parent.iterdir()), [])

    def test_artifact_import_http_retry_returns_same_resource(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        first = self.client.post(endpoint, json={"artifact_id": self.artifact_id})
        second = self.client.post(endpoint, json={"artifact_id": self.artifact_id})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json(), second.json())
        parent = Path(self.project.root) / "resources" / "ai_extracts"
        self.assertEqual([path.name for path in parent.iterdir()], [ARTIFACT_NAME])

    def test_http_idempotency_key_conflict_does_not_create_new_parent(self) -> None:
        endpoint = f"/api/assistant/sessions/{SESSION_ID}/resources/import"
        payload = {"artifact_id": self.artifact_id, "idempotency_key": "request-key"}
        first = self.client.post(endpoint, json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        changed = self.client.post(
            endpoint,
            json={
                **payload,
                "location": {"parent": "unexpected", "name": ARTIFACT_NAME},
            },
        )
        self.assertEqual(changed.status_code, 409, changed.text)
        self.assertEqual(changed.json()["detail"], "resource_import_operation_conflict")
        self.assertFalse((Path(self.project.root) / "resources" / "unexpected").exists())

    def test_prepared_import_does_not_adopt_equal_bytes_at_reserved_target(self) -> None:
        with patch.object(
            self.content, "publish_prepared", side_effect=ContentError("interrupted")
        ):
            with self.assertRaises(ResourceWriterError):
                ResourceWriter(self.content).import_once(
                    self.project.id, "operation", "publication", "report.md", b"complete"
                )
        target = Path(self.project.root) / "resources" / "ai_extracts" / "report.md"
        target.write_bytes(b"complete")
        identity = target.stat().st_ino
        with self.assertRaises(ResourceWriterError) as caught:
            ResourceWriter(self.content).import_once(
                self.project.id, "operation", "publication", "report.md", b"complete"
            )
        self.assertEqual(caught.exception.code, "prepared_content_conflict")
        self.assertEqual(target.stat().st_ino, identity)
        self.assertEqual(target.read_bytes(), b"complete")

    def test_import_operation_reopens_and_rejects_changed_parameters(self) -> None:
        first = ResourceWriter(self.content).import_once(
            self.project.id, "operation", "publication", "result.bin", b"first"
        )
        reopened = ResourceWriter(self.content)
        self.assertEqual(
            reopened.import_once(
                self.project.id, "operation", "publication", "result.bin", b"first"
            ),
            first,
        )
        with self.assertRaises(ResourceWriterError) as caught:
            reopened.import_once(
                self.project.id, "operation", "publication", "result.bin", b"other"
            )
        self.assertEqual(caught.exception.code, "resource_import_operation_conflict")
        self.assertEqual((Path(self.project.root) / first.path).read_bytes(), b"first")

    def test_import_recovers_published_file_before_result_commit(self) -> None:
        publish = self.content.publish_prepared

        def fail_after_publish(prepared):
            publish(prepared)
            raise ContentError("interrupted_after_publish")

        with patch.object(self.content, "publish_prepared", side_effect=fail_after_publish):
            with self.assertRaises(ResourceWriterError):
                ResourceWriter(self.content).import_once(
                    self.project.id, "operation", "publication", "report.md", b"complete"
                )
        result = ResourceWriter(self.content).import_once(
            self.project.id, "operation", "publication", "report.md", b"complete"
        )
        parent = Path(self.project.root) / "resources" / "ai_extracts"
        self.assertEqual([path.name for path in parent.iterdir()], ["report.md"])
        self.assertEqual((Path(self.project.root) / result.path).read_bytes(), b"complete")

    def test_import_recovers_reservation_before_publish(self) -> None:
        with patch.object(
            self.content, "publish_prepared", side_effect=ContentError("interrupted")
        ):
            with self.assertRaises(ResourceWriterError):
                ResourceWriter(self.content).import_once(
                    self.project.id, "operation", "publication", "report.md", b"complete"
                )
        parent = Path(self.project.root) / "resources" / "ai_extracts"
        self.assertFalse((parent / "report.md").exists())
        result = ResourceWriter(self.content).import_once(
            self.project.id, "operation", "publication", "report.md", b"complete"
        )
        self.assertEqual((Path(self.project.root) / result.path).read_bytes(), b"complete")
        self.assertEqual([path.name for path in parent.iterdir()], ["report.md"])

    def test_published_receipt_recovers_after_staging_is_released(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "recovered.md", b"complete"
        )
        first = self.content.publish_prepared(prepared)
        self.content.release_prepared(prepared)
        target = Path(self.project.root) / first.path
        inode = target.stat().st_ino
        self.assertFalse((Path(self.project.root) / prepared.staging_path).exists())
        for _ in range(2):
            self.assertEqual(self.content.publish_prepared(prepared), first)
            self.assertEqual(target.stat().st_ino, inode)
            self.assertEqual(target.read_bytes(), b"complete")

    def test_prepared_import_recovers_its_partial_copy(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "recovered-copy.md", b"complete"
        )
        target = Path(self.project.root) / prepared.path
        descriptor = os.open(target, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            set_creation_marker(descriptor, prepared.marker)
            os.write(descriptor, b"partial")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

        created = self.content.publish_prepared(prepared)

        self.assertEqual(created.path, prepared.path)
        self.assertEqual(target.read_bytes(), b"complete")

    def test_prepared_import_copies_without_platform_publication(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "copied.md", b"independent"
        )
        stage = Path(self.project.root) / prepared.staging_path

        with patch(
            "service.content.service.assets.publish_descriptor",
            side_effect=AssertionError("prepared import must copy independent bytes"),
        ):
            created = self.content.publish_prepared(prepared)

        target = Path(self.project.root) / created.path
        self.assertTrue(stage.is_file())
        self.assertEqual(stage.read_bytes(), b"independent")
        self.assertEqual(target.read_bytes(), b"independent")
        self.assertNotEqual(
            (stage.stat().st_dev, stage.stat().st_ino), (target.stat().st_dev, target.stat().st_ino)
        )

    def test_import_returns_durable_content_identity(self) -> None:
        first = ResourceWriter(self.content).import_once(
            self.project.id, "identity-operation", "publication", "identity.md", b"complete"
        )
        self.assertTrue(first.asset_id)
        self.assertEqual(self.content.asset(self.project.id, first.asset_id), first)
        self.assertEqual(
            ResourceWriter(self.content).import_once(
                self.project.id, "identity-operation", "publication", "identity.md", b"complete"
            ),
            first,
        )
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            row = connection.execute(
                "SELECT state, asset_id FROM resources_import_operation WHERE operation_id = ?",
                ("identity-operation",),
            ).fetchone()
            self.assertEqual((row["state"], row["asset_id"]), ("completed", first.asset_id))
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM content_asset").fetchone()[0], 1
            )

    def test_rename_does_not_overwrite_a_racing_destination(self) -> None:
        source = self.content.create_bytes(self.project.id, "resources", "source.md", b"source")
        destination = Path(self.project.root) / "resources" / "destination.md"

        def race(source_directory, source_name, directory, name):
            destination.write_bytes(b"other writer")
            rename_exclusive(source_directory, source_name, directory, name)

        with patch("service.content.service.assets.rename_exclusive", side_effect=race):
            with self.assertRaises(ContentError) as caught:
                self.content.rename(self.project.id, source.path, destination.name)
        self.assertEqual(caught.exception.code, "name_exists")
        self.assertEqual(destination.read_bytes(), b"other writer")
        self.assertEqual((Path(self.project.root) / source.path).read_bytes(), b"source")

    def test_move_does_not_remove_a_racing_destination(self) -> None:
        source = self.content.create_bytes(self.project.id, "resources", "source.md", b"source")
        self.content.create(self.project.id, "resources", "archive", AssetKind.DIR)
        destination = Path(self.project.root) / "resources" / "archive" / "source.md"

        def race(source_directory, source_name, directory, name):
            destination.write_bytes(b"other writer")
            rename_exclusive(source_directory, source_name, directory, name)

        with patch("service.content.service.assets.rename_exclusive", side_effect=race):
            with self.assertRaises(ContentError) as caught:
                self.content.move(self.project.id, source.path, "resources/archive")
        self.assertEqual(caught.exception.code, "name_exists")
        self.assertEqual(destination.read_bytes(), b"other writer")
        self.assertEqual((Path(self.project.root) / source.path).read_bytes(), b"source")

    def test_rename_rejects_file_extension_changes_before_relocation(self) -> None:
        source = self.content.create_bytes(
            self.project.id,
            "resources",
            "report.final.PDF",
            b"pdf",
        )
        with self.assertRaises(ContentError) as caught:
            self.content.rename(self.project.id, source.path, "report.final.txt")
        self.assertEqual(caught.exception.code, "file_extension_change_forbidden")
        self.assertEqual((Path(self.project.root) / source.path).read_bytes(), b"pdf")

    def test_rename_preserves_a_dangling_destination_symlink(self) -> None:
        source = self.content.create_bytes(self.project.id, "resources", "source.md", b"source")
        destination = Path(self.project.root) / "resources" / "destination.md"
        destination.symlink_to("missing.md")
        with self.assertRaises(ContentError) as caught:
            self.content.rename(self.project.id, source.path, destination.name)
        self.assertEqual(caught.exception.code, "name_exists")
        self.assertTrue(destination.is_symlink())
        self.assertEqual(os.readlink(destination), "missing.md")
        self.assertTrue((Path(self.project.root) / source.path).is_file())

    def test_rename_preserves_physical_identity(self) -> None:
        source = self.content.create_bytes(self.project.id, "resources", "source.md", b"source")
        original = Path(self.project.root) / source.path
        inode = original.stat().st_ino
        renamed = self.content.rename(self.project.id, source.path, "renamed.md")
        self.assertFalse(original.exists())
        self.assertEqual((Path(self.project.root) / renamed.path).stat().st_ino, inode)

    def test_registered_rename_preserves_import_identity(self) -> None:
        writer = ResourceWriter(self.content)
        original = writer.import_once(
            self.project.id, "rename-operation", "publication", "original.md", b"complete"
        )
        renamed = self.content.rename(self.project.id, original.path, "renamed.md")
        self.assertEqual(renamed.asset_id, original.asset_id)
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), renamed)
        self.assertEqual(
            writer.import_once(
                self.project.id, "rename-operation", "publication", "original.md", b"complete"
            ),
            renamed,
        )

    def test_all_write_policies_preserve_registered_identity(self) -> None:
        writer = ResourceWriter(self.content)
        original = writer.import_once(
            self.project.id, "edit-operation", "publication", "editable.md", b"initial"
        )
        self.content.write_text(self.project.id, original.path, "text edit")
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)
        self.content.commit_bytes(
            self.project.id,
            original.path,
            b"CAS edit",
            f"sha256:{sha256(b'text edit').hexdigest()}",
        )
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)
        self.content.commit_optional_bytes(
            self.project.id,
            original.path,
            b"optional edit",
            f"sha256:{sha256(b'CAS edit').hexdigest()}",
            b"",
        )
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)
        self.assertEqual(
            writer.import_once(
                self.project.id, "edit-operation", "publication", "editable.md", b"initial"
            ),
            original,
        )
        self.assertEqual((Path(self.project.root) / original.path).read_bytes(), b"optional edit")

    def test_resume_missing_import_does_not_create_project_database(self) -> None:
        database = Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE))
        self.assertFalse(database.exists())
        self.assertIsNone(
            ResourceWriter(self.content).resume_import(self.project.id, "absent", "digest")
        )
        self.assertFalse(database.exists())

    def test_resume_prepared_import_without_source_or_new_reservation(self) -> None:
        catalog = ResourceImportCatalog(self.content)
        operation = catalog.reserve(
            self.project.id,
            "prepared-operation",
            "request-fingerprint",
            lambda reserved: self.content.prepare_bytes(
                self.project.id, "resources", "prepared.md", b"persisted source", reserved
            ),
        )
        target = Path(self.project.root) / operation.prepared.path
        self.assertFalse(target.exists())
        writer = ResourceWriter(self.content)
        with patch.object(
            self.content, "prepare_bytes", side_effect=AssertionError("new reservation")
        ):
            recovered = writer.resume_import(
                self.project.id, operation.operation_id, operation.fingerprint
            )
            repeated = writer.resume_import(
                self.project.id, operation.operation_id, operation.fingerprint
            )
        self.assertIsNotNone(recovered)
        self.assertEqual(recovered, repeated)
        self.assertEqual(target.read_bytes(), b"persisted source")

    def test_resume_import_follows_edited_renamed_asset(self) -> None:
        writer = ResourceWriter(self.content)
        asset = writer.import_once(
            self.project.id, "resume-operation", "source", "report.md", b"source"
        )
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            fingerprint = connection.execute(
                "SELECT fingerprint FROM resources_import_operation WHERE operation_id = ?",
                ("resume-operation",),
            ).fetchone()[0]
        self.content.write_text(self.project.id, asset.path, "human edit")
        renamed = self.content.rename(self.project.id, asset.path, "renamed.md")
        self.artifact_path.unlink()
        with patch.object(
            self.content, "prepare_bytes", side_effect=AssertionError("new reservation")
        ):
            recovered = writer.resume_import(self.project.id, "resume-operation", fingerprint)
        self.assertEqual(recovered.asset_id, asset.asset_id)
        self.assertEqual(recovered.path, renamed.path)
        self.assertEqual((Path(self.project.root) / recovered.path).read_bytes(), b"human edit")

    def test_resume_wrong_fingerprint_cannot_publish_pending_target(self) -> None:
        operation = ResourceImportCatalog(self.content).reserve(
            self.project.id,
            "pending-operation",
            "correct-fingerprint",
            lambda reserved: self.content.prepare_bytes(
                self.project.id, "resources", "pending.md", b"pending", reserved
            ),
        )
        with self.assertRaises(ResourceWriterError):
            ResourceWriter(self.content).resume_import(
                self.project.id, operation.operation_id, "wrong"
            )
        self.assertFalse((Path(self.project.root) / operation.prepared.path).exists())

    def test_resume_deleted_completed_asset_never_recreates_it(self) -> None:
        writer = ResourceWriter(self.content)
        asset = writer.import_once(
            self.project.id, "deleted-operation", "source", "report.md", b"source"
        )
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            fingerprint = connection.execute(
                "SELECT fingerprint FROM resources_import_operation WHERE operation_id = ?",
                ("deleted-operation",),
            ).fetchone()[0]
        target = Path(self.project.root) / asset.path
        target.unlink()
        with self.assertRaises(ResourceWriterError):
            writer.resume_import(self.project.id, "deleted-operation", fingerprint)
        self.assertFalse(target.exists())

    def test_resume_invalid_state_preserves_operation(self) -> None:
        writer = ResourceWriter(self.content)
        writer.import_once(self.project.id, "invalid-operation", "source", "report.md", b"source")
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            connection.execute("UPDATE resources_import_operation SET state = 'unsupported'")
            before = dict(connection.execute("SELECT * FROM resources_import_operation").fetchone())
        with self.assertRaises(ResourceWriterError):
            writer.resume_import(self.project.id, "invalid-operation", before["fingerprint"])
        with transaction(database) as connection:
            after = dict(connection.execute("SELECT * FROM resources_import_operation").fetchone())
        self.assertEqual(after, before)

    def test_resume_malformed_receipt_values_preserve_database_and_files(self) -> None:
        writer = ResourceWriter(self.content)
        asset = writer.import_once(
            self.project.id, "corrupt-receipt", "source", "report.md", b"source"
        )
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            original = dict(
                connection.execute("SELECT * FROM resources_import_operation").fetchone()
            )
        invalid_values = (
            ("marker", None),
            ("staging_path", []),
            ("path", 42),
            ("project_id", []),
            ("device", True),
            ("inode", "1"),
            ("size", -1),
            ("sha256", "not-a-digest"),
        )
        target = Path(self.project.root) / asset.path
        identity = target.stat()
        for field, value in invalid_values:
            with self.subTest(field=field):
                receipt = json.loads(original["prepared"])
                receipt[field] = value
                serialized = json.dumps(receipt)
                with transaction(database) as connection:
                    connection.execute(
                        "UPDATE resources_import_operation SET prepared = ?", (serialized,)
                    )
                with self.assertRaisesRegex(
                    ResourceWriterError, "resource_import_operation_unavailable"
                ):
                    writer.resume_import(
                        self.project.id, "corrupt-receipt", original["fingerprint"]
                    )
                with transaction(database) as connection:
                    after = dict(
                        connection.execute("SELECT * FROM resources_import_operation").fetchone()
                    )
                self.assertEqual(after, {**original, "prepared": serialized})
                self.assertEqual(target.read_bytes(), b"source")
                self.assertEqual(
                    (target.stat().st_dev, target.stat().st_ino), (identity.st_dev, identity.st_ino)
                )

    def test_edit_recovers_after_atomic_replace_before_identity_commit(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "editable.md", b"initial")
        )

        def interrupted(directory, source, destination):
            exchange_entries(directory, source, destination)
            raise OSError(errno.EIO, "interrupted after replace")

        with patch("service.content.service.port.exchange_entries", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "edited")
        self.assertEqual((Path(self.project.root) / original.path).read_bytes(), b"edited")
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            self.assertEqual(
                connection.execute("SELECT state FROM content_asset_replacement").fetchone()[0],
                "verified",
            )
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM content_asset_replacement").fetchone()[0],
                0,
            )

    def test_failed_edit_preserves_original_identity(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "editable.md", b"initial")
        )
        with patch(
            "service.content.service.port.exchange_entries",
            side_effect=OSError(errno.EIO, "before replace"),
        ):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "edited")
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)
        self.assertEqual((Path(self.project.root) / original.path).read_bytes(), b"initial")

    def test_recovery_sync_failure_cannot_commit_verified_identity(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "editable.md", b"initial")
        )

        def interrupted(directory, source, destination):
            exchange_entries(directory, source, destination)
            raise OSError(errno.EIO, "interrupted before directory sync")

        with patch("service.content.service.port.exchange_entries", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "edited")
        sync = os.fsync
        synced = []

        def interrupted_sync(descriptor):
            observed = os.fstat(descriptor)
            synced.append((observed.st_dev, observed.st_ino))
            if stat.S_ISDIR(observed.st_mode):
                raise OSError(errno.EIO, "directory sync failed")
            sync(descriptor)

        with patch("service.content.service.identity.os.fsync", side_effect=interrupted_sync):
            with self.assertRaises(ContentError):
                self.content.asset(self.project.id, original.asset_id)
        target = Path(self.project.root) / original.path
        self.assertIn((target.stat().st_dev, target.stat().st_ino), synced)
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            row = connection.execute(
                "SELECT staging_path, state FROM content_asset_replacement"
            ).fetchone()
            self.assertEqual(row["state"], "prepared")
            self.assertEqual((target.parent / row["staging_path"]).read_bytes(), b"initial")
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)

    def test_next_edit_recovers_interrupted_previous_edit(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "editable.md", b"initial")
        )

        def interrupted(directory, source, destination):
            exchange_entries(directory, source, destination)
            raise OSError(errno.EIO, "interrupted after exchange")

        with patch("service.content.service.port.exchange_entries", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "first edit")
        self.content.write_text(self.project.id, original.path, "second edit")
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)
        self.assertEqual((Path(self.project.root) / original.path).read_bytes(), b"second edit")
        self.assertEqual(list((Path(self.project.root) / "resources").glob(".create-*")), [])

    def test_directory_rename_recovers_interrupted_edit(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "editable.md", b"initial")
        )

        def interrupted(directory, source, destination):
            exchange_entries(directory, source, destination)
            raise OSError(errno.EIO, "interrupted after exchange")

        with patch("service.content.service.port.exchange_entries", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "edited")
        self.content.rename(self.project.id, "resources", "renamed-resources")
        current = self.content.asset(self.project.id, original.asset_id)
        self.assertEqual(current.path, "renamed-resources/editable.md")
        self.assertEqual((Path(self.project.root) / current.path).read_bytes(), b"edited")
        self.assertEqual(
            list((Path(self.project.root) / "renamed-resources").glob(".create-*")), []
        )

    def test_verified_cleanup_interruption_remains_recoverable(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "editable.md", b"initial")
        )
        unlink = os.unlink

        def interrupted(path, *, dir_fd=None):
            unlink(path, dir_fd=dir_fd)
            raise OSError(errno.EIO, "interrupted after cleanup")

        with patch("service.content.service.identity.os.unlink", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "edited")
        self.assertEqual((Path(self.project.root) / original.path).read_bytes(), b"edited")
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            self.assertEqual(
                connection.execute("SELECT state FROM content_asset_replacement").fetchone()[0],
                "verified",
            )
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), original)

    def test_interrupted_exchange_does_not_skip_recovery_digest_validation(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(
                self.project.id, "resources", "editable.md", b"original user data"
            )
        )

        def interrupted(directory, source, destination):
            exchange_entries(directory, source, destination)
            descriptor = os.open(
                destination, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, dir_fd=directory
            )
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(b"unverified content on expected inode")
            raise OSError(errno.EIO, "interrupted before verification")

        with patch("service.content.service.port.exchange_entries", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "requested edit")
        with self.assertRaises(ContentError):
            self.content.asset(self.project.id, original.asset_id)
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            row = connection.execute(
                "SELECT staging_path, state FROM content_asset_replacement"
            ).fetchone()
            self.assertEqual(row["state"], "prepared")
            self.assertEqual(
                (Path(self.project.root) / "resources" / row["staging_path"]).read_bytes(),
                b"original user data",
            )

    def test_text_save_does_not_overwrite_user_tmp_sibling(self) -> None:
        original = self.content.create_bytes(
            self.project.id, "resources", "editable.md", b"initial"
        )
        sibling = Path(self.project.root) / "resources/editable.md.tmp"
        sibling.write_bytes(b"user data")
        self.content.write_text(self.project.id, original.path, "edited")
        self.assertEqual(sibling.read_bytes(), b"user data")

    def test_stage_substitution_cannot_destroy_original_during_edit(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(
                self.project.id, "resources", "editable.md", b"original user data"
            )
        )
        exchanged = False

        def substitute(directory, source, destination):
            nonlocal exchanged
            if not exchanged:
                os.unlink(source, dir_fd=directory)
                descriptor = os.open(
                    source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory
                )
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(b"unverified replacement")
                exchanged = True
            exchange_entries(directory, source, destination)

        with patch("service.content.service.port.exchange_entries", side_effect=substitute):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "requested edit")
        self.assertEqual(
            (Path(self.project.root) / original.path).read_bytes(), b"original user data"
        )

    def test_edit_parent_substitution_cannot_write_outside_project(self) -> None:
        original = self.content.create_bytes(
            self.project.id, "resources", "editable.md", b"original"
        )
        parent = Path(self.project.root) / "resources"
        held = Path(self.project.root) / "held-resources"
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (outside / "editable.md").write_bytes(b"outside user data")
        open_parent = ProjectSpace.open_parent

        def substitute(scope, path, *, create=False):
            result = open_parent(scope, path, create=create)
            parent.rename(held)
            parent.symlink_to(outside, target_is_directory=True)
            return result

        with patch.object(ProjectSpace, "open_parent", new=substitute):
            with self.assertRaises(ContentError):
                self.content.write_text(self.project.id, original.path, "requested edit")
        self.assertEqual((outside / "editable.md").read_bytes(), b"outside user data")
        self.assertEqual(sorted(node.name for node in outside.iterdir()), ["editable.md"])
        self.assertEqual((held / "editable.md").read_bytes(), b"original")

    def test_directory_rename_updates_all_registered_descendants(self) -> None:
        first = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "first.md", b"first")
        )
        second = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "second.md", b"second")
        )
        self.content.rename(self.project.id, "resources", "renamed-resources")
        for original in (first, second):
            current = self.content.asset(self.project.id, original.asset_id)
            self.assertEqual(current.path, f"renamed-resources/{original.name}")
            self.assertEqual(current.asset_id, original.asset_id)

    def test_registered_rename_recovers_after_filesystem_success(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "original.md", b"complete")
        )

        def interrupted(scope, path, name, *, destination=None):
            rename_node(scope, path, name, destination=destination)
            raise ContentError("interrupted_after_rename")

        with patch("service.content.service.assets.rename_node", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.rename(self.project.id, original.path, "renamed.md")
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM content_asset_relocation").fetchone()[0], 1
            )
        recovered = self.content.asset(self.project.id, original.asset_id)
        self.assertEqual(recovered.path, "resources/renamed.md")
        self.assertEqual(recovered.asset_id, original.asset_id)
        with transaction(database) as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM content_asset_relocation").fetchone()[0], 0
            )

    def test_registered_rename_collision_uses_final_binding(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "original.md", b"complete")
        )
        self.content.create_bytes(self.project.id, "resources", "occupied.md", b"other")
        renamed = self.content.rename(self.project.id, original.path, "occupied.md")
        self.assertEqual(renamed.path, "resources/occupied (2).md")
        self.assertEqual(renamed.asset_id, original.asset_id)
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), renamed)

    def test_relocation_recovery_does_not_adopt_a_replacement(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "original.md", b"complete")
        )

        def interrupted(scope, path, name, *, destination=None):
            renamed = rename_node(scope, path, name, destination=destination)
            target = Path(self.project.root) / renamed.path
            clone = target.with_name("replacement.md")
            shutil.copy2(target, clone)
            target.unlink()
            clone.rename(target)
            raise ContentError("interrupted_after_replacement")

        with patch("service.content.service.assets.rename_node", side_effect=interrupted):
            with self.assertRaises(ContentError):
                self.content.rename(self.project.id, original.path, "renamed.md")
        with self.assertRaises(ContentError):
            self.content.asset(self.project.id, original.asset_id)
        self.assertEqual(
            (Path(self.project.root) / "resources/renamed.md").read_bytes(), b"complete"
        )
        unrelated = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "unrelated.md", b"unrelated")
        )
        self.assertEqual(self.content.asset(self.project.id, unrelated.asset_id), unrelated)
        renamed = self.content.rename(self.project.id, unrelated.path, "unrelated-renamed.md")
        self.assertEqual(renamed.asset_id, unrelated.asset_id)

    def test_rename_avoids_an_existing_hardlink_without_ambiguous_intent(self) -> None:
        original = self.content.materialize(
            self.content.prepare_bytes(self.project.id, "resources", "original.md", b"complete")
        )
        target = Path(self.project.root) / original.path
        os.link(target, target.with_name("alias.md"))
        renamed = self.content.rename(self.project.id, original.path, "alias.md")
        self.assertEqual(renamed.path, "resources/alias (2).md")
        self.assertEqual(self.content.asset(self.project.id, original.asset_id), renamed)
        self.assertEqual(target.with_name("alias.md").read_bytes(), b"complete")
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM content_asset_relocation").fetchone()[0], 0
            )

    def test_unsupported_exclusive_rename_does_not_fall_back(self) -> None:
        source = self.content.create_bytes(self.project.id, "resources", "source.md", b"source")
        with patch("service.content.service.native._RENAME", None):
            with self.assertRaises(ContentError) as caught:
                self.content.rename(self.project.id, source.path, "renamed.md")
        self.assertEqual(caught.exception.code, "rename_failed")
        self.assertTrue((Path(self.project.root) / source.path).exists())
        self.assertFalse((Path(self.project.root) / "resources" / "renamed.md").exists())

    def test_completed_import_rejects_another_valid_asset_identity(self) -> None:
        writer = ResourceWriter(self.content)
        first = writer.import_once(
            self.project.id, "first-operation", "first-publication", "first.md", b"first"
        )
        second = writer.import_once(
            self.project.id, "second-operation", "second-publication", "second.md", b"second"
        )
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            connection.execute(
                "UPDATE resources_import_operation SET asset_id = ? WHERE operation_id = ?",
                (second.asset_id, "first-operation"),
            )
        with self.assertRaises(ResourceWriterError):
            writer.import_once(
                self.project.id, "first-operation", "first-publication", "first.md", b"first"
            )
        self.assertEqual((Path(self.project.root) / first.path).read_bytes(), b"first")
        self.assertEqual((Path(self.project.root) / second.path).read_bytes(), b"second")
        with transaction(database) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT asset_id FROM resources_import_operation WHERE operation_id = ?",
                    ("first-operation",),
                ).fetchone()[0],
                second.asset_id,
            )

    def test_content_completion_survives_resource_result_interruption(self) -> None:
        materialize = self.content.materialize
        completed = []

        def interrupt_after_content(prepared):
            asset = materialize(prepared)
            completed.append(asset)
            raise ContentError("interrupted_after_content_commit")

        with patch.object(self.content, "materialize", side_effect=interrupt_after_content):
            with self.assertRaises(ResourceWriterError):
                ResourceWriter(self.content).import_once(
                    self.project.id, "operation", "publication", "identity.md", b"complete"
                )
        first = completed[0]
        target = Path(self.project.root) / first.path
        target.write_bytes(b"user edit after Content committed")
        second = ResourceWriter(self.content).import_once(
            self.project.id, "operation", "publication", "identity.md", b"complete"
        )
        self.assertEqual(second, first)
        self.assertEqual(target.read_bytes(), b"user edit after Content committed")

    def test_content_commit_failure_after_cleanup_recovers_exact_target(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "identity.md", b"complete"
        )

        @contextmanager
        def fail_commit(database):
            with transaction(database) as connection:
                yield connection
                raise ContentError("interrupted_content_commit")

        with patch("service.content.service.identity.transaction", new=fail_commit):
            with self.assertRaises(ContentError):
                self.content.materialize(prepared)
        target = Path(self.project.root) / prepared.path
        self.assertTrue(target.is_file())
        self.assertFalse((Path(self.project.root) / prepared.staging_path).exists())
        inode = target.stat().st_ino
        result = self.content.materialize(prepared)
        self.assertTrue(result.asset_id)
        self.assertEqual(target.stat().st_ino, inode)
        self.assertEqual(self.content.materialize(prepared), result)

    def test_registered_identity_rejects_a_clone_replacing_original(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "identity.md", b"complete"
        )
        asset = self.content.materialize(prepared)
        target = Path(self.project.root) / asset.path
        clone = target.with_name("clone.md")
        shutil.copy2(target, clone)
        target.unlink()
        clone.rename(target)
        with self.assertRaises(ContentError) as caught:
            self.content.asset(self.project.id, asset.asset_id)
        self.assertEqual(caught.exception.code, "prepared_content_conflict")
        self.assertEqual(target.read_bytes(), b"complete")

    def test_creation_token_is_bound_to_complete_receipt(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "identity.md", b"complete"
        )
        first = self.content.materialize(prepared)
        with self.assertRaises(ContentError) as caught:
            self.content.materialize(replace(prepared, sha256="0" * 64))
        self.assertEqual(caught.exception.code, "prepared_content_conflict")
        self.assertEqual(self.content.asset(self.project.id, first.asset_id), first)

    def test_recovery_without_staging_does_not_adopt_replacement(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "replaced.md", b"complete"
        )
        first = self.content.publish_prepared(prepared)
        self.content.release_prepared(prepared)
        target = Path(self.project.root) / first.path
        target.unlink()
        target.write_bytes(b"complete")
        inode = target.stat().st_ino
        with self.assertRaises(ContentError) as caught:
            self.content.publish_prepared(prepared)
        self.assertEqual(caught.exception.code, "prepared_content_conflict")
        self.assertEqual(target.stat().st_ino, inode)
        self.assertEqual(target.read_bytes(), b"complete")

    def test_recovery_requires_original_bytes_and_never_recreates_missing_target(self) -> None:
        prepared = self.content.prepare_bytes(
            self.project.id, "resources", "edited.md", b"complete"
        )
        first = self.content.publish_prepared(prepared)
        self.content.release_prepared(prepared)
        target = Path(self.project.root) / first.path
        target.write_bytes(b"modified")
        with self.assertRaises(ContentError) as caught:
            self.content.publish_prepared(prepared)
        self.assertEqual(caught.exception.code, "prepared_content_conflict")
        self.assertEqual(target.read_bytes(), b"modified")
        target.unlink()
        with self.assertRaises(ContentError) as missing:
            self.content.publish_prepared(prepared)
        self.assertEqual(missing.exception.code, "prepared_content_unavailable")
        self.assertFalse(target.exists())

    def test_completed_import_does_not_restore_deleted_or_replaced_target(self) -> None:
        writer = ResourceWriter(self.content)
        result = writer.import_once(
            self.project.id, "operation", "publication", "report.md", b"complete"
        )
        target = Path(self.project.root) / result.path
        target.unlink()
        with self.assertRaises(ResourceWriterError) as missing:
            writer.import_once(
                self.project.id, "operation", "publication", "report.md", b"complete"
            )
        self.assertEqual(missing.exception.code, "prepared_content_unavailable")
        target.symlink_to("user.md")
        (target.parent / "user.md").write_bytes(b"user-owned")
        with self.assertRaises(ResourceWriterError) as replaced:
            writer.import_once(
                self.project.id, "operation", "publication", "report.md", b"complete"
            )
        self.assertEqual(replaced.exception.code, "prepared_content_conflict")
        self.assertTrue(target.is_symlink())
        self.assertEqual((target.parent / "user.md").read_bytes(), b"user-owned")

    def test_concurrent_same_operation_returns_one_file(self) -> None:
        def import_result(_):
            return ResourceWriter(self.content).import_once(
                self.project.id, "operation", "publication", "report.md", b"complete"
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = tuple(executor.map(import_result, range(8)))
        self.assertEqual(len({result.path for result in results}), 1)
        parent = Path(self.project.root) / "resources" / "ai_extracts"
        self.assertEqual([path.name for path in parent.iterdir()], ["report.md"])

    def test_persisted_import_receipt_cannot_switch_project_scope(self) -> None:
        with patch.object(
            self.content, "publish_prepared", side_effect=ContentError("interrupted")
        ):
            with self.assertRaises(ResourceWriterError):
                ResourceWriter(self.content).import_once(
                    self.project.id, "operation", "publication", "report.md", b"complete"
                )
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            row = connection.execute(
                "SELECT prepared FROM resources_import_operation WHERE operation_id = ?",
                ("operation",),
            ).fetchone()
            receipt = json.loads(row["prepared"])
            receipt["project_id"] = "another-project"
            connection.execute(
                "UPDATE resources_import_operation SET prepared = ? WHERE operation_id = ?",
                (json.dumps(receipt), "operation"),
            )
        with self.assertRaises(ResourceWriterError) as caught:
            ResourceWriter(self.content).import_once(
                self.project.id, "operation", "publication", "report.md", b"complete"
            )
        self.assertEqual(caught.exception.code, "resource_import_operation_conflict")

    def test_prepare_rejects_ancestor_swap_before_directory_open(self) -> None:
        resources = Path(self.project.root) / "resources"
        (resources / "nested").mkdir()
        outside = Path(self.temporary.name) / "outside"
        (outside / "nested").mkdir(parents=True)
        original_open = ProjectSpace.open_directory

        def swap_then_open(scope, relative):
            resources.rename(resources.with_name("resources-original"))
            resources.symlink_to(outside, target_is_directory=True)
            return original_open(scope, relative)

        with patch.object(ProjectSpace, "open_directory", new=swap_then_open):
            with self.assertRaises(ContentError) as caught:
                self.content.prepare_bytes(
                    self.project.id, "resources/nested", "report.md", b"report"
                )
        self.assertEqual(caught.exception.code, "write_failed")
        self.assertEqual(list((outside / "nested").iterdir()), [])

    def test_publish_rejects_ancestor_swap_before_directory_open(self) -> None:
        resources = Path(self.project.root) / "resources"
        (resources / "nested").mkdir()
        prepared = self.content.prepare_bytes(
            self.project.id, "resources/nested", "report.md", b"report"
        )
        outside = Path(self.temporary.name) / "outside"
        (outside / "nested").mkdir(parents=True)
        original_open = ProjectSpace.open_directory

        def swap_then_open(scope, relative):
            resources.rename(resources.with_name("resources-original"))
            resources.symlink_to(outside, target_is_directory=True)
            return original_open(scope, relative)

        with patch.object(ProjectSpace, "open_directory", new=swap_then_open):
            with self.assertRaises(ContentError) as caught:
                self.content.publish_prepared(prepared)
        self.assertEqual(caught.exception.code, "prepared_content_unavailable")
        self.assertEqual(list((outside / "nested").iterdir()), [])

    def test_stage_name_swap_cannot_publish_unverified_bytes(self) -> None:
        prepared = self.content.prepare_bytes(self.project.id, "resources", "report.md", b"trusted")
        stage = Path(self.content.resolve(self.project.id, prepared.staging_path))
        target = Path(self.project.root) / prepared.path
        replacement = stage.with_name("replacement.bin")
        replacement.write_bytes(b"unverified")

        def swap_then_copy(source, directory, name, mode, *, marker=""):
            replacement.replace(stage)
            return copy_descriptor_exclusive(source, directory, name, mode, marker=marker)

        with patch(
            "service.content.service.assets.copy_descriptor_exclusive",
            side_effect=swap_then_copy,
        ) as copy:
            try:
                self.content.publish_prepared(prepared)
            except ContentError:
                pass
        copy.assert_called_once()
        self.assertEqual(stage.read_bytes(), b"unverified")
        if target.exists():
            self.assertEqual(target.read_bytes(), b"trusted")

    def test_unsupported_descriptor_publication_never_falls_back_to_path_link(self) -> None:
        prepared = self.content.prepare_bytes(self.project.id, "resources", "report.md", b"trusted")
        with patch(
            "service.content.service.assets.copy_descriptor_exclusive",
            side_effect=OSError(errno.ENOTSUP, "unsupported"),
        ):
            with self.assertRaises(ContentError):
                self.content.publish_prepared(prepared)
        self.assertFalse((Path(self.project.root) / prepared.path).exists())

    def test_ordinary_creation_syncs_the_final_inode(self) -> None:
        synced = []
        sync = os.fsync

        def record_sync(descriptor):
            identity = os.fstat(descriptor)
            synced.append((identity.st_dev, identity.st_ino))
            sync(descriptor)

        with patch("service.content.service.assets.os.fsync", side_effect=record_sync):
            result = self.content.create_bytes(
                self.project.id, "resources", "report.md", b"trusted"
            )
        identity = (Path(self.project.root) / result.path).stat()
        self.assertIn((identity.st_dev, identity.st_ino), synced)

    def test_windows_published_sync_keeps_the_writable_source_descriptor(self) -> None:
        resources = Path(self.project.root) / "resources"
        directory = open_directory(resources, ())
        descriptor = directory.open(
            ".windows-sync",
            os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW,
            0o600,
        )
        sync = os.fsync

        def reject_read_only(descriptor_to_sync: int) -> None:
            try:
                os.write(descriptor_to_sync, b"")
            except OSError as exc:
                raise AssertionError("published file was reopened read-only before fsync") from exc
            sync(descriptor_to_sync)

        try:
            os.write(descriptor, b"windows publish sync\n")
            os.rename(resources / ".windows-sync", resources / "windows-sync.md")
            with (
                patch("service.content.service.native.sys.platform", WINDOWS),
                patch(
                    "service.content.service.native.os.fsync",
                    side_effect=reject_read_only,
                ),
            ):
                sync_published_descriptor(descriptor, directory, "windows-sync.md")
        finally:
            os.close(descriptor)
            directory.close()

        self.assertEqual(
            (resources / "windows-sync.md").read_bytes(),
            b"windows publish sync\n",
        )

    def test_versioned_create_keeps_staging_descriptor_writable_through_publication(self) -> None:
        synced = []
        durable_sync = sync_published_descriptor

        def require_writable(source, directory, name):
            try:
                os.write(source, b"")
            except OSError as exc:
                raise AssertionError("staging descriptor is not writable") from exc
            synced.append(name)
            durable_sync(source, directory, name)

        with patch(
            "service.content.service.port.sync_published_descriptor",
            side_effect=require_writable,
        ):
            result = self.content.apply_bytes(
                self.project.id,
                "resources/imported.txt",
                b"imported\n",
                None,
                force=False,
                mode_bits=0o600,
            )

        self.assertEqual(result.path, "resources/imported.txt")
        self.assertEqual(
            (Path(self.project.root) / result.path).read_bytes(),
            b"imported\n",
        )
        self.assertEqual(synced, ["imported.txt"])

    def test_publication_does_not_follow_new_destination_symlink(self) -> None:
        prepared = self.content.prepare_bytes(self.project.id, "resources", "report.md", b"trusted")
        target = Path(self.project.root) / prepared.path
        outside = Path(self.temporary.name) / "outside-result.md"

        def redirect_then_copy(source, directory, name, mode, *, marker=""):
            target.symlink_to(outside)
            return copy_descriptor_exclusive(source, directory, name, mode, marker=marker)

        with patch(
            "service.content.service.assets.copy_descriptor_exclusive",
            side_effect=redirect_then_copy,
        ) as copy:
            with self.assertRaises(ContentError):
                self.content.publish_prepared(prepared)
        copy.assert_called_once()
        self.assertTrue(target.is_symlink())
        self.assertFalse(outside.exists())

    def test_receipt_without_creation_marker_is_unavailable_not_reimported(self) -> None:
        result = ResourceWriter(self.content).import_once(
            self.project.id, "operation", "publication", "report.md", b"trusted"
        )
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            row = connection.execute(
                "SELECT prepared FROM resources_import_operation WHERE operation_id = ?",
                ("operation",),
            ).fetchone()
            receipt = json.loads(row["prepared"])
            receipt.pop("marker")
            connection.execute(
                "UPDATE resources_import_operation SET prepared = ? WHERE operation_id = ?",
                (json.dumps(receipt), "operation"),
            )
        with self.assertRaises(ResourceWriterError) as caught:
            ResourceWriter(self.content).import_once(
                self.project.id, "operation", "publication", "report.md", b"trusted"
            )
        self.assertEqual(caught.exception.code, "resource_import_operation_unavailable")
        target = Path(self.project.root) / result.path
        self.assertEqual(target.read_bytes(), b"trusted")
        self.assertEqual([path.name for path in target.parent.iterdir()], ["report.md"])

    def test_ordinary_creation_keeps_replacement_stage_during_cleanup(self) -> None:
        resources = Path(self.project.root) / "resources"
        replacement = resources / "replacement.bin"
        replacement.write_bytes(b"user-owned")
        staged = []

        def swap_then_publish(source, directory, name):
            stage = next(resources.glob(".create-*"))
            staged.append(stage)
            replacement.replace(stage)
            return publish_descriptor(source, directory, name)

        with patch(
            "service.content.service.assets.publish_descriptor", side_effect=swap_then_publish
        ):
            with self.assertRaises(ContentError):
                self.content.create_bytes(self.project.id, "resources", "report.md", b"trusted")
        self.assertEqual(len(staged), 1)
        self.assertEqual(staged[0].read_bytes(), b"user-owned")
        target = resources / "report.md"
        if target.exists():
            self.assertEqual(target.read_bytes(), b"trusted")


if __name__ == "__main__":
    unittest.main()
