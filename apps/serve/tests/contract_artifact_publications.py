"""Project publication persistence contracts using real Content and SQLite stores."""

from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from scholarseed_runtime.contract.artifact import ArtifactRole
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.publications import PublicationConflictError
from service.chat.service.publication import (
    PublicationCommand,
    PublicationService,
    SessionArtifactStorage,
)
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.content import ArtifactScope, ArtifactScopeKind, RootKind


class PublicationContract(unittest.TestCase):
    def test_session_execution_paths_resolve_through_project_content(self):
        project_id = self.command.project_id
        root = self.content.root(project_id, RootKind.SESSIONS)
        directory = self.content.ensure_directory(project_id, root.path, "session")
        cwd = Path(self.content.resolve(project_id, directory.path))
        (cwd / "report.md").write_text("isolated output", encoding="utf-8")
        source = self.service.source_path(project_id, cwd, "report.md")
        publication = self.publish(replace(self.command, path=source))
        self.assertEqual(source, "sessions/session/report.md")
        self.assertEqual(self.content.read_artifact(publication.content), b"isolated output")
        self.assertIsNone(self.service.resource_destination(project_id, cwd / "report.md"))
        self.assertTrue(
            self.service.outside_session_root(
                project_id, self.source.parent / "artifacts/old", cwd / "report.md"
            )
        )
        self.assertFalse(self.service.outside_session_root(project_id, cwd, cwd / "report.md"))
        context = self.service.project_context(project_id, cwd)
        self.assertIn(str(cwd), context)
        self.assertIn(str(self.source.parent.resolve()), context)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="artifact-publication-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        workspace = self.root / "project"
        workspace.mkdir()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        project = registry.seed_workspace()
        self.content = ContentService(registry, catalog)
        self.service = PublicationService(self.content)
        self.source = workspace / "report.md"
        self.source.write_text("version one", encoding="utf-8")
        self.command = PublicationCommand(
            project.id,
            "session",
            "turn",
            "declaration",
            "report.md",
            ArtifactRole.FINAL,
            "研究报告",
        )

    def publish(self, command=None):
        return self.service.publish(command or self.command, provenance={"source": "directive"})

    def test_replay_keeps_original_revision_after_edit(self):
        first = self.publish()
        self.source.write_text("version two", encoding="utf-8")
        self.assertEqual(self.publish(), first)
        second = self.publish(replace(self.command, declaration_id="next", turn_id="next-turn"))
        self.assertNotEqual(first.publication_id, second.publication_id)
        self.assertEqual(self.content.read_artifact(first.content), b"version one")
        self.assertEqual(self.content.read_artifact(second.content), b"version two")

    def test_equivalent_sources_dedup_but_role_and_turn_remain_distinct(self):
        first = self.publish()
        bridge = self.service.publish(
            replace(self.command, declaration_id="bridge"), provenance={"source": "bridge"}
        )
        self.assertEqual(first, bridge)
        supporting = self.publish(
            replace(self.command, declaration_id="supporting", role=ArtifactRole.SUPPORTING)
        )
        later = self.publish(replace(self.command, declaration_id="later", turn_id="later"))
        self.assertEqual(
            len({first.publication_id, supporting.publication_id, later.publication_id}), 3
        )
        self.assertEqual(
            len(self.service.store(self.command.project_id).list_session("session")), 3
        )

    def test_declaration_identity_cannot_change_meaning(self):
        self.publish()
        with self.assertRaises(PublicationConflictError):
            self.publish(replace(self.command, title="changed"))
        with self.assertRaises(PublicationConflictError):
            self.publish(replace(self.command, path="other.md"))

    def test_pending_outbox_survives_reopen_and_scoped_ack(self):
        record = self.publish()
        recovered = PublicationService(self.content).store(self.command.project_id)
        self.assertEqual(recovered.list_session("session", pending_only=True), (record,))
        recovered.acknowledge("other-session", record.publication_id)
        self.assertEqual(recovered.list_session("session", pending_only=True), (record,))
        recovered.acknowledge("session", record.publication_id)
        self.assertEqual(recovered.list_session("session", pending_only=True), ())
        self.assertEqual(recovered.list_session("session"), (record,))
        self.publish(replace(self.command, declaration_id="duplicate"))
        self.assertEqual(recovered.list_session("session", pending_only=True), ())

    def test_intermediate_does_not_create_publication(self):
        with self.assertRaises(ValueError):
            self.publish(replace(self.command, role=ArtifactRole.INTERMEDIATE))
        self.assertEqual(self.service.store(self.command.project_id).list_session("session"), ())

    def test_session_scope_never_defaults_to_current_project(self):
        sessions = self.root / "sessions"
        workdir = sessions / "session"
        workdir.mkdir(parents=True)
        (workdir / "report.md").write_text("private session bytes", encoding="utf-8")
        catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        catalog.register(
            "session",
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id="process",
            runtime_workdir=str(workdir),
            project_path=None,
            output_root=str(workdir / "outputs"),
            codex_version="test",
            model_id="test",
            policy_id="safe-auto",
            status=SessionStatus.RUNNING,
            title="",
            created_at=1.0,
        )
        self.content.bind_artifact_scope(
            ArtifactScopeKind.SESSION, SessionArtifactStorage(catalog, sessions).resolve
        )
        projects = self.content.projects()
        publication = self.publish(replace(self.command, project_id=""))
        self.assertEqual(
            publication.content.scope, ArtifactScope(ArtifactScopeKind.SESSION, "session")
        )
        self.assertEqual(self.content.read_artifact(publication.content), b"private session bytes")
        self.assertEqual(self.source.read_text(encoding="utf-8"), "version one")
        self.assertEqual(self.content.projects(), projects)
        (workdir / "report.md").unlink()
        self.assertEqual(self.content.read_artifact(publication.content), b"private session bytes")
        self.assertEqual(self.service.store("", "session").database, catalog.database)
        catalog.relocate(
            "session",
            SessionPrincipal("owner"),
            runtime_workdir=str(self.source.parent),
            project_path=str(self.source.parent),
            output_root=str(self.source.parent),
        )
        self.assertEqual(self.content.read_artifact(publication.content), b"private session bytes")
        with self.assertRaises(ValueError):
            self.publish(replace(self.command, project_id="", session_id="unknown"))


if __name__ == "__main__":
    unittest.main()
