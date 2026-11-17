"""Deterministic source authorization and durable fork-prefix contracts."""

from __future__ import annotations

import asyncio
import logging
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, patch

from scholarseed_runtime.contract import CapabilitySet, RuntimeBinding, RuntimePermissionMode
from service.assistant.persistence.citations import CitationStore
from service.assistant.persistence.store import AssistantStore
from service.chat import utils as chat_utils
from service.chat.constants import (
    PRODUCT_EVENT_FILE_CHANGED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_MESSAGE_QUEUED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_USER_MESSAGE,
)
from service.chat.persistence.artifacts import (
    ArtifactSource,
    ArtifactStatus,
    SessionArtifactStore,
    artifact_identity,
)
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStateConflictError,
    SessionStatus,
)
from service.chat.persistence.events import (
    SESSION_FORK_EVENT,
    SESSION_FORK_IMPORTED_KEY,
    SESSION_FORK_KEY,
    ProductEventStore,
)
from service.chat.runtime.live import LiveSession
from service.chat.service.artifacts import ArtifactReadError, ArtifactService
from service.chat.service.attachments import AttachmentService
from service.chat.service.sessions import (
    SESSION_FORK_INCOMPLETE,
    SESSION_FORK_INVALID,
    SESSION_FORK_SOURCE_CHANGED,
    SessionForkOrigin,
    SessionService,
)
from service.content.domain.model import PROJECT_STATE_DIRNAME
from service.paths import (
    SESSION_ATTACHMENT_DIRNAME,
    SESSION_OUTPUT_DIRNAME,
    session_attachment_root,
)
from service.platform.activity import Activities
from service.platform.context import AssistantTurnSnapshot, ProjectContextPolicy, SearchScope


