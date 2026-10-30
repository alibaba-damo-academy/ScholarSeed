"""Task deletion preserves inputs, independent copies and sibling tasks."""

from __future__ import annotations

import asyncio
import logging
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.artifact import ArtifactRole
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.service.deletion import SessionDeletion
from service.chat.service.publication import (
    PublicationCommand,
    PublicationService,
    SessionArtifactStorage,
)
from service.chat.service.sessions import SessionService
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities
from service.platform.content import ArtifactScopeKind, RootKind
from service.platform.storage import remove_tree
from service.resources.api.routes import register_resource_routes
from service.resources.domain.model import AgentImportSourceKind
from service.resources.persistence.catalog import ResourceAgentImport, ResourceAgentImportCatalog


class DeletionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        workspace = self.root / "project"
        workspace.mkdir()
        content_catalog = ContentCatalog(self.root / "content.db")
        registry = ProjectRegistry(str(workspace), content_catalog)
        self.project = registry.seed_workspace()
        self.content = ContentService(registry, content_catalog, activities=Activities())
        self.catalog = SessionCatalogStore(self.root / "sessions.db")
        self.runtime = self.root / "private"
        self.content.bind_artifact_scope(
            ArtifactScopeKind.SESSION, SessionArtifactStorage(self.catalog, self.runtime).resolve
        )
        self.publications = PublicationService(self.content)
        self.deletion = SessionDeletion(self.content, self.publications, self.runtime)
        self.owner = SessionPrincipal("owner")

    def register(self, session_id="task"):
        root = self.content.root(self.project.id, RootKind.SESSIONS)
        directory = self.content.ensure_directory(self.project.id, root.path, session_id)
        workdir = Path(self.content.resolve(self.project.id, directory.path))
        return self.catalog.register(
            session_id,
            self.owner,
            runtime_id="codex",
            vendor_thread_id=session_id,
            vendor_session_id=None,
            runtime_workdir=str(workdir),
            project_path=self.project.root,
            output_root=str(workdir),
            codex_version="test",
            model_id="test",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=1,
        )

    def publish(self, record, name="report.md", content="result"):
        target = Path(record.runtime_workdir) / name
        target.write_text(content)
        return self.publications.publish(
            PublicationCommand(
                self.project.id,
                record.session_id,
                "turn",
                name,
                target.relative_to(Path(self.project.root)).as_posix(),
                ArtifactRole.FINAL,
            ),
            provenance={},
        )

    def test_deletes_owned_bytes_and_publications_but_keeps_inputs_and_copies(self):
        record = self.register()
        self.catalog.set_archived(record.session_id, self.owner, True)
        publication = self.publish(record)
        original = Path(self.project.root) / "original.md"
        original.write_text("input")
        resources = self.content.root(self.project.id, RootKind.RESOURCES)
        copy = Path(self.content.resolve(self.project.id, resources.path)) / "copy.md"
        copy.write_text("result")
        sibling = self.register("sibling")
        other = self.publish(sibling, content="other result")
        self.deletion.delete(record)
        self.assertFalse(Path(record.runtime_workdir).exists())
        self.assertEqual(self.publications.store(self.project.id).list_session("task"), ())
        self.assertEqual(original.read_text(), "input")
        self.assertEqual(copy.read_text(), "result")
        self.assertEqual(self.content.read_artifact(other.content), b"other result")
        with self.assertRaises(ContentError):
            self.content.read_artifact(publication.content)
        self.deletion.delete(record)

    def test_shared_snapshot_survives_until_last_task_is_deleted(self):
        first = self.register()
        second = self.register("second")
        self.publish(first)
        retained = self.publish(second)
        self.deletion.delete(first)
        self.assertEqual(self.content.read_artifact(retained.content), b"result")
        self.deletion.delete(second)
        with self.assertRaises(ContentError):
            self.content.read_artifact(retained.content)

    def session_service(self):
        service = SessionService(
            self.root,
            {},
            activities=Activities(),
            access=self.catalog,
            events=ProductEventStore(self.catalog.database),
            runtime=SimpleNamespace(),
            workspaces=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
            logger=logging.getLogger(__name__),
        )
        service.bind_deletion(self.deletion.delete)
        return service

    def test_archived_task_uses_full_service_deletion_without_restoring(self):
        record = self.register()
        self.catalog.set_archived(record.session_id, self.owner, True)
        self.publish(record)
        service = self.session_service()
        payload, status = asyncio.run(service.delete(record.session_id, self.owner))
        self.assertEqual(status, 200, payload)
        self.assertIsNone(self.catalog.get(record.session_id))
        self.assertFalse(Path(record.runtime_workdir).exists())

    def test_cleanup_failure_retains_catalog_and_allows_explicit_retry(self):
        record = self.register()
        self.publish(record)
        service = self.session_service()

        def denied(_record):
            raise ContentError("test denied")

        service.bind_deletion(denied)
        payload, status = asyncio.run(service.delete(record.session_id, self.owner))
        self.assertEqual(status, 500, payload)
        self.assertIsNotNone(self.catalog.get(record.session_id))
        service.bind_deletion(self.deletion.delete)
        self.assertEqual(asyncio.run(service.delete(record.session_id, self.owner))[1], 200)

    def test_retained_resource_origin_reports_deleted_task_without_losing_provenance(self):
        record = self.register()
        imports = ResourceAgentImportCatalog(self.content)
        imports.save(
            self.project.id,
            ResourceAgentImport(
                import_id="copy",
                resource_path="resources/copy.md",
                resource_revision=None,
                source_kind=AgentImportSourceKind.ARTIFACT,
                source_session_id=record.session_id,
                source_turn_id="turn",
                source_item_id=None,
                source_id="report",
                source_event_seq=None,
                source_detail=None,
                evidence_snapshot_id=None,
                evidence=None,
                conversation=None,
                schema_version=1,
                imported_at=1,
                updated_at=1,
            ),
        )
        app = FastAPI()
        app.state.content = self.content
        app.state.resource_agent_imports = imports
        app.state.session_catalog = self.catalog
        register_resource_routes(app)
        client = TestClient(app)
        query = {"project": self.project.id, "path": "resources/copy.md"}
        self.assertFalse(
            client.get("/api/resource/agent-origin", params=query).json()["session_deleted"]
        )
        self.assertEqual(
            asyncio.run(self.session_service().delete(record.session_id, self.owner))[1], 200
        )
        origin = client.get("/api/resource/agent-origin", params=query).json()
        self.assertTrue(origin["session_deleted"])
        self.assertEqual(origin["session_id"], record.session_id)
        self.assertEqual(imports.get(self.project.id, "resources/copy.md").source_id, "report")

    def test_shared_legacy_workdir_is_not_recursively_deleted(self):
        record = self.register()
        original = Path(self.project.root) / "original.md"
        original.write_text("input")
        self.deletion.delete(
            replace(record, runtime_workdir=self.project.root, output_root=self.project.root)
        )
        self.assertEqual(original.read_text(), "input")

    def test_symlink_never_deletes_outside_data(self):
        record = self.register()
        outside = self.root / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel"
        sentinel.write_text("keep")
        (Path(record.runtime_workdir) / "linked").symlink_to(outside, target_is_directory=True)
        try:
            remove_tree(Path(record.runtime_workdir).parent, (record.session_id,))
        except OSError:
            pass
        self.assertEqual(sentinel.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
