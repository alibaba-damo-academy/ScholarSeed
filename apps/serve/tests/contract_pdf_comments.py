"""Canonical PDF comments remain versioned user feedback, not evidence."""

from __future__ import annotations

import json
import sqlite3
import tempfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.assistant.persistence.store import AssistantStore
from service.assistant.service.citations import CitationService
from service.assistant.service.context import AssistantService
from service.chat.persistence.catalog import SessionCatalogStore
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.persistence import files as literature_files
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.records import AttachmentRecords
from service.platform.activity import Activities
from service.platform.bridge import PdfQuery
from service.platform.context import (
    AssistantContextBudget,
    AssistantContextResolveRequest,
    ContextAuthority,
    ContextRefKind,
    ContextResolutionState,
    ProjectContextPolicy,
    SearchScope,
)
from service.platform.records import PdfRecordSnapshot, RecordOwner, RecordTarget, record_revision
from service.workbench.api.comments import register_comment_routes
from service.workbench.service.comments import PdfCommentContext, PdfCommentError, decode_identity
from service.workbench.service.records import PdfRecordStore
from tests import pdf as pdf_fixture
from tests.contract_assistant_context import register_session
from tests.contract_pdf_records import _point_records, _stage_attachment


def real_owners() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        catalog = ContentCatalog(root / "content.sqlite3")
        content = ContentService(
            ProjectRegistry(str(root / "projects"), catalog), catalog, activities=Activities()
        )
        project = content.create_project("Comments")
        with pdf_fixture.open() as document:
            document.new_page()
            document.embfile_add(
                "scholarseed-annotations.json", json.dumps(_point_records()).encode()
            )
            payload = document.tobytes()
        path = Path(content.resolve(project.id, "paper.pdf"))
        path.write_bytes(payload)
        store = PdfRecordStore(content)
        snapshot = store.snapshot(project.id, "paper.pdf")
        files = root / "files"
        files.mkdir()
        repository = LiteratureRepository(root / "literature.sqlite3")
        repository.save(LiteratureItem(id="paper", title="Paper"))
        attachment = _stage_attachment(repository, files, "paper", "paper.pdf", payload, kind="pdf")
        attachments = LiteratureAttachmentContent(repository)
        shared = AttachmentRecords(attachments, repository)
        target = RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", attachment["id"])
        provider = PdfCommentContext(
            {
                RecordOwner.PROJECT_ASSET: store.peek_target,
                RecordOwner.LITERATURE_ATTACHMENT: shared.peek_target,
            }
        )
        external = root / "external"
        external.mkdir()
        (external / "external.pdf").write_bytes(payload)
        mounted = content.authorize_root(project.id, str(external), "external")
        external_snapshot = store.snapshot(project.id, f"{mounted.mount_path}/external.pdf")
        external_ref = provider.prepare(
            external_snapshot.record_target,
            "point",
            external_snapshot.source_revision,
            external_snapshot.record_revision,
        )[0]
        content.revoke_root(mounted.root_id, project.id)
        denied = provider.resolve(
            AssistantContextResolveRequest(
                "task", project.id, "", external_ref, AssistantContextBudget(10000, 1)
            )
        )
        assert denied.state is ContextResolutionState.FORBIDDEN and not denied.items
        app = FastAPI()
        app.state.pdf_comment_context = provider
        register_comment_routes(app)
        client = TestClient(app)
        statements = []
        original_connect = sqlite3.connect

        def connect(*args, **kwargs):
            connection = original_connect(*args, **kwargs)
            if args[0] != ":memory:":
                connection.set_trace_callback(statements.append)
            return connection

        with (
            patch("sqlite3.connect", side_effect=connect),
            patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files),
        ):
            library = shared.peek_target(target)
            for current in (snapshot, library):
                body = {
                    "record_target": current.record_target.response(),
                    "mark_id": "point",
                    "source_revision": current.source_revision,
                    "record_revision": current.record_revision,
                }
                response = client.post("/api/workbench/pdf-comments/prepare", json=body)
                assert response.status_code == 200, response.text
                ref = response.json()["refs"][0]
                preview = client.post(
                    "/api/workbench/pdf-comments/preview",
                    json={key: ref[key] for key in ("source_id", "source_revision")},
                )
                assert preview.status_code == 200 and preview.json()["comment"] == "User comment"
            assert not any(
                statement.lstrip()
                .upper()
                .startswith(("CREATE", "INSERT", "UPDATE", "DELETE", "ALTER", "BEGIN IMMEDIATE"))
                for statement in statements
            ), statements
        project_ref = provider.prepare(
            snapshot.record_target, "point", snapshot.source_revision, snapshot.record_revision
        )[0]
        path.write_bytes(payload + b"\n")
        stale = provider.resolve(
            AssistantContextResolveRequest(
                "task", project.id, "", project_ref, AssistantContextBudget(10000, 1)
            )
        )
        assert stale.state is ContextResolutionState.STALE
        path.unlink()
        removed = provider.resolve(
            AssistantContextResolveRequest(
                "task", project.id, "", project_ref, AssistantContextBudget(10000, 1)
            )
        )
        assert removed.state is ContextResolutionState.MISSING and not removed.items
        with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files):
            library_ref = provider.prepare(
                target, "point", library.source_revision, library.record_revision
            )[0]
            session_catalog = SessionCatalogStore(root / "sessions.sqlite3")
            register_session(session_catalog, "comment-task")
            assistant_store = AssistantStore(session_catalog.database)
            assistant = AssistantService(
                assistant_store, providers={ContextRefKind.PDF_COMMENT: provider}
            )
            selection = assistant.replace_selection(
                session_id="comment-task",
                expected_revision=0,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(library_ref,),
            )
            frozen = assistant.freeze(
                session_id="comment-task",
                client_turn_id="comment-turn",
                expected_revision=selection.revision,
                question="Read my feedback",
            )
            assert frozen.context is not None
            frozen_snapshot = frozen.context.snapshot
            assert frozen_snapshot.items[0].authority is ContextAuthority.USER_FEEDBACK
            assert "User comment" in frozen.context.model_context
            citations = CitationService(
                None,
                assistant_store.snapshot_for_turn,
                assistant_store.snapshot_by_id,
                lambda _: None,
                {ContextRefKind.PDF_COMMENT: object()},
                None,
                None,
            )
            assert (
                citations.query("comment-task", frozen_snapshot.snapshot_id, "list", PdfQuery())[
                    "sources"
                ]
                == []
            )
        repository.delete_attachment("paper", attachment["id"])
        missing = provider.resolve(
            AssistantContextResolveRequest(
                "task", project.id, "", library_ref, AssistantContextBudget(10000, 1)
            )
        )
        assert missing.state is ContextResolutionState.MISSING
        assert not missing.items
        assert (
            assistant_store.snapshot_by_id("comment-task", frozen_snapshot.snapshot_id)
            == frozen_snapshot
        )


