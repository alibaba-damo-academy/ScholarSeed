"""Cross-ledger recovery must use exact durable turn evidence, never later bytes."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.service.terminals import TurnTerminalReader
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.resources import ResourceTurn
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore


class Settings:
    def max_versions_per_file(self):
        return 50

    def max_version_file_size_kb(self):
        return 1024

    def version_ignore_patterns(self):
        return ()

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


class TerminalContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="resource-terminal-")
        root = Path(self.temp.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog)
        self.project = registry.create("终态")
        self.path = Path(self.project.root) / "resources/notes.md"
        self.path.write_bytes(b"before\n")
        retention = ResourceRetentionService(self.content, Settings())
        annotations = PdfRecordStore(self.content)
        self.versions = ResourceVersionService(
            self.content, retention, WorkbenchFormatPolicy(), annotations
        )
        self.supervisor = ResourceVersionSupervisor(
            self.content, self.versions, WorkbenchFormatPolicy(), Settings()
        )
        self.deliveries = ResourceDeliveryService(self.content, self.versions, self.supervisor)
        self.supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                ResourceRecoveryService(self.content, retention, annotations),
                self.versions,
                self.deliveries,
                retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )
        self.catalog = SessionCatalogStore(root / "sessions.sqlite3")
        self.catalog.register(
            "session",
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id=None,
            runtime_workdir=self.project.root,
            project_path=self.project.root,
            output_root=str(root / "outputs"),
            codex_version="test",
            model_id="test",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="",
            created_at=1.0,
        )
        self.events = ProductEventStore(self.catalog.database)
        self.reader = TurnTerminalReader(self.catalog, self.events)
        self.ref = ResourceTurn("session", "client", "vendor", "codex:thread:1")
        await self.deliveries.begin_turn("session", "client", self.project.root)
        await self.deliveries.bind_turn("session", "client", "vendor", "codex:thread:1")
        self.path.write_bytes(b"after terminal, external content\n")
        await self.deliveries.record_change(
            "session", "vendor", str(self.path), "update", generation="codex:thread:1"
        )
        self.append("user_message", "client", {"client_turn_id": "client", "binding": "admitted"})

    async def asyncTearDown(self):
        await self.supervisor.aclose()
        self.temp.cleanup()

    def append(self, kind, turn="vendor", payload=None):
        return self.events.append(
            session_id="session",
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_turn_id=turn,
            vendor_item_id=None,
            kind=kind,
            payload=payload or {},
            idempotency_key=f"{kind}:{len(self.events.replay('session'))}",
        )

    def read(self, ref=None, root=None):
        return self.reader.terminal_outcome(root or self.project.root, ref or self.ref)

    async def test_restart_receives_completed_without_capturing_current_disk(self):
        terminal = self.append("turn_completed")
        self.append("user_message", payload={"client_turn_id": "client", "binding": "bound"})
        self.assertEqual(self.read().product_seq, terminal.product_seq)
        restarted = ResourceDeliveryService(self.content, self.versions, self.supervisor)
        restarted.bind_terminals(self.reader)
        with patch.object(self.content, "stable_snapshot", side_effect=AssertionError("late read")):
            restarted.recover_project(self.project.id, self.project.root)
            restarted.recover_project(self.project.id, self.project.root)
        entries, _ = restarted.finalizations(self.project.id, "session", cursor=None, limit=50)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].error, "terminal_snapshot_unavailable")
        self.assertFalse(entries[0].retryable)
        self.assertEqual(len(self.versions.history(self.project.id, "resources/notes.md")), 1)
        self.assertEqual(self.path.read_bytes(), b"after terminal, external content\n")

    async def test_durable_resource_binding_covers_missing_bound_message(self):
        self.append("turn_failed", "client")
        self.deliveries.bind_terminals(self.reader)
        self.deliveries.recover_project(self.project.id, self.project.root)
        self.assertEqual(
            self.versions.turn_state(self.project.id, "session", "client"), "finalizing"
        )
        self.assertEqual(len(self.versions.history(self.project.id, "resources/notes.md")), 1)

    async def test_absent_or_conflicting_evidence_preserves_running_fence(self):
        self.deliveries.bind_terminals(self.reader)
        self.deliveries.recover_project(self.project.id, self.project.root)
        self.assertEqual(self.versions.turn_state(self.project.id, "session", "client"), "running")
        self.append("turn_completed")
        self.append("turn_failed", "client")
        self.assertIsNone(self.read())
        self.deliveries.recover_project(self.project.id, self.project.root)
        self.assertEqual(self.versions.turn_state(self.project.id, "session", "client"), "running")

    async def test_reused_vendor_across_generations_is_not_reconciled(self):
        await self.deliveries.begin_turn("session", "second", self.project.root)
        await self.deliveries.bind_turn("session", "second", "vendor", "codex:thread:2")
        self.append("turn_completed")
        self.deliveries.bind_terminals(self.reader)
        self.deliveries.recover_project(self.project.id, self.project.root)
        self.assertEqual(self.versions.turn_state(self.project.id, "session", "client"), "running")

    async def test_pre_runtime_failure_and_interrupt_release_unbound_admission(self):
        self.deliveries.bind_terminals(self.reader)
        for client, terminal in (
            ("unbound-failed", "turn_failed"),
            ("unbound-interrupted", "turn_interrupted"),
        ):
            await self.deliveries.begin_turn("session", client, self.project.root)
            self.append("user_message", client, {"client_turn_id": client, "binding": "admitted"})
            self.append(terminal, client)
            self.deliveries.recover_project(self.project.id, self.project.root)
            self.assertEqual(
                self.versions.turn_state(self.project.id, "session", client), "completed"
            )

    async def test_unbound_admission_cannot_claim_successful_delivery(self):
        await self.deliveries.begin_turn("session", "unbound", self.project.root)
        self.append("user_message", "unbound", {"client_turn_id": "unbound", "binding": "admitted"})
        self.append("turn_completed", "unbound")
        self.deliveries.bind_terminals(self.reader)
        self.deliveries.recover_project(self.project.id, self.project.root)
        self.assertEqual(
            self.versions.turn_state(self.project.id, "session", "unbound"), "accepted"
        )

    async def test_cross_project_session_runtime_or_binding_is_rejected(self):
        self.append("turn_completed")
        self.assertIsNone(self.read(root=str(Path(self.project.root).parent)))
        self.assertIsNone(self.read(ResourceTurn("other", "client", "vendor", "codex:thread:1")))
        self.assertIsNone(self.read(ResourceTurn("session", "client", "vendor", "codex:other:1")))
        self.append("user_message", "elsewhere", {"client_turn_id": "client", "binding": "bound"})
        self.assertIsNone(self.read())

    async def test_unknown_requires_later_unambiguous_terminal(self):
        self.append("turn_unknown")
        self.assertIsNone(self.read())
        self.append("turn_completed")
        self.assertEqual(self.read().outcome.value, "completed")
        self.append("turn_unknown")
        self.assertIsNone(self.read())

    async def test_steering_message_does_not_replace_unique_resource_admission(self):
        self.append(
            "user_message", "steering", {"client_turn_id": "steering", "binding": "admitted"}
        )
        self.append("user_message", payload={"client_turn_id": "steering", "binding": "bound"})
        self.append("turn_completed")
        self.assertIsNotNone(self.read())

    async def test_conflict_incident_disqualifies_otherwise_completed_turn(self):
        self.append("turn_completed")
        self.append("runtime_incident", payload={"kind": "terminal_conflict"})
        self.assertIsNone(self.read())


if __name__ == "__main__":
    unittest.main()