class ForkTests(unittest.TestCase):
    def test_fork_inherits_only_prefix_snapshots_and_receipts_durably(self) -> None:
        snapshots = AssistantStore(self.catalog.database)
        receipts = CitationStore(self.catalog.database)
        snapshot = snapshots.create_snapshot(
            AssistantTurnSnapshot(
                "snapshot",
                "source",
                "client",
                0,
                None,
                ProjectContextPolicy.EXPLICIT_ONLY,
                SearchScope.DISABLED,
                "model",
                "admission",
            )
        )
        receipt = {"handle": "public-handle", "revision": "read-revision", "quote": "read text"}
        receipts.record("source", snapshot.snapshot_id, "source-key", receipt)
        self.append(
            "one",
            PRODUCT_EVENT_USER_MESSAGE,
            {
                "text": "question",
                "client_turn_id": "client",
                "assistant_snapshot_id": snapshot.snapshot_id,
            },
        )
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        snapshots.create_snapshot(replace(snapshot, snapshot_id="later", client_turn_id="later"))
        self.append(
            "two",
            PRODUCT_EVENT_USER_MESSAGE,
            {
                "text": "later",
                "client_turn_id": "later",
                "assistant_snapshot_id": "later",
            },
        )
        self.append("two", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})

        def inherit(source_id, target_id, payload, connection):
            snapshot_id = payload["assistant_snapshot_id"]
            inherited = snapshots.inherit_snapshot(source_id, target_id, snapshot_id, connection)
            if inherited:
                receipts.inherit_snapshot(source_id, snapshot_id, target_id, inherited, connection)
            return inherited

        self.service.bind_fork_snapshots(inherit)
        self.service._runtime.ensure_active = AsyncMock()
        self.register("rollback")
        self.events.append(
            session_id="rollback",
            runtime_id="codex",
            vendor_thread_id="thread-rollback",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={"source_session_id": "source", "source_product_seq": terminal.product_seq},
            idempotency_key=SESSION_FORK_KEY,
        )
        with patch.object(
            receipts, "inherit_snapshot", side_effect=OSError("receipt write failed")
        ):
            with self.assertRaises(OSError):
                asyncio.run(
                    self.service._restore_fork_history(
                        SimpleNamespace(id="rollback", restore_local_input_paths=lambda: None)
                    )
                )
        self.assertIsNone(snapshots.snapshot_for_turn("rollback", "client"))
        self.assertIsNone(self.events.by_key("rollback", SESSION_FORK_IMPORTED_KEY))
        source_id, through_seq = "source", terminal.product_seq
        for target_id in ("child", "grandchild"):
            self.register(target_id)
            self.events.append(
                session_id=target_id,
                runtime_id="codex",
                vendor_thread_id=f"thread-{target_id}",
                vendor_turn_id=None,
                vendor_item_id=None,
                kind=SESSION_FORK_EVENT,
                payload={"source_session_id": source_id, "source_product_seq": through_seq},
                idempotency_key=SESSION_FORK_KEY,
            )
            live = SimpleNamespace(id=target_id, restore_local_input_paths=lambda: None)
            asyncio.run(self.service._restore_fork_history(live))
            context = ProductEventStore(self.catalog.database).turn_context(target_id, "one")
            inherited_id = context.get("assistant_snapshot_id")
            self.assertIsNotNone(inherited_id)
            inherited = AssistantStore(self.catalog.database).snapshot_by_id(
                target_id, inherited_id
            )
            self.assertIsNotNone(inherited)
            self.assertNotEqual(inherited_id, snapshot.snapshot_id)
            self.assertEqual(inherited.client_turn_id, "client")
            self.assertEqual(receipts.get(target_id, inherited_id, "public-handle"), receipt)
            self.assertEqual(receipts.handles(target_id, inherited_id), ("public-handle",))
            self.assertIsNone(snapshots.snapshot_for_turn(target_id, "later"))
            self.assertIsNone(receipts.get("unrelated", inherited_id, "public-handle"))
            asyncio.run(self.service._restore_fork_history(live))
            source_id, through_seq = target_id, self.catalog.get(target_id).last_product_seq
        self.assertEqual(receipts.get("source", "snapshot", "public-handle"), receipt)
        legacy = self.register("legacy")
        self.events.append(
            session_id="legacy",
            runtime_id="codex",
            vendor_thread_id="thread-legacy",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={"source_session_id": "source", "source_product_seq": terminal.product_seq},
            idempotency_key=SESSION_FORK_KEY,
        )
        self.events.inherit_history("source", legacy, terminal.product_seq)
        before = self.events.replay("legacy")
        asyncio.run(
            self.service._restore_fork_history(
                SimpleNamespace(id="legacy", restore_local_input_paths=lambda: None)
            )
        )
        self.assertEqual(self.events.replay("legacy"), before)
        inherited = snapshots.snapshot_for_turn("legacy", "client")
        self.assertIsNotNone(inherited)
        self.assertEqual(receipts.get("legacy", inherited.snapshot_id, "public-handle"), receipt)
        self.register("other-project")
        project = self.root / "other-project"
        project.mkdir()
        self.catalog.relocate(
            "other-project",
            self.owner,
            runtime_workdir=str(project),
            project_path=str(project),
            output_root=str(project),
        )
        with self.events.transaction() as connection:
            self.assertIsNone(
                snapshots.inherit_snapshot("source", "other-project", "snapshot", connection)
            )
        self.owner = SessionPrincipal(user_id="other")
        self.register("other-owner")
        with self.events.transaction() as connection:
            self.assertIsNone(
                snapshots.inherit_snapshot("source", "other-owner", "snapshot", connection)
            )

        for source_id in ("source", "child"):
            self.catalog.release(source_id, SessionPrincipal(user_id="owner"))
            for target_id in ("legacy", "grandchild"):
                with self.subTest(deleted=source_id, target=target_id):
                    before = self.events.replay(target_id)
                    binding = self.catalog.runtime_binding(target_id)
                    inherited = snapshots.snapshot_for_turn(target_id, "client")
                    assert inherited is not None
                    self.service._access = SessionCatalogStore(self.catalog.database)
                    self.service._events = ProductEventStore(self.catalog.database)
                    for _ in range(2):
                        asyncio.run(
                            self.service._restore_fork_history(
                                cast(
                                    LiveSession,
                                    SimpleNamespace(
                                        id=target_id, restore_local_input_paths=lambda: None
                                    ),
                                )
                            )
                        )
                    self.assertEqual(self.events.replay(target_id), before)
                    self.assertEqual(self.catalog.runtime_binding(target_id), binding)
                    self.assertEqual(
                        AssistantStore(self.catalog.database).snapshot_for_turn(
                            target_id, "client"
                        ),
                        inherited,
                    )
                    self.assertEqual(
                        CitationStore(self.catalog.database).get(
                            target_id, inherited.snapshot_id, "public-handle"
                        ),
                        receipt,
                    )

        unimported = self.register("unimported")
        with self.assertRaisesRegex(SessionStateConflictError, SESSION_FORK_SOURCE_CHANGED):
            self.events.inherit_history("source", unimported, terminal.product_seq)

    def test_workspace_copy_is_independent_and_excludes_private_runtime_files(self) -> None:
        source = self.root / "workspace"
        source.mkdir()
        (source / "outputs").mkdir()
        (source / "outputs" / "报告.md").write_text("original", encoding="utf-8")
        (source / ".codex").mkdir()
        (source / ".codex" / "auth.json").write_text("private", encoding="utf-8")
        (source / ".env").write_text("private", encoding="utf-8")
        (source / PROJECT_STATE_DIRNAME).mkdir()
        (source / PROJECT_STATE_DIRNAME / "prepare.lock").write_text("runtime", encoding="utf-8")
        target = self.root / "branch"
        chat_utils.copy_session_files(source, target)
        copied = target / "outputs" / "报告.md"
        self.assertEqual(copied.read_text(encoding="utf-8"), "original")
        copied.write_text("branch", encoding="utf-8")
        self.assertEqual((source / "outputs" / "报告.md").read_text(encoding="utf-8"), "original")
        self.assertFalse((target / ".codex").exists())
        self.assertFalse((target / ".env").exists())
        self.assertFalse((target / PROJECT_STATE_DIRNAME).exists())
        grandchild = self.root / "grandchild"
        chat_utils.copy_session_files(target, grandchild)
        copied.unlink()
        self.assertEqual((grandchild / "outputs" / "报告.md").read_text(encoding="utf-8"), "branch")

    def test_sequential_non_project_forks_keep_independent_outputs(self) -> None:
        source_id = "fork-source"
        source = self.root / source_id
        outputs = source / SESSION_OUTPUT_DIRNAME
        outputs.mkdir(parents=True)
        source_report = outputs / "report.md"
        source_report.write_text("original", encoding="utf-8")
        self.register(source_id, source, output_root=outputs)
        self.append("done", PRODUCT_EVENT_USER_MESSAGE, {"text": "question"}, source_id=source_id)
        self.append(
            "done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"}, source_id=source_id
        )
        source_history = self.events.portable_history(source_id)
        source_binding = self.catalog.runtime_binding(source_id)
        assert source_binding is not None

        async def bind_child(live):
            self.catalog.begin_open(live.id, live.id)
            self.catalog.bind_open(
                live.id,
                live.id,
                replace(
                    source_binding,
                    product_session_id=live.id,
                    opaque_session_ref=f"thread-{live.id}",
                ),
            )

        self.service._runtime.gateway_capabilities = CapabilitySet(())
        self.service._runtime.readiness = AsyncMock(
            return_value=SimpleNamespace(ready=True, executable="codex", version="0.165.0")
        )
        self.service._runtime.open = AsyncMock(
            side_effect=lambda **kwargs: SimpleNamespace(
                id=kwargs["session_id"],
                runtime_id=kwargs["runtime_id"],
                model_id=kwargs["model_id"],
                activate=AsyncMock(),
                aclose=AsyncMock(),
                restore_local_input_paths=lambda: None,
            )
        )
        self.service._runtime.ensure_active = bind_child
        self.service._settings = SimpleNamespace(runtime_executable=lambda: "codex")
        self.service._logger = logging.getLogger(__name__)
        body = {"fork_session_id": source_id, "fork_turn_id": "done"}
        reports = []
        with (
            patch("service.chat.service.sessions.SESSION_RUNTIME_DIR", self.root / "forks"),
            patch.object(
                self.service, "_snapshot", side_effect=lambda live, **_: {"session_id": live.id}
            ),
        ):
            for number, content in enumerate(("first branch", "second branch"), start=2):
                payload, status = self.open(body)
                self.assertEqual(status, 200, payload)
                child_id = payload["session_id"]
                self.assertEqual(
                    [entry.text for entry in self.events.portable_history(child_id)], ["question"]
                )
                child = self.catalog.get(child_id)
                self.assertEqual(child.title, f"{source_id}({number})")
                report = Path(child.output_root) / source_report.name
                self.assertEqual(report.read_text(encoding="utf-8"), "original")
                report.write_text(content, encoding="utf-8")
                reports.append(report)

        self.assertNotEqual(reports[0].parent, reports[1].parent)
        self.assertEqual(reports[0].read_text(encoding="utf-8"), "first branch")
        self.assertEqual(reports[1].read_text(encoding="utf-8"), "second branch")
        self.assertEqual(source_report.read_text(encoding="utf-8"), "original")
        self.assertEqual(self.events.portable_history(source_id), source_history)

    def test_workspace_copy_rejects_links_and_removes_partial_target(self) -> None:
        source = self.root / "workspace"
        source.mkdir()
        (source / "first.txt").write_text("first", encoding="utf-8")
        (source / "outside").symlink_to(self.root, target_is_directory=True)
        target = self.root / "branch"
        with self.assertRaises(OSError):
            chat_utils.copy_session_files(source, target)
        self.assertFalse(target.exists())

    def test_running_source_is_rejected_before_creating_a_branch(self) -> None:
        self.service._sessions["source"] = SimpleNamespace(
            lifecycle_lock=asyncio.Lock(), closing=False, running=True
        )
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            self.assertEqual(self.open({"fork_session_id": "source"})[1], 409)
        create.assert_not_called()

    def shared_source(self):
        self.catalog.relocate(
            "source",
            self.owner,
            runtime_workdir=str(self.root),
            project_path=str(self.root),
            output_root=str(self.root),
        )
        self.service._sessions["source"] = SimpleNamespace(
            lifecycle_lock=asyncio.Lock(), closing=False, running=True
        )

    def origin(self, turn="done", *, native=True):
        source = self.catalog.get("source")
        binding = self.catalog.runtime_binding("source")
        assert source is not None and binding is not None
        terminal = self.events.turn_completed("source", vendor_turn_id=turn)
        return SessionForkOrigin(
            "source",
            binding.opaque_session_ref,
            turn,
            terminal.product_seq if terminal else source.last_product_seq,
            native,
            source,
            binding,
        )

    def test_running_shared_source_forks_only_the_completed_native_prefix(self) -> None:
        self.shared_source()
        self.append("done", PRODUCT_EVENT_USER_MESSAGE, {"text": "first"})
        terminal = self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        self.append("active", PRODUCT_EVENT_USER_MESSAGE, {"text": "later"})
        self.append("queue", PRODUCT_EVENT_MESSAGE_QUEUED, {"text": "pending"})
        self.catalog.enqueue_message("source", "queued-after-anchor", {"message": "pending"})

        async def create(*args, fork_origin, **kwargs):
            self.assertFalse(self.service._sessions["source"].lifecycle_lock.locked())
            self.assertEqual(fork_origin.product_seq, terminal.product_seq)
            self.assertIsNone(await self.service._copy_fork_workspace(fork_origin, self.root))
            self.append("new", PRODUCT_EVENT_USER_MESSAGE, {"text": "new tail"})
            child = self.register("child")
            self.events.inherit_history("source", child, fork_origin.product_seq)
            self.assertEqual(
                [entry.text for entry in self.events.portable_history("child")], ["first"]
            )
            self.assertFalse(
                any(
                    event.kind == PRODUCT_EVENT_MESSAGE_QUEUED
                    for event in self.events.replay("child")
                )
            )
            self.assertEqual(self.catalog.queued_messages("child"), ())
            self.assertEqual(len(self.catalog.queued_messages("source")), 1)
            return {"session_id": "child"}, 200

        with (
            patch.object(self.service, "_create", side_effect=create),
            patch("service.chat.service.sessions.copy_session_files") as copy,
        ):
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 200
            )
        copy.assert_not_called()
        self.assertTrue(self.service._sessions["source"].running)

    def test_running_independent_source_still_rejects_a_completed_prefix(self) -> None:
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        self.service._sessions["source"] = SimpleNamespace(
            lifecycle_lock=asyncio.Lock(), closing=False, running=True
        )
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 409
            )
        create.assert_not_called()
        with self.assertRaises(ValueError):
            asyncio.run(self.service._copy_fork_workspace(self.origin(), self.root / "child"))

    def test_running_shared_source_rejects_incomplete_and_non_native_origins(self) -> None:
        self.shared_source()
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            for body in (
                {"fork_session_id": "source"},
                {"fork_session_id": "source", "fork_turn_id": "active"},
            ):
                self.assertEqual(self.open(body)[1], 409)
        create.assert_not_called()
        with self.assertRaises(ValueError):
            asyncio.run(self.service._copy_fork_workspace(self.origin(native=False), self.root))
        self.service._sessions["source"].closing = True
        with self.assertRaises(ValueError):
            asyncio.run(self.service._copy_fork_workspace(self.origin(), self.root))

    def test_workspace_copy_rechecks_source_identity_and_archive(self) -> None:
        self.shared_source()
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        origin = self.origin()
        source = self.catalog.get("source")
        for field, value in (
            ("runtime_workdir", str(self.root / "moved")),
            ("principal_id", "other"),
            ("archived", True),
        ):
            with (
                self.subTest(field=field),
                patch.object(self.catalog, "get", return_value=replace(source, **{field: value})),
            ):
                with self.assertRaises(ValueError):
                    asyncio.run(self.service._copy_fork_workspace(origin, self.root))
        binding = self.catalog.runtime_binding("source")
        with patch.object(
            self.catalog,
            "runtime_binding",
            return_value=replace(binding, opaque_session_ref="other-thread"),
        ):
            with self.assertRaises(ValueError):
                asyncio.run(self.service._copy_fork_workspace(origin, self.root))

    def test_import_rechecks_source_after_target_activation(self) -> None:
        self.shared_source()
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        expected = self.origin()
        self.register("child")
        self.events.append(
            session_id="child",
            runtime_id="codex",
            vendor_thread_id="thread-child",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={"source_session_id": "source", "source_product_seq": expected.product_seq},
            idempotency_key=SESSION_FORK_KEY,
        )

        async def activate(live):
            self.catalog.set_archived("source", self.owner, True)

        self.service._runtime.ensure_active = activate
        live = SimpleNamespace(id="child", restore_local_input_paths=lambda: None)
        with self.assertRaises(ValueError):
            asyncio.run(self.service._restore_fork_history(live, expected_origin=expected))
        self.assertIsNone(self.events.by_key("child", SESSION_FORK_IMPORTED_KEY))

    def test_failed_fork_is_closed_and_archived_not_resumable(self) -> None:
        self.shared_source()
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        origin = self.origin()
        live = SimpleNamespace(
            runtime_id="codex",
            model_id="model",
            activate=AsyncMock(side_effect=OSError("open failed")),
            aclose=AsyncMock(),
        )

        async def opened(**kwargs):
            live.id = kwargs["session_id"]
            return live

        self.service._runtime.gateway_capabilities = CapabilitySet(())
        self.service._runtime.readiness = AsyncMock(
            return_value=SimpleNamespace(ready=True, executable="codex", version="0.165.0")
        )
        self.service._runtime.open = opened
        self.service._settings = SimpleNamespace(
            runtime_executable=lambda: "codex", runtime_model=lambda: "model"
        )
        self.service._logger = SimpleNamespace(error=lambda *args, **kwargs: None)
        with (
            patch.object(
                self.service, "_new_paths", return_value=(self.root, self.root, self.root)
            ),
            patch.object(self.service, "_writable_roots", return_value=(self.root,)),
        ):
            payload, status = asyncio.run(
                self.service._create(
                    {"permission_mode": "ask", "model_id": "model"},
                    self.owner,
                    "owner",
                    fork_origin=origin,
                )
            )
        self.assertEqual(status, 500, payload)
        live.aclose.assert_awaited_once()
        self.assertNotIn(live.id, self.service._sessions)
        self.assertTrue(self.catalog.get(live.id).archived)
        self.assertEqual(asyncio.run(self.service._resume(live.id, self.owner, "owner"))[1], 409)

    def test_project_membership_does_not_make_different_workdirs_shared(self) -> None:
        project = self.root / "project"
        source = project / "sessions" / "source"
        source.mkdir(parents=True)
        (source / "report.md").write_text("old report", encoding="utf-8")
        self.catalog.relocate(
            "source",
            self.owner,
            runtime_workdir=str(source),
            project_path=str(project),
            output_root=str(source),
        )
        origin = self.origin(turn=None, native=False)
        with patch("service.chat.service.sessions.copy_session_files") as copy:
            copied = asyncio.run(self.service._copy_fork_workspace(origin, project))
        copy.assert_called_once_with(source, project)
        self.assertEqual(copied, str(source))

    def test_old_project_fork_allocates_an_independent_content_directory(self) -> None:
        project = self.root / "project"
        source = project / "sessions" / "source"
        self.catalog.relocate(
            "source",
            self.owner,
            runtime_workdir=str(source),
            project_path=str(project),
            output_root=str(source),
        )
        self.service._workspaces = SimpleNamespace(
            is_project=lambda path: path == project,
            allows=lambda **_values: True,
        )
        target = project / "sessions" / "child"
        directory = unittest.mock.Mock(return_value=target)
        self.service.bind_session_directory(directory)
        paths = self.service._new_paths(
            "child",
            str(project),
            self.owner,
            SimpleNamespace(session_id="source"),
        )
        self.assertEqual(paths, (target, project, target))
        directory.assert_called_once_with(project, "child")
        directory.reset_mock()
        self.assertEqual(
            self.service._new_paths("new", str(project), self.owner),
            (project, project, project),
        )
        directory.assert_not_called()

    def test_copied_branch_does_not_grant_write_access_to_source_or_project_parent(self) -> None:
        target_root = self.root / "child"
        self.register("child", target_root)
        self.events.append(
            session_id="child",
            runtime_id="codex",
            vendor_thread_id="thread-child",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={"copied_workspace": str(self.root / "source")},
            idempotency_key=SESSION_FORK_KEY,
        )
        other = self.root / "other"
        live = SimpleNamespace(
            id="child",
            _events=ProductEventStore(self.catalog.database),
            writable_roots=(self.root, self.root / "source", other),
            local_socket=None,
            network_domains=(),
        )
        permission = LiveSession.permission_intent(live, RuntimePermissionMode.SAFE_AUTO)
        self.assertEqual(permission.writable_roots, (other,))
        self.assertEqual(
            LiveSession.permission_intent(
                live, RuntimePermissionMode.SAFE_AUTO, writable_roots=(self.root,)
            ).writable_roots,
            (),
        )
        live.id = "source"
        self.assertEqual(
            LiveSession.permission_intent(live, RuntimePermissionMode.SAFE_AUTO).writable_roots,
            live.writable_roots,
        )

    def test_workspace_copy_preserves_binary_and_executable_without_overwriting_target(
        self,
    ) -> None:
        source = self.root / "workspace"
        source.mkdir()
        binary = source / "tool.bin"
        binary.write_bytes(bytes(range(256)))
        binary.chmod(0o700)
        target = self.root / "branch"
        chat_utils.copy_session_files(source, target)
        self.assertEqual((target / binary.name).read_bytes(), binary.read_bytes())
        with self.assertRaises(FileExistsError):
            chat_utils.copy_session_files(source, target)
        self.assertTrue((target / binary.name).is_file())

    def test_copied_history_rebases_attachments_and_working_artifacts(self) -> None:
        attachment = self.root / SESSION_ATTACHMENT_DIRNAME / "report.pdf"
        attachment.parent.mkdir()
        attachment.write_bytes(b"source upload")
        self.append(
            "one",
            PRODUCT_EVENT_USER_MESSAGE,
            {
                "text": "read report",
                "refs": [{"type": "file", "id": "upload", "path": str(attachment)}],
            },
        )
        source_event = self.append("one", PRODUCT_EVENT_FILE_CHANGED, {"path": "report.md"})
        (self.root / "report.md").write_text("source report", encoding="utf-8")
        artifacts = self.service._artifacts
        original = artifacts.index(
            session_id="source",
            runtime_id="codex",
            vendor_thread_id="thread-source",
            vendor_turn_id=source_event.vendor_turn_id,
            vendor_item_id=source_event.vendor_item_id,
            source_kind=ArtifactSource.FILE_CHANGE,
            source_product_seq=source_event.product_seq,
            original_path="report.md",
            canonical_path=str(self.root / "report.md"),
            role="output",
            status=ArtifactStatus.COMPLETED,
            idempotency_key="report",
            metadata={},
            mime_type="text/markdown",
            content_sha256=None,
            size_bytes=None,
        )
        target_root = self.root / "child"
        target_root.mkdir()
        (target_root / SESSION_ATTACHMENT_DIRNAME).mkdir()
        (target_root / SESSION_ATTACHMENT_DIRNAME / "report.pdf").write_bytes(b"branch upload")
        (target_root / "report.md").write_text("branch report", encoding="utf-8")
        target = self.register("child", target_root)
        with self.events.transaction() as connection:
            self.events.inherit_history(
                "source",
                target,
                source_event.product_seq,
                copied_workdir=target_root,
                connection=connection,
            )
            artifacts.inherit_history(
                "source",
                "child",
                source_event.product_seq,
                copied_workdir=target_root,
                connection=connection,
            )
        self.assertEqual(
            AttachmentService(self.catalog, self.events).source_path("child", "upload"),
            str(target_root / SESSION_ATTACHMENT_DIRNAME / "report.pdf"),
        )
        copied = artifacts.list_session("child")[0]
        self.assertNotEqual(artifact_identity(copied), artifact_identity(original))
        self.assertEqual(copied.session_id, "child")
        self.assertEqual(copied.canonical_path, str(target_root / "report.md"))
        service = ArtifactService(
            self.catalog,
            artifacts,
            self.events,
            SimpleNamespace(
                project=lambda *_args: SimpleNamespace(
                    can_edit=True, can_save=True, can_edit_artifact=True
                )
            ),
        )
        self.assertEqual(
            service.read_text("child", artifact_identity(copied))["content"], "branch report"
        )
        _body, _media, _editable, revision = service.read_document(
            "child", artifact_identity(copied)
        )
        service.write_raw("child", artifact_identity(copied), b"edited branch", revision)
        self.assertEqual((self.root / "report.md").read_text(encoding="utf-8"), "source report")
        Path(copied.canonical_path).unlink()
        self.assertTrue((self.root / "report.md").is_file())

    def test_copied_absolute_file_links_use_new_workdir_not_source(self) -> None:
        target_root = self.root / "child"
        target_root.mkdir()
        (target_root / "report.md").write_text("branch", encoding="utf-8")
        self.register("child", target_root)
        self.events.append(
            session_id="child",
            runtime_id="codex",
            vendor_thread_id="thread-child",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={"source_session_id": "source", "copied_workspace": str(self.root)},
            idempotency_key=SESSION_FORK_KEY,
        )
        self.assertEqual(
            self.service.file_content("child", str(self.root / "report.md"))["content"], "branch"
        )
        self.assertEqual(self.service.files("child", str(self.root))["root"], str(target_root))

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.catalog = SessionCatalogStore(self.root / "catalog.db")
        self.events = ProductEventStore(self.catalog.database)
        self.owner = SessionPrincipal(user_id="owner")
        self.source = self.register("source")
        self.service = SessionService(
            self.root,
            {},
            activities=Activities(),
            access=self.catalog,
            events=self.events,
            runtime=SimpleNamespace(runtime_id="codex"),
            workspaces=SimpleNamespace(),
            artifacts=SessionArtifactStore(self.catalog.database),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
            logger=SimpleNamespace(),
        )

    def register(
        self, session_id: str, workdir: Path | None = None, *, output_root: Path | None = None
    ):
        return self.catalog.register(
            session_id,
            self.owner,
            runtime_id="codex",
            vendor_thread_id=f"thread-{session_id}",
            vendor_session_id=None,
            runtime_workdir=str(workdir or self.root),
            project_path=None,
            output_root=str(output_root or self.root),
            codex_version="0.159.0",
            model_id="model",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=1,
            runtime_binding=RuntimeBinding(
                product_session_id=session_id,
                runtime_id="codex",
                adapter_version="0.2.1",
                runtime_version="0.159.0",
                protocol_version="2",
                protocol_schema_hash="schema",
                opaque_session_ref=f"thread-{session_id}",
                capabilities=CapabilitySet(()),
            ),
        )

    def append(self, turn: str, kind: str, payload: dict, *, source_id: str = "source"):
        return self.events.append(
            session_id=source_id,
            runtime_id="codex",
            vendor_thread_id=f"thread-{source_id}",
            vendor_turn_id=turn,
            vendor_item_id=f"{turn}:{kind}",
            kind=kind,
            payload=payload,
            idempotency_key=f"{turn}:{kind}",
        )

    def open(self, body: dict, principal=None):
        return asyncio.run(self.service.open(body, principal or self.owner, actor_id="owner"))

    def test_source_validation(self) -> None:
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            create.return_value = ({"session_id": "child"}, 200)
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 200
            )
            self.assertEqual(create.call_args.kwargs["fork_origin"].vendor_turn_id, "done")
            self.assertEqual(create.call_args.kwargs["display_parent_session_id"], "source")
            self.assertEqual(create.call_args.args[0]["model_id"], "model")
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "missing"})[0]["error"],
                SESSION_FORK_INCOMPLETE,
            )
            self.assertEqual(
                self.open(
                    {"fork_session_id": "source", "fork_turn_id": "done", "model_id": "override"}
                )[0]["error"],
                SESSION_FORK_INVALID,
            )
            with self.assertRaises(SessionAccessError):
                self.open(
                    {"fork_session_id": "source", "fork_turn_id": "done"},
                    SessionPrincipal(user_id="other"),
                )
            with patch.object(
                self.catalog,
                "runtime_binding",
                return_value=SimpleNamespace(opaque_session_ref="moved"),
            ):
                self.assertEqual(
                    self.open({"fork_session_id": "source", "fork_turn_id": "done"})[0]["error"],
                    SESSION_FORK_SOURCE_CHANGED,
                )
            self.assertEqual(create.call_count, 1)

    def test_child_fork_keeps_actual_source_and_shared_display_parent(self) -> None:
        self.register("child")
        self.catalog.set_display_parent("child", self.owner, "source")
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            create.return_value = ({"session_id": "sibling"}, 200)
            self.assertEqual(self.open({"fork_session_id": "child"})[1], 200)
            self.assertEqual(create.call_args.kwargs["display_parent_session_id"], "source")
            self.assertEqual(create.call_args.kwargs["fork_origin"].session_id, "child")

    def test_durable_prefix_is_bounded_and_independent(self) -> None:
        terminals = []
        for turn in ("one", "two", "three"):
            self.append(
                turn,
                PRODUCT_EVENT_USER_MESSAGE,
                {
                    "text": f"question {turn}",
                    "client_turn_id": turn,
                    "references": [{"private": "source-only"}],
                },
            )
            self.append(
                turn,
                PRODUCT_EVENT_MESSAGE_DELTA,
                {"delta": f"answer {turn}", "phase": "final_answer"},
            )
            terminals.append(
                self.append(turn, PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
            )
        target = self.register("child")
        before = self.events.replay("source")
        self.events.inherit_history("source", target, terminals[1].product_seq)
        self.events.inherit_history("source", target, terminals[1].product_seq)
        history = self.events.portable_history("child")
        self.assertEqual(
            [entry.text for entry in history],
            ["question one", "answer one", "question two", "answer two"],
        )
        self.assertEqual(before, self.events.replay("source"))
        self.assertTrue(
            all(record.vendor_thread_id == "thread-child" for record in self.events.replay("child"))
        )
        self.assertNotIn("source-only", str(self.events.replay("child")))
        reopened = ProductEventStore(self.catalog.database)
        self.assertEqual(reopened.portable_history("child"), history)

    def create_origin(self, source_id="source", turn_id=None, target_id="branch"):
        source = self.catalog.get(source_id)
        target = self.register(target_id)
        self.events.append(
            session_id=target.session_id,
            runtime_id="codex",
            vendor_thread_id=f"thread-{target_id}",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={
                "source_session_id": source_id,
                "source_turn_id": turn_id,
                "source_product_seq": source.last_product_seq,
            },
            idempotency_key=SESSION_FORK_KEY,
        )
        self.events.inherit_history(source_id, target, source.last_product_seq)
        return self.service.fork_origin(target_id, self.owner)

    def test_origin_uses_frozen_anchor_and_current_title(self) -> None:
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question"})
        answer = self.append("one", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "answer"})
        self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        origin = self.create_origin(turn_id="one")
        self.assertEqual(origin[1], 200)
        self.assertEqual(origin[0]["origin"]["status"], "available")
        self.assertEqual(
            origin[0]["origin"]["anchor"],
            {
                "turn_id": "one",
                "item_id": answer.vendor_item_id,
            },
        )
        self.append("later", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "later answer"})
        self.catalog.rename("source", self.owner, "renamed source")
        refreshed = self.service.fork_origin("branch", self.owner)[0]["origin"]
        self.assertEqual(refreshed["title"], "renamed source")
        self.assertEqual(refreshed["anchor"], origin[0]["origin"]["anchor"])
        self.assertEqual(refreshed["inherited_messages"], origin[0]["origin"]["inherited_messages"])

    def test_origin_session_snapshot_and_deleted_source_preserve_boundary(self) -> None:
        answer = self.append("streaming", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "partial"})
        initial = self.create_origin()[0]["origin"]
        self.assertEqual(initial["anchor"]["item_id"], answer.vendor_item_id)
        history = self.events.portable_history("branch")
        self.catalog.release("source", self.owner)
        deleted = self.service.fork_origin("branch", self.owner)[0]["origin"]
        self.assertEqual(deleted["status"], "deleted")
        self.assertIsNone(deleted["title"])
        self.assertEqual(deleted["inherited_messages"], initial["inherited_messages"])
        self.assertEqual(self.events.portable_history("branch"), history)

    def test_origin_permissions_do_not_disclose_source_metadata(self) -> None:
        self.append("one", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "inherited"})
        self.create_origin()
        with self.assertRaises(SessionAccessError):
            self.service.fork_origin("branch", SessionPrincipal(user_id="other"))
        original_require = self.catalog.require

        def require(session_id, principal):
            if session_id == "source":
                raise SessionAccessError("permission changed")
            original_require(session_id, principal)

        self.catalog.rename("source", self.owner, "private renamed title")
        self.append("private", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "private new answer"})
        with patch.object(self.catalog, "require", side_effect=require):
            origin = self.service.fork_origin("branch", self.owner)[0]["origin"]
        self.assertEqual(origin["status"], "forbidden")
        self.assertNotIn("private", str(origin))
        self.assertIsNone(origin["title"])

    def test_origin_without_fork_and_missing_anchor_are_explicit(self) -> None:
        self.assertIsNone(self.service.fork_origin("source", self.owner)[0]["origin"])
        origin = self.create_origin()[0]["origin"]
        self.assertEqual(origin["status"], "anchor_unavailable")

    def test_origin_of_child_branch_is_the_actual_child(self) -> None:
        self.append("one", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "answer"})
        self.create_origin()
        origin = self.create_origin(source_id="branch", target_id="grandchild")[0]["origin"]
        self.assertEqual(origin["source_session_id"], "branch")
        self.assertEqual(origin["navigation"]["session_id"], "branch")
        self.assertEqual(origin["anchor"]["turn_id"], "one")

    def test_detach_preserves_actual_sibling_origin_and_frozen_history(self) -> None:
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question"})
        answer = self.append("one", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "answer"})
        self.create_origin()
        self.catalog.set_display_parent("branch", self.owner, "source")
        self.create_origin(source_id="branch", target_id="sibling")
        self.catalog.set_display_parent("sibling", self.owner, "source")
        original = self.catalog.get("sibling")
        assert original is not None
        origin = self.service.fork_origin("sibling", self.owner)
        events = self.events.replay("sibling")
        history = self.events.portable_history("sibling")
        self.assertEqual(origin[0]["origin"]["source_session_id"], "branch")
        self.assertEqual(origin[0]["origin"]["navigation"]["session_id"], "branch")
        self.assertEqual(origin[0]["origin"]["anchor"]["item_id"], answer.vendor_item_id)
        self.assertEqual(
            self.service.detach("sibling", self.owner),
            {"ok": True, "session_id": "sibling", "display_parent_session_id": None},
        )
        self.assertEqual(
            self.catalog.get("sibling"),
            replace(
                original,
                display_parent_session_id=None,
                detached_parent_session_id=original.display_parent_session_id,
            ),
        )
        self.assertEqual(self.service.fork_origin("sibling", self.owner), origin)
        self.assertEqual(self.events.replay("sibling"), events)
        self.assertEqual(self.events.portable_history("sibling"), history)

    def test_detach_does_not_restore_unavailable_origin_or_discard_history(self) -> None:
        self.append("one", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "answer"})
        self.create_origin()
        self.catalog.set_display_parent("branch", self.owner, "source")
        self.create_origin(source_id="branch", target_id="sibling")
        history = self.events.portable_history("sibling")
        events = self.events.replay("sibling")
        for status in ("archived", "deleted"):
            with self.subTest(status=status):
                self.catalog.set_display_parent("sibling", self.owner, "source")
                if status == "archived":
                    self.catalog.set_archived("branch", self.owner, True)
                else:
                    self.catalog.release("branch", self.owner)
                    self.catalog.release("source", self.owner)
                origin = self.service.fork_origin("sibling", self.owner)
                self.assertEqual(origin[0]["origin"]["status"], status)
                self.assertIsNone(origin[0]["origin"]["navigation"])
                self.assertTrue(origin[0]["origin"]["inherited_messages"])
                self.assertTrue(self.service.detach("sibling", self.owner)["ok"])
                self.assertEqual(self.service.fork_origin("sibling", self.owner), origin)
                self.assertEqual(self.events.portable_history("sibling"), history)
                self.assertEqual(self.events.replay("sibling"), events)

    def test_detach_preserves_denied_source_status_without_source_access(self) -> None:
        self.append("one", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "answer"})
        self.create_origin()
        self.catalog.set_display_parent("branch", self.owner, "source")
        original_require = self.catalog.require

        def require(session_id, principal):
            if session_id == "source":
                raise SessionAccessError("source permission changed")
            original_require(session_id, principal)

        with patch.object(self.catalog, "require", side_effect=require):
            origin = self.service.fork_origin("branch", self.owner)
            self.assertEqual(origin[0]["origin"]["status"], "forbidden")
            self.assertIsNone(origin[0]["origin"]["navigation"])
            self.assertTrue(self.service.detach("branch", self.owner)["ok"])
            self.assertEqual(self.service.fork_origin("branch", self.owner), origin)

    def test_archived_and_missing_source_anchor_never_return_navigation(self) -> None:
        self.append("one", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "answer"})
        self.create_origin()
        self.catalog.set_archived("source", self.owner, True)
        archived = self.service.fork_origin("branch", self.owner)[0]["origin"]
        self.assertEqual(archived["status"], "archived")
        self.assertIsNone(archived["navigation"])
        self.catalog.set_archived("source", self.owner, False)
        original_history = self.events.portable_history

        def portable_history(session_id, **kwargs):
            return () if session_id == "source" else original_history(session_id, **kwargs)

        with patch.object(self.events, "portable_history", side_effect=portable_history):
            missing = self.service.fork_origin("branch", self.owner)[0]["origin"]
        self.assertEqual(missing["status"], "anchor_unavailable")
        self.assertIsNone(missing["navigation"])
        self.assertTrue(missing["inherited_messages"])

    def test_session_fork_captures_current_history_without_completed_turn(self) -> None:
        self.append("running", PRODUCT_EVENT_USER_MESSAGE, {"text": "question", "refs": []})
        partial = self.append("running", PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "partial"})
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            create.return_value = ({"session_id": "child"}, 200)
            self.assertEqual(self.open({"fork_session_id": "source"})[1], 200)
            origin = create.call_args.kwargs["fork_origin"]
            self.assertEqual(origin.product_seq, partial.product_seq)
            self.assertIsNone(origin.vendor_turn_id)

    def test_inherits_submitted_references_but_not_cancelled_messages(self) -> None:
        reference = {"type": "file", "id": "ref-one", "path": "report.md", "title": "report"}
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question", "refs": [reference]})
        self.append(
            "cancelled", PRODUCT_EVENT_USER_MESSAGE, {"text": "cancelled", "binding": "cancelled"}
        )
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        target = self.register("child")
        self.events.inherit_history("source", target, terminal.product_seq)
        messages = [
            event
            for event in self.events.replay("child")
            if event.kind == PRODUCT_EVENT_USER_MESSAGE
        ]
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].payload["refs"], [reference])
        self.catalog.release("source", self.owner)
        self.assertEqual(self.events.portable_history("child")[0].text, "question")

    def test_target_admission_releases_source_lifecycle(self) -> None:
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        lock = asyncio.Lock()
        self.service._sessions["source"] = SimpleNamespace(
            lifecycle_lock=lock, closing=False, running=False
        )

        async def create(*args, **kwargs):
            self.assertFalse(lock.locked())
            return {"session_id": "child"}, 200

        with patch.object(self.service, "_create", side_effect=create):
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 200
            )

    def test_artifacts_keep_original_identity_and_do_not_copy_files(self) -> None:
        source = self.append("one", PRODUCT_EVENT_FILE_CHANGED, {"path": "report.md"})
        path = self.root / "report.md"
        path.write_text("latest content", encoding="utf-8")
        artifacts = self.service._artifacts
        original = artifacts.index(
            session_id="source",
            runtime_id="codex",
            vendor_thread_id="thread-source",
            vendor_turn_id=source.vendor_turn_id,
            vendor_item_id=source.vendor_item_id,
            source_kind=ArtifactSource.FILE_CHANGE,
            source_product_seq=source.product_seq,
            original_path="report.md",
            canonical_path=str(path),
            role="output",
            status=ArtifactStatus.COMPLETED,
            idempotency_key="report",
            metadata={},
            mime_type="text/markdown",
            content_sha256=None,
            size_bytes=None,
        )
        target = self.register("child")
        before = sorted(self.root.iterdir())
        with self.events.transaction() as connection:
            self.events.inherit_history("source", target, source.product_seq, connection=connection)
            artifacts.inherit_history("source", "child", source.product_seq, connection=connection)
        linked = artifacts.list_session("child")
        self.assertEqual(len(linked), 1)
        self.assertEqual(linked[0].artifact_id, original.artifact_id)
        self.assertEqual(artifact_identity(linked[0]), artifact_identity(original))
        self.assertEqual(linked[0].canonical_path, str(path))
        self.assertEqual(path.read_text(encoding="utf-8"), "latest content")
        self.assertEqual(sorted(self.root.iterdir()), before)
        grandchild = self.register("grandchild")
        through = self.catalog.get("child").last_product_seq
        with self.events.transaction() as connection:
            self.events.inherit_history("child", grandchild, through, connection=connection)
            artifacts.inherit_history("child", "grandchild", through, connection=connection)
        self.assertEqual(
            artifact_identity(artifacts.list_session("grandchild")[0]), artifact_identity(original)
        )

    def test_reference_history_survives_reopening_and_is_available_to_context(self) -> None:
        reference = {"type": "file", "id": "ref-one", "path": "report.md", "title": "report"}
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question", "refs": [reference]})
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        target = self.register("child")
        self.events.inherit_history("source", target, terminal.product_seq)
        reopened = ProductEventStore(self.catalog.database)
        self.assertEqual(reopened.history_payload("child")[0]["refs"], [reference])
        self.assertIn(
            "report.md", reopened.portable_history("child", include_references=True)[0].text
        )
        self.append("later", PRODUCT_EVENT_USER_MESSAGE, {"text": "after the cutoff"})
        frozen = reopened.portable_history("source", through_seq=terminal.product_seq)
        self.assertEqual([entry.text for entry in frozen], ["question"])

    def test_inherited_upload_uses_original_workspace_without_copying(self) -> None:
        directory = self.root / SESSION_ATTACHMENT_DIRNAME
        directory.mkdir()
        path = directory / "report.pdf"
        path.write_bytes(b"original upload")
        self.append(
            "one",
            PRODUCT_EVENT_USER_MESSAGE,
            {
                "text": "read report",
                "refs": [{"type": "file", "id": "upload", "path": str(path)}],
            },
        )
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        target = self.register("child", self.root / "child")
        self.events.inherit_history("source", target, terminal.product_seq)
        attachments = AttachmentService(self.catalog, self.events)
        self.assertEqual(attachments.source_path("child", "upload"), str(path))
        self.assertFalse((self.root / "child").exists())

    def test_project_fork_inherits_only_the_original_private_attachment_authority(self) -> None:
        project = self.root / "project"
        project.mkdir()
        with patch("service.paths.SESSION_RUNTIME_DIR", self.root / "runtime"):
            self.catalog.relocate(
                "source",
                self.owner,
                runtime_workdir=str(project),
                project_path=str(project),
                output_root=str(project),
            )
            directory = session_attachment_root("source", project, project)
            directory.mkdir(parents=True)
            attachment = directory / "report.pdf"
            attachment.write_bytes(b"shared reference")
            unsubmitted = directory / "unsubmitted.pdf"
            unsubmitted.write_bytes(b"not referenced")
            self.append(
                "one",
                PRODUCT_EVENT_USER_MESSAGE,
                {
                    "text": "read report",
                    "refs": [{"type": "file", "id": "upload", "path": str(attachment)}],
                },
            )
            terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
            source_id = "source"
            through_seq = terminal.product_seq
            for target_id in ("child", "grandchild"):
                self.register(target_id, project)
                target = self.catalog.relocate(
                    target_id,
                    self.owner,
                    runtime_workdir=str(project),
                    project_path=str(project),
                    output_root=str(project),
                )
                self.events.inherit_history(source_id, target, through_seq)
                self.assertEqual(
                    AttachmentService(self.catalog, self.events).source_path(target_id, "upload"),
                    str(attachment),
                )
                self.assertEqual(
                    self.service.file_content(target_id, str(attachment))["content"],
                    "shared reference",
                )
                with self.assertRaises(ArtifactReadError):
                    AttachmentService(self.catalog, self.events).source_path(
                        target_id, str(unsubmitted)
                    )
                with self.assertRaises(ArtifactReadError):
                    self.service.file_content(target_id, str(unsubmitted))
                source_id = target_id
                through_seq = self.catalog.get(target_id).last_product_seq

    def test_archived_source_cannot_create_task(self) -> None:
        self.append("done", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        self.catalog.set_archived("source", self.owner, True)
        with patch.object(self.service, "_create", new_callable=AsyncMock) as create:
            self.assertEqual(
                self.open({"fork_session_id": "source", "fork_turn_id": "done"})[1], 409
            )
            create.assert_not_awaited()

    def test_bound_fork_recovers_interrupted_history_import(self) -> None:
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question"})
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        self.register("child")
        self.events.append(
            session_id="child",
            runtime_id="codex",
            vendor_thread_id="thread-child",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=SESSION_FORK_EVENT,
            payload={"source_session_id": "source", "source_product_seq": terminal.product_seq},
            idempotency_key=SESSION_FORK_KEY,
        )
        live = SimpleNamespace(id="child", restore_local_input_paths=lambda: None)
        self.service._runtime.ensure_active = AsyncMock()
        with patch.object(self.events, "inherit_history", side_effect=OSError("write failed")):
            with self.assertRaises(OSError):
                asyncio.run(self.service._restore_fork_history(live))
        self.assertIsNone(self.events.by_key("child", SESSION_FORK_IMPORTED_KEY))
        asyncio.run(self.service._restore_fork_history(live))
        self.assertEqual(
            [entry.text for entry in self.events.portable_history("child")], ["question"]
        )
        self.assertIsNotNone(self.events.by_key("child", SESSION_FORK_IMPORTED_KEY))
        with patch.object(
            self.events, "inherit_history", side_effect=AssertionError("already ready")
        ):
            asyncio.run(self.service._restore_fork_history(live))

    def test_prefix_import_rolls_back(self) -> None:
        self.append("one", PRODUCT_EVENT_USER_MESSAGE, {"text": "question"})
        terminal = self.append("one", PRODUCT_EVENT_TURN_COMPLETED, {"status": "completed"})
        target = self.register("child")
        append = self.events.append
        calls = 0

        def failing_append(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("write failed")
            return append(**kwargs)

        with patch.object(self.events, "append", side_effect=failing_append):
            with self.assertRaises(OSError):
                self.events.inherit_history("source", target, terminal.product_seq)
        self.assertEqual(self.events.replay("child"), ())


def main() -> int:
    result = unittest.TextTestRunner().run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ForkTests)
    )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