def run() -> None:
    real_owners()
    target = RecordTarget(RecordOwner.PROJECT_ASSET, "project-one", "asset-one")
    records = _point_records()
    current = PdfRecordSnapshot(
        target, record_revision("source", records), "source", "available", records
    )
    provider = PdfCommentContext({target.owner: lambda selected: current})
    refs = provider.prepare(target, "point", current.source_revision, current.record_revision)
    assert len(refs) == 1
    ref = refs[0]
    assert ref.kind is ContextRefKind.PDF_COMMENT and ref.anchor is None
    assert "User comment" not in ref.source_id
    assert decode_identity(ref.source_id).target == target
    request = AssistantContextResolveRequest(
        "task", target.scope_id, "", ref, AssistantContextBudget(10000, 10)
    )
    result = provider.resolve(request)
    assert result.state is ContextResolutionState.READY
    item = result.items[0]
    assert item.authority is ContextAuthority.USER_FEEDBACK
    assert item.model_locator == "" and item.anchor is None
    assert item.surface["comment"] == "User comment"
    assert item.surface["point"] == [1.0, 0.0]
    assert "selected_text" not in item.surface
    assert (
        provider.resolve(replace(request, project_id="other")).state
        is ContextResolutionState.FORBIDDEN
    )
    assert (
        provider.resolve(replace(request, budget=AssistantContextBudget(1, 1))).state
        is ContextResolutionState.TOO_LARGE
    )
    for source_id in ("", "file:///tmp/comment", ref.source_id + "=", "pdf-comment:v2:e30"):
        try:
            decode_identity(source_id)
        except PdfCommentError:
            pass
        else:
            raise AssertionError(source_id)
    current = replace(current, record_revision="changed")
    assert provider.resolve(request).state is ContextResolutionState.STALE
    current = replace(
        current, record_revision=ref.source_revision, records={**records, "comments": []}
    )
    assert provider.resolve(request).state is ContextResolutionState.MISSING
    print("PDF comments: identity, authority, revision and scope passed")


if __name__ == "__main__":
    run()
