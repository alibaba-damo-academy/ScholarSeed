"""Asynchronous command ownership and shutdown; fixtures are not product acceptance."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from service.content.domain import naming
from service.content.domain.model import OPERATION_INTERRUPTED, ContentError, OperationState
from service.content.persistence.catalog import (
    AUDIT_REVOKE,
    AUTHORIZATION_SUPERSEDED,
    PROJECT_CREATION_PRESERVED,
    PROJECT_CREATION_RECOVERY_REQUIRED,
    CatalogFormatError,
    ContentCatalog,
    ExternalRootRow,
    ProjectCreationActive,
    ProjectRow,
)
from service.content.service.operations import (
    PROJECT_RECOVERY_PENDING,
    AdoptProject,
    ContentOperations,
    ReconcileAuthorization,
    ReconcileProjectCreation,
    ReconcileProjectRemoval,
    RecoveryAdmission,
    RevokeRoot,
    requires_postcommit_recovery,
)
from service.content.service.port import ProjectRegistry
from service.platform.activity import Activities, MaintenanceActive
from service.platform.content import ProjectLayout, ProjectRef
from service.platform.storage import LeaseError


class ContentOperationContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.catalog = ContentCatalog(Path(fixture.name) / "catalog.sqlite3")

    def running(self, identity="effect"):
        self.assertTrue(
            self.catalog.accept_operation(identity, "owner", "{}", limit=128, retention=3600)
        )
        self.catalog.start_operation(identity)
        return identity

    def pending_removal(self):
        self.catalog.insert_project(
            ProjectRow("project", "Project", str(self.catalog.path.parent), "managed", 1.0)
        )
        self.running("remove")
        self.catalog.begin_project_removal("remove", "project")
        return {"id": "project", "removed": True, "files_kept": True}

    def pending_creation(self):
        identity = "create"
        self.assertTrue(
            self.catalog.accept_operation(
                identity,
                "owner",
                json.dumps({"kind": "CreateProject", "parameters": {"name": "Project"}}),
                limit=128,
                retention=3600,
            )
        )
        self.catalog.start_operation(identity)
        plan = ProjectRow(
            "created", "Project", str(self.catalog.path.parent / "candidate"), "managed", 1.0
        )
        return self.catalog.begin_project_creation(identity, plan)

    def test_creation_plan_survives_recovery_without_registering_or_creating_directory(self):
        creation = self.pending_creation()
        inventory = ContentCatalog.read_roots(self.catalog.path)
        self.assertTrue(inventory.has_project_creations)
        self.assertFalse(inventory.has_pending_operations)
        self.assertEqual(inventory.projects, ())
        self.catalog.recover_operations()
        reopened = ContentCatalog(self.catalog.path)
        self.assertEqual(reopened.project_creations(), (creation,))
        self.assertEqual(reopened.operation_result("owner", "create")["state"], "running")
        self.assertFalse(Path(creation.plan.dir_root).exists())
        self.assertFalse(reopened.accept_operation("other", "owner", "{}", limit=1, retention=-1))
        with self.assertRaises(CatalogFormatError):
            reopened.finish_operation("create", OperationState.FAILED, None, "interrupted")

    def test_generated_creation_names_survive_catalog_readback(self):
        for requested, generated in (
            ("Project", "Project-2"),
            ("Project", "Project-10"),
            ("Research Project", "Research-Project"),
            ("CON", "project-CON"),
            ("???", "project"),
        ):
            with self.subTest(generated=generated):
                identity = generated
                self.catalog.accept_operation(
                    identity,
                    "owner",
                    json.dumps({"kind": "CreateProject", "parameters": {"name": requested}}),
                    limit=128,
                    retention=3600,
                )
                self.catalog.start_operation(identity)
                plan = ProjectRow(
                    identity, generated, str(self.catalog.path.parent / generated), "managed", 1.0
                )
                creation = self.catalog.begin_project_creation(identity, plan)
                self.assertIn(creation, ContentCatalog(self.catalog.path).project_creations())

    def test_generated_creation_name_rejects_unrelated_or_mismatched_directory(self):
        for display, directory in (
            ("Other", "Other"),
            ("Project-2", "Project-3"),
            ("Project-1", "Project-1"),
            ("Project-02", "Project-02"),
        ):
            with self.subTest(display=display, directory=directory):
                identity = directory
                self.catalog.accept_operation(
                    identity,
                    "owner",
                    json.dumps({"kind": "CreateProject", "parameters": {"name": "Project"}}),
                    limit=128,
                    retention=3600,
                )
                self.catalog.start_operation(identity)
                plan = ProjectRow(
                    identity, display, str(self.catalog.path.parent / directory), "managed", 1.0
                )
                with self.assertRaises(CatalogFormatError):
                    self.catalog.begin_project_creation(identity, plan)

    def test_default_creation_accepts_generated_suffix(self):
        identity = "default-create"
        self.catalog.accept_operation(
            identity,
            "owner",
            json.dumps({"kind": "EnsureDefaultProject", "parameters": {}}),
            limit=128,
            retention=3600,
        )
        self.catalog.start_operation(identity)
        name = f"{naming.DEFAULT_PROJECT_NAME}-2"
        plan = ProjectRow(identity, name, str(self.catalog.path.parent / name), "managed", 1.0)
        creation = self.catalog.begin_project_creation(identity, plan)
        self.assertIn(creation, ContentCatalog(self.catalog.path).project_creations())

    async def test_deferred_creation_waits_for_commit_and_close_joins_started_recovery(self):
        creation = self.pending_creation()
        self.assertTrue(requires_postcommit_recovery((creation,)))
        self.assertFalse(
            requires_postcommit_recovery((replace(creation, directory_identity="recorded"),))
        )
        ready = False
        activities = Activities(workbench_ready=lambda: ready)
        started, release = asyncio.Event(), asyncio.Event()

        async def recover(identity, command):
            self.assertTrue(ready)
            self.assertEqual(identity, creation.operation_id)
            started.set()
            await release.wait()
            raise ContentError("project_creation_provenance_required")

        operations = ContentOperations(activities, recover, self.catalog)
        before = self.catalog.operation_result("owner", "create")
        await operations.start(defer_until_open=True)
        await asyncio.sleep(0)
        self.assertFalse(started.is_set())
        self.assertEqual(self.catalog.operation_result("owner", "create"), before)
        self.assertFalse(Path(creation.plan.dir_root).exists())
        ready = True
        activities.workbench_changed()
        await asyncio.wait_for(started.wait(), 3)
        closing = asyncio.create_task(operations.aclose())
        try:
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
        finally:
            release.set()
            await asyncio.wait_for(closing, 3)
        self.assertTrue(operations._startup.done())
        self.assertTrue(operations._worker.done())
        self.assertEqual(self.catalog.project_creations()[0].plan, creation.plan)

    async def test_close_before_commit_does_not_start_deferred_recovery(self):
        creation = self.pending_creation()
        activities = Activities(workbench_ready=lambda: False)

        async def recover(identity, command):
            self.fail("precommit shutdown must not create a project")

        operations = ContentOperations(activities, recover, self.catalog)
        before = self.catalog.operation_result("owner", "create")
        await operations.start(defer_until_open=True)
        await asyncio.wait_for(operations.aclose(), 3)
        self.assertIsNone(operations._worker)
        self.assertEqual(self.catalog.project_creations(), (creation,))
        self.assertEqual(self.catalog.operation_result("owner", "create"), before)
        with self.assertRaises(MaintenanceActive):
            await asyncio.wait_for(operations.execute("owner", RevokeRoot("root")), 3)

    def test_creation_plan_and_receipt_identity_are_immutable(self):
        creation = self.pending_creation()
        self.assertEqual(self.catalog.begin_project_creation("create", creation.plan), creation)
        with self.assertRaises(CatalogFormatError):
            self.catalog.begin_project_creation(
                "create", replace(creation.plan, display_name="Changed")
            )
        self.catalog.record_project_creation_identity("create", "native-original")
        self.catalog.record_project_creation_identity("create", "native-original")
        with self.assertRaises(CatalogFormatError):
            self.catalog.record_project_creation_identity("create", "native-replacement")
        persisted = self.catalog.project_creations()[0]
        self.assertEqual(persisted.directory_identity, "native-original")
        self.assertEqual(persisted.nonce, creation.nonce)

    def test_creation_registration_requires_same_plan_operation_and_prepared_identity(self):
        creation = self.pending_creation()
        with self.assertRaises(CatalogFormatError):
            self.catalog.insert_project(creation.plan, effect=("create", {"id": "created"}))
        self.catalog.record_project_creation_identity("create", "native-original")
        for plan, effect in (
            (creation.plan, None),
            (creation.plan, ("other", {"id": "created"})),
            (replace(creation.plan, project_id="other"), ("create", {"id": "other"})),
            (
                replace(creation.plan, dir_root=str(self.catalog.path.parent / "other")),
                ("create", {"id": "created"}),
            ),
        ):
            with self.assertRaises(CatalogFormatError):
                self.catalog.insert_project(plan, effect=effect)
        self.assertEqual(self.catalog.projects(), ())
        self.assertEqual(len(self.catalog.project_creations()), 1)

    def test_creation_registration_effect_and_plan_consumption_are_atomic(self):
        creation = self.pending_creation()
        self.catalog.record_project_creation_identity("create", "native-original")
        result = {"id": creation.plan.project_id, "name": creation.plan.display_name}
        with patch.object(ContentCatalog, "_record_operation_effect", side_effect=OSError("full")):
            with self.assertRaises(OSError):
                self.catalog.insert_project(creation.plan, effect=("create", result))
        self.assertEqual(self.catalog.projects(), ())
        self.assertEqual(len(self.catalog.project_creations()), 1)
        self.catalog.insert_project(creation.plan, effect=("create", result))
        self.assertEqual(self.catalog.project_creations(), ())
        self.catalog.recover_operations()
        self.assertEqual(self.catalog.operation_result("owner", "create")["result"], result)
        self.assertEqual(self.catalog.projects(), (creation.plan,))

    def test_creation_corruption_is_retained_and_blocks_generic_recovery(self):
        self.pending_creation()
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            db.execute("UPDATE project_creations SET nonce = 'corrupt'")
        for inspect in (
            self.catalog.project_creations,
            self.catalog.recover_operations,
            lambda: ContentCatalog.read_roots(self.catalog.path),
        ):
            with self.assertRaises(CatalogFormatError):
                inspect()
        with closing(sqlite3.connect(self.catalog.path)) as db:
            self.assertEqual(
                db.execute("SELECT nonce FROM project_creations").fetchone()[0], "corrupt"
            )
        self.assertEqual(self.catalog.operation_result("owner", "create")["state"], "running")

    def test_creation_rejects_noncreation_command_without_persisting_plan(self):
        self.running()
        plan = ProjectRow(
            "created", "Project", str(self.catalog.path.parent / "candidate"), "managed", 1.0
        )
        with self.assertRaises(CatalogFormatError):
            self.catalog.begin_project_creation("effect", plan)
        self.assertEqual(self.catalog.project_creations(), ())

    def test_preserve_creation_keeps_files_and_is_owner_scoped_and_idempotent(self):
        creation = self.pending_creation()
        root = Path(creation.plan.dir_root)
        root.mkdir()
        user = root / "user.txt"
        user.write_bytes(b"preserve exactly")
        with self.assertRaises(ProjectCreationActive):
            self.catalog.preserve_project_creation("create", "owner")
        self.catalog.defer_project_creation("create")
        self.assertFalse(self.catalog.preserve_project_creation("create", "other"))
        self.assertTrue(self.catalog.preserve_project_creation("create", "owner"))
        self.assertTrue(self.catalog.preserve_project_creation("create", "owner"))
        self.assertEqual(self.catalog.project_creations(), ())
        self.catalog.recover_operations()
        self.assertEqual(
            self.catalog.operation_result("owner", "create")["error"], PROJECT_CREATION_PRESERVED
        )
        with self.assertRaises(CatalogFormatError):
            self.catalog.resume_project_creation("create", "owner")
        self.assertEqual(user.read_bytes(), b"preserve exactly")
        self.assertEqual(self.catalog.projects(), ())

    def test_preserve_creation_rolls_back_terminal_error_when_plan_delete_fails(self):
        self.pending_creation()
        self.catalog.defer_project_creation("create")
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            db.execute(
                "CREATE TRIGGER reject_preserve BEFORE DELETE ON project_creations BEGIN SELECT RAISE(ABORT, 'retained'); END"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.catalog.preserve_project_creation("create", "owner")
        self.assertEqual(len(self.catalog.project_creations()), 1)
        self.assertEqual(
            self.catalog.operation_result("owner", "create")["error"],
            PROJECT_CREATION_RECOVERY_REQUIRED,
        )

    async def test_creation_busy_refuses_startup_without_changing_durable_attempt(self):
        original = self.pending_creation()

        async def busy(identity, command):
            raise LeaseError("ERR_LEASE_BUSY")

        operations = ContentOperations(Activities(), busy, self.catalog)
        with self.assertRaises(ContentError):
            await operations.start()
        with self.assertRaises(CatalogFormatError):
            await operations.aclose()
        self.assertEqual(self.catalog.project_creations(), (original,))
        self.assertEqual(self.catalog.operation_result("owner", "create")["state"], "running")

    async def test_creation_recovery_failure_keeps_app_queue_and_owner_scoped_retry(self):
        creation = self.pending_creation()
        attempts = []

        async def reconcile(identity, command):
            self.assertIsInstance(command, ReconcileProjectCreation)
            self.assertEqual(command.project_id, creation.plan.project_id)
            attempts.append(identity)
            self.catalog.resume_project_creation(identity, command.owner)
            if len(attempts) == 1:
                raise ContentError("project_creation_provenance_required")
            self.catalog.record_project_creation_identity(identity, "native-original")
            result = {"id": creation.plan.project_id}
            self.catalog.insert_project(creation.plan, effect=(identity, result))
            return result

        operations = ContentOperations(Activities(), reconcile, self.catalog)
        await operations.start()
        try:
            result = operations.result("owner", "create")
            self.assertEqual(result["state"], "failed")
            self.assertEqual(result["error"], PROJECT_CREATION_RECOVERY_REQUIRED)
            self.assertEqual(operations.creation_recoveries("other"), [])
            self.assertEqual(len(operations.creation_recoveries("owner")), 1)
            self.catalog.recover_operations()
            self.assertEqual(operations.result("owner", "create"), result)
            with self.assertRaises(ContentError):
                operations.retry_creation("other", "create")
            with self.assertRaises(ContentError):
                operations.preserve_creation("other", "create")
            operations.retry_creation("owner", "create")
            with self.assertRaises(MaintenanceActive):
                operations.retry_creation("owner", "create")
            with self.assertRaises(MaintenanceActive):
                operations.preserve_creation("owner", "create")
            await operations._wait_finished(operations._operations["create"])
            self.assertEqual(attempts, ["create", "create"])
            self.assertEqual(operations.result("owner", "create")["state"], "succeeded")
            self.assertEqual(operations.creation_recoveries("owner"), [])
        finally:
            await operations.aclose()

    async def test_candidate_cannot_retry_or_preserve_creation_before_health_commit(self):
        self.pending_creation()
        ready = False
        attempts = []

        async def recover(identity, command):
            attempts.append(identity)
            raise ContentError("project_creation_provenance_required")

        operations = ContentOperations(
            Activities(workbench_ready=lambda: ready), recover, self.catalog
        )
        await operations.start()
        try:
            before = self.catalog.project_creations()
            outcome = self.catalog.operation_result("owner", "create")
            for action in (operations.retry_creation, operations.preserve_creation):
                with self.assertRaises(MaintenanceActive):
                    action("owner", "create")
                self.assertEqual(self.catalog.project_creations(), before)
                self.assertEqual(self.catalog.operation_result("owner", "create"), outcome)
                self.assertEqual(attempts, ["create"])
                self.assertTrue(operations._queue.empty())
            # Native workbench commitment opens user decisions; startup's
            # recovery exemption must not open these two mutation entrances.
            ready = True
            operations.preserve_creation("owner", "create")
            self.assertEqual(self.catalog.project_creations(), ())
            self.assertEqual(
                self.catalog.operation_result("owner", "create")["error"],
                PROJECT_CREATION_PRESERVED,
            )
        finally:
            await operations.aclose()

    async def test_startup_removal_completion_keeps_native_frozen_timestamp(self):
        result = self.pending_removal()
        stamp = 1800000000.0

        async def recover(identity, command):
            self.assertIsInstance(command, ReconcileProjectRemoval)
            self.catalog.delete_project(command.project_id, effect=(identity, result), now=stamp)
            return result

        operations = ContentOperations(Activities(), recover, self.catalog, recovery_at=stamp)
        await operations.start()
        try:
            self.assertEqual(operations.result("owner", "remove")["result"], result)
            with closing(sqlite3.connect(self.catalog.path)) as connection:
                row = connection.execute(
                    "SELECT updated_at FROM content_operations WHERE operation_id=?", ("remove",)
                ).fetchone()
                self.assertEqual(row, (stamp,))
        finally:
            await operations.aclose()

    def test_creation_resume_and_defer_projection_match_live_owner_rows(self):
        creation = self.pending_creation()
        with (
            closing(sqlite3.connect(self.catalog.path)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            before = tuple(source.iterdump())
            with self.assertRaises(ValueError):
                ContentCatalog.defer_project_creation_rows(projected, "create", now=1234.0)
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                with self.assertRaises(CatalogFormatError):
                    ContentCatalog.resume_project_creation_rows(
                        projected, "create", "other", now=1234.0
                    )
                resumed = ContentCatalog.resume_project_creation_rows(
                    projected, "create", "owner", now=1234.0
                )
                self.assertEqual(resumed, creation)
                ContentCatalog.defer_project_creation_rows(projected, "create", now=1234.0)
            ContentCatalog.inspect_rows(projected)
            expected = tuple(projected.iterdump())
            self.assertEqual(tuple(source.iterdump()), before)
            self.catalog.resume_project_creation("create", "owner", now=1234.0)
            self.catalog.defer_project_creation("create", now=1234.0)
            self.assertEqual(tuple(source.iterdump()), expected)
            self.assertEqual(self.catalog.project_creations(), (creation,))
            self.assertFalse(Path(creation.plan.dir_root).exists())

    def test_creation_identity_and_registration_project_without_adopting_source_directory(self):
        creation = self.pending_creation()
        result = {"id": creation.plan.project_id}
        identity = "native-observed-directory"
        with (
            closing(sqlite3.connect(self.catalog.path)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            with self.assertRaises(ValueError):
                ContentCatalog.record_project_creation_identity_rows(projected, "create", identity)
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                ContentCatalog.record_project_creation_identity_rows(projected, "create", identity)
                with self.assertRaises(CatalogFormatError):
                    ContentCatalog.record_project_creation_identity_rows(
                        projected, "create", "replacement"
                    )
                ContentCatalog.insert_project_rows(
                    projected, creation.plan, effect=("create", result)
                )
                ContentCatalog.recover_operation_rows(projected, now=1234.0)
            ContentCatalog.inspect_rows(projected)
            expected = tuple(projected.iterdump())
            self.assertEqual(self.catalog.project_creations(), (creation,))
            self.assertIsNone(self.catalog.project(creation.plan.project_id))
            self.catalog.record_project_creation_identity("create", identity)
            self.catalog.insert_project(creation.plan, effect=("create", result))
            self.catalog.finish_operation(
                "create", OperationState.SUCCEEDED, result, None, now=1234.0
            )
            self.assertEqual(tuple(source.iterdump()), expected)
            self.assertFalse(Path(creation.plan.dir_root).exists())

    async def test_creation_startup_uses_frozen_time_but_user_retry_does_not(self):
        self.pending_creation()
        clocks = []

        async def recover(identity, command):
            clocks.append(command.recovery_at)
            self.catalog.resume_project_creation(identity, command.owner, now=command.recovery_at)
            raise ContentError("project_creation_provenance_required")

        operations = ContentOperations(Activities(), recover, self.catalog, recovery_at=1234.0)
        await operations.start()
        try:
            with closing(sqlite3.connect(self.catalog.path)) as connection:

                def timestamp():
                    return connection.execute(
                        "SELECT updated_at FROM content_operations WHERE operation_id='create'"
                    ).fetchone()[0]

                self.assertEqual(timestamp(), 1234.0)
                operations.retry_creation("owner", "create")
                await operations._wait_finished(operations._operations["create"])
                self.assertNotEqual(timestamp(), 1234.0)
            self.assertEqual(clocks, [1234.0, None])
        finally:
            await operations.aclose()

    def test_project_removal_remains_pending_through_generic_recovery(self):
        result = self.pending_removal()
        inventory = ContentCatalog.read_roots(self.catalog.path)
        self.assertTrue(inventory.has_project_removals)
        self.assertFalse(inventory.has_pending_operations)
        self.catalog.recover_operations()
        self.assertEqual(self.catalog.operation_result("owner", "remove")["state"], "running")
        self.assertEqual(self.catalog.project_removals()[0].root, str(self.catalog.path.parent))
        with self.assertRaises(CatalogFormatError):
            self.catalog.finish_operation("remove", OperationState.SUCCEEDED, result, None)
        with self.assertRaises(CatalogFormatError):
            self.catalog.delete_project("project")
        self.assertIsNotNone(self.catalog.project("project"))
        self.assertFalse(
            self.catalog.accept_operation("other", "owner", "{}", limit=1, retention=-1)
        )

    def test_project_removal_effect_failure_rolls_back_every_catalog_change(self):
        result = self.pending_removal()
        root = ExternalRootRow("root", "project", str(self.catalog.path.parent), "external", 2.0)
        self.catalog.authorize_external_roots((root,))
        self.catalog.bump_cursor("project", "epoch")
        with patch.object(ContentCatalog, "_record_operation_effect", side_effect=OSError("full")):
            with self.assertRaises(OSError):
                self.catalog.delete_project("project", effect=("remove", result))
        self.assertIsNotNone(self.catalog.project("project"))
        self.assertIsNone(self.catalog.external_root("root").revoked_at)
        self.assertIsNotNone(self.catalog.cursor("project"))
        self.assertEqual(len(self.catalog.project_removals()), 1)
        self.assertEqual(len(self.catalog.audit()), 1)
        self.catalog.delete_project("project", effect=("remove", result))
        self.assertIsNone(self.catalog.project("project"))
        self.assertIsNotNone(self.catalog.external_root("root").revoked_at)
        self.assertIsNone(self.catalog.cursor("project"))
        self.assertEqual(self.catalog.project_removals(), ())
        self.assertEqual(ContentCatalog.read_roots(self.catalog.path).external, ())
        self.catalog.recover_operations()
        self.assertEqual(self.catalog.operation_result("owner", "remove")["result"], result)
        self.assertEqual(len(self.catalog.audit()), 2)

    def test_project_removal_projection_uses_live_owner_transition_without_source_writes(self):
        result = self.pending_removal()
        self.catalog.authorize_external_roots(
            (ExternalRootRow("root", "project", str(self.catalog.path.parent), "external", 2.0),)
        )
        self.catalog.bump_cursor("project", "epoch")
        stamp = 1800000000.0
        with (
            closing(sqlite3.connect(self.catalog.path)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            projected.execute("PRAGMA foreign_keys=ON")
            with self.assertRaises(ValueError):
                ContentCatalog.delete_project_rows(
                    projected, "project", now=stamp, effect=("remove", result)
                )
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                self.assertTrue(
                    ContentCatalog.delete_project_rows(
                        projected, "project", now=stamp, effect=("remove", result)
                    )
                )
                ContentCatalog.recover_operation_rows(projected, now=stamp)
            ContentCatalog.inspect_rows(projected)
            expected = tuple(projected.iterdump())
            self.assertIsNotNone(self.catalog.project("project"))
            self.assertIsNone(self.catalog.external_root("root").revoked_at)
            with patch("service.content.persistence.catalog.time.time", return_value=stamp):
                self.catalog.delete_project("project", effect=("remove", result))
                self.catalog.recover_operations()
            self.assertEqual(tuple(source.iterdump()), expected)

    def test_project_removal_invalid_identity_does_not_remove_project(self):
        self.pending_removal()
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            db.execute("UPDATE project_removals SET project_id = 'unknown'")
        for recover in (
            self.catalog.recover_operations,
            lambda: ContentCatalog.read_roots(self.catalog.path),
        ):
            with self.assertRaises(CatalogFormatError):
                recover()
        self.assertIsNotNone(self.catalog.project("project"))

    async def test_project_removal_recovers_before_authorization(self):
        result = self.pending_removal()
        self.pending_authorization()
        seen = []

        async def reconcile(identity, command):
            self.assertIsInstance(command, ReconcileProjectRemoval)
            seen.append(identity)
            self.catalog.delete_project(command.project_id, effect=(identity, result))
            return result

        operations = ContentOperations(Activities(), reconcile, self.catalog)
        await operations.start()
        self.assertEqual(seen, ["remove"])
        self.assertEqual(operations.result("owner", "grant")["error"], AUTHORIZATION_SUPERSEDED)
        self.assertEqual(operations.result("owner", "remove")["result"], result)
        await operations.aclose()

    async def test_project_removal_consumes_pending_authorization_without_relooking_its_root(self):
        result = self.pending_removal()
        self.pending_authorization()
        states = []

        def admission(command):
            if isinstance(command, ReconcileProjectRemoval):
                return RecoveryAdmission(command.project_id)
            records = self.catalog.authorization_reconciliations()
            self.assertEqual(len(records), 1, "consumed authorization identity was looked up again")
            return RecoveryAdmission(records[0].root.project_id)

        async def execute(identity, command):
            self.assertIsInstance(command, ReconcileProjectRemoval)
            self.catalog.delete_project(command.project_id, effect=(identity, result))
            return result

        operations = ContentOperations(
            Activities(),
            execute,
            self.catalog,
            recovery_admission=admission,
            recovery_state=lambda project, reason: states.append((project, reason)),
        )
        await operations.start()
        try:
            self.assertEqual(states, [("project", PROJECT_RECOVERY_PENDING), ("project", None)])
            self.assertEqual(
                self.catalog.operation_result("owner", "grant")["error"], AUTHORIZATION_SUPERSEDED
            )
        finally:
            await operations.aclose()

    def pending_authorization(self, identity="grant"):
        self.running(identity)
        row = ExternalRootRow("root", "project", str(self.catalog.path.parent), "external", 123.0)
        self.catalog.authorize_external_roots((row,), authorization_operation_id=identity)
        return row

    def healthy_authorization(self):
        self.running("healthy-grant")
        root = ExternalRootRow(
            "healthy-root", "healthy", str(self.catalog.path.parent / "healthy"), "external", 124.0
        )
        self.catalog.authorize_external_roots((root,), authorization_operation_id="healthy-grant")
        return root

    async def test_blocked_recovery_retains_records_and_allows_other_project_commands(self):
        self.pending_removal()
        self.pending_authorization()
        self.healthy_authorization()
        seen = []

        def admission(command):
            project = (
                "healthy"
                if isinstance(command, ReconcileAuthorization) and command.root_id == "healthy-root"
                else "project"
            )
            return RecoveryAdmission(
                project, "project_permission_denied" if project == "project" else None
            )

        async def execute(identity, command):
            seen.append(identity)
            result = {"id": identity}
            if isinstance(command, ReconcileAuthorization):
                self.catalog.finish_authorization_reconciliation(identity, result)
            return result

        operations = ContentOperations(
            Activities(), execute, self.catalog, recovery_admission=admission
        )
        await operations.start()
        try:
            self.assertEqual(seen, ["healthy-grant"])
            self.assertEqual(self.catalog.operation_result("owner", "remove")["state"], "running")
            self.assertEqual(self.catalog.operation_result("owner", "grant")["state"], "running")
            self.assertEqual(len(self.catalog.project_removals()), 1)
            self.assertEqual(len(self.catalog.authorization_reconciliations()), 1)
            identity = operations.submit("owner", AdoptProject("/healthy", "Healthy"))
            await operations._wait_finished(operations._operations[identity])
            self.assertEqual(operations.result("owner", identity)["state"], "succeeded")
        finally:
            await operations.aclose()

    async def test_project_failure_defers_later_recovery_without_consuming_durable_rows(self):
        self.pending_removal()
        self.pending_authorization()
        self.healthy_authorization()
        seen = []

        def admission(command):
            return RecoveryAdmission(
                "healthy"
                if isinstance(command, ReconcileAuthorization) and command.root_id == "healthy-root"
                else "project"
            )

        def failure(command, error):
            return (
                error.code
                if isinstance(error, ContentError) and error.code == "root_unavailable"
                else None
            )

        async def execute(identity, command):
            seen.append(identity)
            if isinstance(command, ReconcileProjectRemoval):
                raise ContentError("root_unavailable")
            result = {"id": identity}
            self.catalog.finish_authorization_reconciliation(identity, result)
            return result

        operations = ContentOperations(
            Activities(),
            execute,
            self.catalog,
            recovery_admission=admission,
            recovery_failure=failure,
        )
        await operations.start()
        try:
            self.assertEqual(seen, ["remove", "healthy-grant"])
            self.assertEqual(self.catalog.operation_result("owner", "remove")["state"], "running")
            self.assertEqual(self.catalog.operation_result("owner", "grant")["state"], "running")
            self.assertEqual(len(self.catalog.project_removals()), 1)
            self.assertEqual(len(self.catalog.authorization_reconciliations()), 1)
        finally:
            await operations.aclose()

    async def test_pending_projects_are_registered_before_general_queue_opens(self):
        self.pending_removal()
        self.pending_authorization()
        self.healthy_authorization()
        started = asyncio.Event()
        resume = asyncio.Event()
        states = {}
        transitions = []
        seen = []

        def admission(command):
            return RecoveryAdmission(
                "healthy"
                if isinstance(command, ReconcileAuthorization) and command.root_id == "healthy-root"
                else "project"
            )

        def state(project, reason):
            states[project] = reason
            transitions.append((project, reason))

        async def execute(identity, command):
            seen.append(identity)
            if isinstance(command, ReconcileProjectRemoval):
                self.assertEqual(
                    states,
                    {"project": PROJECT_RECOVERY_PENDING, "healthy": PROJECT_RECOVERY_PENDING},
                )
                started.set()
                await resume.wait()
                raise ContentError("root_unavailable")
            result = {"id": identity}
            if isinstance(command, ReconcileAuthorization):
                self.catalog.finish_authorization_reconciliation(identity, result)
            return result

        operations = ContentOperations(
            Activities(),
            execute,
            self.catalog,
            recovery_admission=admission,
            recovery_failure=lambda command, error: (
                error.code if isinstance(error, ContentError) else None
            ),
            recovery_state=state,
        )
        startup = asyncio.create_task(operations.start())
        await started.wait()
        try:
            identity = operations.submit("owner", AdoptProject("/unrelated", "Other"))
            self.assertIsInstance(identity, str)
            resume.set()
            await startup
            await operations._wait_finished(operations._operations[identity])
            self.assertEqual(states, {"project": "root_unavailable", "healthy": None})
            self.assertNotIn(("project", None), transitions)
            self.assertEqual(self.catalog.operation_result("owner", "grant")["state"], "running")
            self.assertLess(seen.index(identity), seen.index("healthy-grant"))
        finally:
            resume.set()
            await startup
            await operations.aclose()

    async def test_background_recovery_freezes_projects_before_start_returns(self):
        result = self.pending_removal()
        states = {}
        entered = asyncio.Event()
        resume = asyncio.Event()

        async def execute(identity, command):
            entered.set()
            await resume.wait()
            self.catalog.delete_project(command.project_id, effect=(identity, result))
            return result

        operations = ContentOperations(
            Activities(),
            execute,
            self.catalog,
            recovery_admission=lambda command: RecoveryAdmission("project"),
            recovery_state=lambda project, reason: states.__setitem__(project, reason),
        )
        await operations.start(defer_until_open=True)
        try:
            self.assertEqual(states, {"project": PROJECT_RECOVERY_PENDING})
            self.assertFalse(entered.is_set())
            await entered.wait()
            resume.set()
            await operations._startup
            self.assertEqual(states, {"project": None})
        finally:
            resume.set()
            await operations.aclose()

    async def test_creation_does_not_convert_unclassified_core_failure_to_deferral(self):
        original = self.pending_creation()

        async def execute(identity, command):
            raise sqlite3.DatabaseError("core database failure")

        operations = ContentOperations(
            Activities(),
            execute,
            self.catalog,
            recovery_admission=lambda command: RecoveryAdmission("created"),
            recovery_failure=lambda command, error: None,
        )
        with self.assertRaises((sqlite3.DatabaseError, ContentError)):
            await operations.start()
        with self.assertRaises(sqlite3.DatabaseError):
            await operations.aclose()
        self.assertEqual(self.catalog.project_creations(), (original,))
        self.assertEqual(self.catalog.operation_result("owner", "create")["state"], "running")

    async def test_unclassified_recovery_failure_still_fails_startup(self):
        self.pending_removal()

        async def execute(identity, command):
            raise sqlite3.DatabaseError("core database failure")

        operations = ContentOperations(
            Activities(),
            execute,
            self.catalog,
            recovery_admission=lambda command: RecoveryAdmission("project"),
            recovery_failure=lambda command, error: None,
        )
        with self.assertRaises((sqlite3.DatabaseError, ContentError)):
            await operations.start()
        with self.assertRaises(sqlite3.DatabaseError):
            await operations.aclose()
        self.assertEqual(len(self.catalog.project_removals()), 1)
        self.assertEqual(self.catalog.operation_result("owner", "remove")["state"], "running")

    def test_authorization_reconciliation_survives_generic_recovery(self):
        root = self.pending_authorization()
        inventory = ContentCatalog.read_roots(self.catalog.path)
        self.assertTrue(inventory.has_authorization_reconciliations)
        self.assertFalse(inventory.has_pending_operations)
        self.catalog.recover_operations()
        self.assertEqual(self.catalog.operation_result("owner", "grant")["state"], "running")
        self.assertEqual(self.catalog.authorization_reconciliations()[0].root, root)
        with self.assertRaises(CatalogFormatError):
            self.catalog.finish_operation("grant", OperationState.FAILED, None, "sync failed")
        self.assertFalse(
            self.catalog.accept_operation("other", "owner", "{}", limit=1, retention=-1)
        )

    def test_authorization_effect_and_marker_consumption_are_atomic(self):
        self.pending_authorization()
        with patch.object(ContentCatalog, "_record_operation_effect", side_effect=OSError("full")):
            with self.assertRaises(OSError):
                self.catalog.finish_authorization_reconciliation("grant", {"root_id": "root"})
        self.assertEqual(len(self.catalog.authorization_reconciliations()), 1)
        self.catalog.finish_authorization_reconciliation("grant", {"root_id": "root"})
        self.catalog.recover_operations()
        self.assertEqual(
            self.catalog.operation_result("owner", "grant")["result"], {"root_id": "root"}
        )
        self.assertEqual(self.catalog.authorization_reconciliations(), ())

    def test_authorization_completion_projects_same_owner_rows_without_changing_source(self):
        root = self.pending_authorization()
        result = {
            "root_id": root.root_id,
            "project_id": root.project_id,
            "agentSessionsAffected": [],
        }
        with (
            closing(sqlite3.connect(self.catalog.path)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            before = tuple(source.iterdump())
            with self.assertRaises(ValueError):
                ContentCatalog.finish_authorization_reconciliation_rows(projected, "grant", result)
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                with self.assertRaises(CatalogFormatError):
                    ContentCatalog.finish_authorization_reconciliation_rows(
                        projected, "different-operation", result
                    )
                ContentCatalog.finish_authorization_reconciliation_rows(projected, "grant", result)
                ContentCatalog.recover_operation_rows(projected, now=1234.0)
            ContentCatalog.inspect_rows(projected)
            expected = tuple(projected.iterdump())
            self.assertEqual(tuple(source.iterdump()), before)
            self.catalog.finish_authorization_reconciliation("grant", result)
            self.catalog.finish_operation(
                "grant", OperationState.SUCCEEDED, result, None, now=1234.0
            )
            self.assertEqual(tuple(source.iterdump()), expected)
            self.assertEqual(self.catalog.external_root(root.root_id), root)

    def test_authorization_marker_failure_rolls_back_grant_and_audit(self):
        root = ExternalRootRow("root", "project", str(self.catalog.path.parent), "external", 123.0)
        with self.assertRaises(CatalogFormatError):
            self.catalog.authorize_external_roots((root,), authorization_operation_id="missing")
        self.assertIsNone(self.catalog.external_root("root"))
        self.assertEqual(self.catalog.audit(), ())

    def test_revoke_and_regrant_do_not_revive_old_reconciliation(self):
        root = self.pending_authorization()
        self.catalog.revoke_external_root(root.root_id)
        self.assertEqual(
            self.catalog.operation_result("owner", "grant")["error"], AUTHORIZATION_SUPERSEDED
        )
        self.running("replacement")
        proposed = ExternalRootRow(
            "new-id", root.project_id, root.source_path, root.mount_path, root.authorized_at
        )
        restored = self.catalog.authorize_external_roots(
            (proposed,), authorization_operation_id="replacement"
        )[0]
        self.assertEqual(restored.root_id, root.root_id)
        records = self.catalog.authorization_reconciliations()
        self.assertEqual(tuple(row.operation_id for row in records), ("replacement",))
        self.assertEqual(records[0].root.root_id, root.root_id)
        self.catalog.finish_operation(
            "grant", OperationState.FAILED, None, AUTHORIZATION_SUPERSEDED
        )
        with self.assertRaises(CatalogFormatError):
            self.catalog.finish_operation("grant", OperationState.SUCCEEDED, {}, None)

    def test_supersede_cancels_pending_authorization_atomically(self):
        root = self.pending_authorization()
        parent = ExternalRootRow(
            "parent", root.project_id, str(self.catalog.path.parent.parent), "parent", 124.0
        )
        with patch.object(ContentCatalog, "_record_operation_effect", side_effect=OSError("full")):
            with self.assertRaises(OSError):
                self.catalog.authorize_external_roots(
                    (parent,), supersede_root_ids=(root.root_id,), effect=("grant", {})
                )
        self.assertIsNone(self.catalog.external_root(root.root_id).revoked_at)
        self.assertEqual(len(self.catalog.authorization_reconciliations()), 1)
        self.catalog.authorize_external_roots((parent,), supersede_root_ids=(root.root_id,))
        self.assertEqual(self.catalog.authorization_reconciliations(), ())
        self.assertEqual(
            self.catalog.operation_result("owner", "grant")["error"], AUTHORIZATION_SUPERSEDED
        )

    def test_forget_cancels_pending_authorization(self):
        self.catalog.insert_project(
            ProjectRow("project", "Project", str(self.catalog.path.parent), "managed", 1.0)
        )
        self.pending_authorization()
        self.catalog.delete_project("project")
        self.assertEqual(self.catalog.authorization_reconciliations(), ())
        self.assertEqual(
            self.catalog.operation_result("owner", "grant")["error"], AUTHORIZATION_SUPERSEDED
        )

    def test_malformed_authorization_marker_fails_closed(self):
        self.pending_authorization()
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            db.execute("UPDATE authorization_reconciliations SET root_json = '{}' ")
        for read in (
            lambda: ContentCatalog.read_roots(self.catalog.path),
            self.catalog.recover_operations,
        ):
            with self.assertRaises(CatalogFormatError):
                read()
        self.assertEqual(self.catalog.operation_result("owner", "grant")["state"], "running")

    async def test_start_waits_for_reconciliation_using_original_identity(self):
        self.pending_authorization()
        entered, release = asyncio.Event(), asyncio.Event()

        async def reconcile(identity, command):
            self.assertEqual(identity, "grant")
            self.assertIsInstance(command, ReconcileAuthorization)
            entered.set()
            await release.wait()
            self.catalog.finish_authorization_reconciliation(identity, {"root_id": command.root_id})
            return {"root_id": command.root_id}

        stamp = 1800000000.0
        operations = ContentOperations(Activities(), reconcile, self.catalog, recovery_at=stamp)
        start = asyncio.create_task(operations.start())
        await entered.wait()
        self.assertFalse(start.done())
        with self.assertRaises(MaintenanceActive):
            operations.submit("owner", RevokeRoot("root"))
        release.set()
        await start
        self.assertEqual(operations.result("owner", "grant")["state"], "succeeded")
        with closing(sqlite3.connect(self.catalog.path)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT updated_at FROM content_operations WHERE operation_id = ?", ("grant",)
                ).fetchone(),
                (stamp,),
            )
        await operations.aclose()

    async def test_repeated_start_cancellation_waits_for_reconciliation(self):
        self.pending_authorization()
        entered, release = asyncio.Event(), asyncio.Event()

        async def reconcile(identity, command):
            entered.set()
            await release.wait()
            self.catalog.finish_authorization_reconciliation(identity, {"root_id": command.root_id})
            return {"root_id": command.root_id}

        operations = ContentOperations(Activities(), reconcile, self.catalog)
        start = asyncio.create_task(operations.start())
        await entered.wait()
        for _ in range(2):
            start.cancel()
            await asyncio.sleep(0)
            self.assertFalse(start.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await start
        await operations.aclose()
        self.assertEqual(self.catalog.operation_result("owner", "grant")["state"], "succeeded")

    async def test_failed_reconciliation_preserves_durable_work(self):
        self.pending_authorization()

        async def reconcile(identity, command):
            raise OSError("source offline")

        operations = ContentOperations(Activities(), reconcile, self.catalog)
        with self.assertRaises(ContentError):
            await operations.start()
        with self.assertRaises(CatalogFormatError):
            await operations.aclose()
        self.assertEqual(len(self.catalog.authorization_reconciliations()), 1)
        self.assertEqual(self.catalog.operation_result("owner", "grant")["state"], "running")

    def test_project_and_effect_rollback_together(self):
        row = ProjectRow("project", "Project", str(self.catalog.path.parent), "managed", 123.0)
        self.running()
        with patch.object(
            ContentCatalog, "_record_operation_effect", side_effect=OSError("disk full")
        ):
            with self.assertRaises(OSError):
                self.catalog.insert_project(row, effect=("effect", {"id": "project"}))
        self.assertIsNone(self.catalog.project("project"))
        self.catalog.recover_operations()
        self.assertEqual(
            self.catalog.operation_result("owner", "effect")["error"], OPERATION_INTERRUPTED
        )

    def test_project_effect_recovers_exact_result_without_replay(self):
        identity = self.running()
        registry = ProjectRegistry(str(self.catalog.path.parent), self.catalog)
        project = registry.adopt(self.catalog.path.parent, "Original", operation_id=identity)
        self.catalog.rename_project(project.id, "Later")
        reopened = ContentCatalog(self.catalog.path)
        self.assertTrue(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)
        reopened.recover_operations()
        result = reopened.operation_result("owner", identity)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["result"]["name"], "Original")
        self.assertEqual(result["result"]["id"], project.id)
        self.assertIsNone(reopened.operation_result("other", identity))
        reopened.recover_operations()
        self.assertEqual(reopened.operation_result("owner", identity), result)
        self.assertEqual(len(reopened.projects()), 1)
        self.assertEqual(reopened.project(project.id).display_name, "Later")
        self.assertFalse(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)
        # Adopting an already registered project also has a recoverable exact result.
        second = self.running("existing")
        registry.adopt(self.catalog.path.parent, "Ignored", operation_id=second)
        reopened.recover_operations()
        self.assertEqual(reopened.operation_result("owner", second)["result"]["name"], "Later")
        self.assertEqual(len(reopened.projects()), 1)

    def test_result_cannot_contradict_committed_effect(self):
        identity = self.running()
        result = {"id": "project"}
        self.catalog.record_operation_effect(identity, result)
        for state, payload, error in (
            (OperationState.FAILED, None, "failed"),
            (OperationState.SUCCEEDED, {"id": "other"}, None),
        ):
            with self.assertRaises(CatalogFormatError):
                self.catalog.finish_operation(identity, state, payload, error)
        self.assertEqual(self.catalog.operation_result("owner", identity)["state"], "running")
        self.catalog.finish_operation(identity, OperationState.SUCCEEDED, result, None)
        self.assertFalse(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)
        with closing(sqlite3.connect(self.catalog.path)) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM content_operation_effects").fetchone()[0], 0
            )

    def test_link_roots_receipt_and_command_effect_commit_together(self):
        identity = self.running()
        row = ExternalRootRow("link", "project", str(self.catalog.path.parent), "external", 123.0)
        result = {"job_id": "job", "linked": 1}
        with patch.object(
            self.catalog, "_record_operation_effect", side_effect=OSError("effect failed")
        ):
            with self.assertRaises(OSError):
                self.catalog.authorize_external_roots(
                    (row,), receipt=("job", "{}"), effect=(identity, result)
                )
        self.assertIsNone(self.catalog.external_root(row.root_id))
        self.assertEqual(self.catalog.root_receipts(), ())
        self.assertEqual(self.catalog.audit(), ())
        self.catalog.authorize_external_roots(
            (row,), receipt=("job", "{}"), effect=(identity, result)
        )
        self.assertEqual(len(self.catalog.root_receipts()), 1)
        with closing(sqlite3.connect(self.catalog.path)) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM content_operation_effects").fetchone()[0], 1
            )
        with self.assertRaises(CatalogFormatError):
            self.catalog.recover_operations()
        self.assertEqual(self.catalog.operation_result("owner", identity)["state"], "running")
        # Persistence contract: production reconciles the import ledger before this acknowledgement.
        self.catalog.acknowledge_root_receipt("job", "{}")
        self.catalog.revoke_external_root(row.root_id)
        revoked_at = self.catalog.external_root(row.root_id).revoked_at
        self.catalog.recover_operations()
        self.assertEqual(self.catalog.operation_result("owner", identity)["result"], result)
        self.assertEqual(self.catalog.external_root(row.root_id).revoked_at, revoked_at)

    def test_revocation_audit_and_effect_rollback_together(self):
        identity = self.running()
        row = ExternalRootRow("root", "project", str(self.catalog.path.parent), "external", 123.0)
        self.catalog.authorize_external_roots((row,))
        before = [dict(item) for item in self.catalog.audit()]
        with patch.object(
            self.catalog, "_record_operation_effect", side_effect=OSError("effect failed")
        ):
            with self.assertRaises(OSError):
                self.catalog.revoke_external_root(row.root_id, effect=(identity, {"revoked": True}))
        self.assertIsNone(self.catalog.external_root(row.root_id).revoked_at)
        self.assertEqual([dict(item) for item in self.catalog.audit()], before)
        self.catalog.recover_operations()
        self.assertEqual(
            self.catalog.operation_result("owner", identity)["error"], OPERATION_INTERRUPTED
        )

    def test_revocation_recovery_does_not_replay_authority_or_duplicate_audit(self):
        for reauthorize in (False, True):
            identity = self.running(str(reauthorize))
            root_id = "root-" + identity
            row = ExternalRootRow(
                root_id, "project", str(self.catalog.path.parent / identity), identity, 123.0
            )
            self.catalog.authorize_external_roots((row,))
            result = {
                "root_id": root_id,
                "revoked": True,
                "writableRoots": [],
                "agentSessionsAffected": [],
            }
            self.assertTrue(self.catalog.revoke_external_root(root_id, effect=(identity, result)))
            revoked_at = self.catalog.external_root(root_id).revoked_at
            self.assertIsNotNone(revoked_at)
            if reauthorize:
                self.catalog.authorize_external_roots((row,))
            before = [dict(item) for item in self.catalog.audit()]
            self.catalog.recover_operations()
            self.catalog.recover_operations()
            self.assertEqual(self.catalog.operation_result("owner", identity)["result"], result)
            self.assertEqual(
                self.catalog.external_root(root_id).revoked_at, None if reauthorize else revoked_at
            )
            self.assertEqual([dict(item) for item in self.catalog.audit()], before)
            self.assertEqual(
                sum(
                    item["action"] == AUDIT_REVOKE and identity in item["detail"] for item in before
                ),
                1,
            )

    def test_consumption_failure_preserves_effect_and_pending_result(self):
        identity = self.running()
        result = {"id": "project"}
        self.catalog.record_operation_effect(identity, result)
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            db.execute(
                "CREATE TRIGGER reject_effect_delete BEFORE DELETE ON content_operation_effects "
                "BEGIN SELECT RAISE(ABORT, 'consume failed'); END"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.catalog.finish_operation(identity, OperationState.SUCCEEDED, result, None)
        self.assertEqual(self.catalog.operation_result("owner", identity)["state"], "running")
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM content_operation_effects").fetchone()[0], 1
            )
            db.execute("DROP TRIGGER reject_effect_delete")
        self.catalog.recover_operations()
        self.assertEqual(self.catalog.operation_result("owner", identity)["result"], result)

    def test_effect_requires_running_identity_and_gc_preserves_evidence(self):
        row = ProjectRow("project", "Project", str(self.catalog.path.parent), "managed", 123.0)
        with self.assertRaises(CatalogFormatError):
            self.catalog.insert_project(row, effect=("unknown", {"id": "project"}))
        self.assertIsNone(self.catalog.project("project"))
        identity = self.running()
        self.catalog.record_operation_effect(identity, {"id": "project"})
        # A malformed terminal+effect pair must be preserved for diagnosis, not aged away.
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            db.execute(
                "UPDATE content_operations SET state='failed', updated_at=0 WHERE operation_id=?",
                (identity,),
            )
        self.assertFalse(self.catalog.accept_operation("new", "owner", "{}", limit=1, retention=1))
        self.assertIsNotNone(self.catalog.operation_result("owner", identity))
        self.assertTrue(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)
        with self.assertRaises(CatalogFormatError):
            self.catalog.recover_operations()

    def test_invalid_effect_rolls_back_all_recovery(self):
        for identity in ("first", "second"):
            self.running(identity)
            self.catalog.record_operation_effect(identity, {"id": identity})
        with closing(sqlite3.connect(self.catalog.path)) as db, db:
            db.execute(
                "UPDATE content_operation_effects SET result_json='[]' WHERE operation_id='second'"
            )
        with self.assertRaises(CatalogFormatError):
            self.catalog.recover_operations()
        for identity in ("first", "second"):
            self.assertEqual(self.catalog.operation_result("owner", identity)["state"], "running")
        self.assertTrue(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)

    def test_capacity_expires_only_old_terminal_records(self):
        with patch("service.content.persistence.catalog.time.time", return_value=100.0):
            self.assertTrue(
                self.catalog.accept_operation("active", "owner", "{}", limit=2, retention=10)
            )
            self.assertTrue(
                self.catalog.accept_operation("done", "owner", "{}", limit=2, retention=10)
            )
            self.catalog.finish_operation("done", OperationState.SUCCEEDED, {"id": "project"}, None)
        with patch("service.content.persistence.catalog.time.time", return_value=105.0):
            self.assertFalse(
                self.catalog.accept_operation("new", "owner", "{}", limit=2, retention=10)
            )
        with patch("service.content.persistence.catalog.time.time", return_value=111.0):
            self.assertTrue(
                self.catalog.accept_operation("new", "owner", "{}", limit=2, retention=10)
            )
        self.assertIsNone(self.catalog.operation_result("owner", "done"))
        self.assertEqual(self.catalog.operation_result("owner", "active")["state"], "queued")
        self.assertEqual(self.catalog.operation_result("owner", "new")["state"], "queued")

    async def test_terminal_result_survives_reopen_without_executing_again(self):
        calls = []

        async def execute(identity, command):
            calls.append(command)
            return {"revoked": True}

        operations = ContentOperations(Activities(), execute, self.catalog)
        await operations.start()
        identity = operations.submit("owner", RevokeRoot("root"))
        await asyncio.sleep(0)
        await operations.aclose()
        expected = operations.result("owner", identity)
        reopened = ContentOperations(Activities(), execute, ContentCatalog(self.catalog.path))
        await reopened.start()
        self.assertEqual(reopened.result("owner", identity), expected)
        with self.assertRaises(ContentError):
            reopened.result("other", identity)
        await reopened.aclose()
        self.assertEqual(len(calls), 1)

    async def test_admission_write_failure_does_not_execute_or_queue(self):
        calls = []

        async def execute(identity, command):
            calls.append(command)
            return {}

        operations = ContentOperations(Activities(), execute, self.catalog)
        await operations.start()
        with patch.object(self.catalog, "accept_operation", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                operations.submit("owner", RevokeRoot("root"))
        await operations.aclose()
        self.assertEqual(calls, [])
        self.assertFalse(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)

    async def test_timings_include_queue_wait_separately_from_execution(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        async def execute(identity, command):
            if command.root_id == "first":
                entered.set()
                await release.wait()
            return {"revoked": True}

        operations = ContentOperations(Activities(), execute, self.catalog)
        await operations.start()
        clock = [100.0]
        with (
            patch(
                "service.content.service.operations.time",
                SimpleNamespace(monotonic=lambda: clock[0]),
            ),
            self.assertLogs("service.content.service.operations", level="INFO") as captured,
        ):
            first = operations.submit("owner", RevokeRoot("first"))
            await entered.wait()
            clock[0] = 101.0
            second = operations.submit("owner", RevokeRoot("second"))
            clock[0] = 104.0
            release.set()
            await asyncio.wait_for(operations._operations[second].finished.wait(), timeout=2)
            await operations.aclose()
        self.assertEqual(operations.result("owner", first)["state"], "succeeded")
        self.assertTrue(
            any(first in line and "elapsed_seconds=4.000" in line for line in captured.output)
        )
        self.assertEqual(operations.result("owner", second)["state"], "succeeded")
        self.assertTrue(
            any(
                second in line
                and "elapsed_seconds=0.000 queue_seconds=3.000 total_seconds=3.000" in line
                for line in captured.output
            )
        )

    async def test_failed_result_write_unblocks_internal_waiter_without_fake_success(self):
        async def execute(identity, _command):
            return {"revoked": True}

        operations = ContentOperations(Activities(), execute, self.catalog)
        await operations.start()
        with patch.object(self.catalog, "finish_operation", side_effect=OSError("write failed")):
            with self.assertRaises(ContentError) as raised:
                await asyncio.wait_for(operations.execute("owner", RevokeRoot("root")), timeout=2)
            self.assertEqual(raised.exception.code, OPERATION_INTERRUPTED)
            with self.assertRaises(OSError):
                await operations.aclose()
        identity = next(iter(operations._operations))
        self.assertEqual(operations.result("owner", identity)["state"], "running")
        self.assertTrue(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)
        # Persistence contract only: production calls this under cold-start exclusive domains.
        self.catalog.recover_operations()
        result = operations.result("owner", identity)
        self.assertEqual(result["error"], OPERATION_INTERRUPTED)
        self.assertIsNone(result["result"])
        self.assertFalse(ContentCatalog.read_roots(self.catalog.path).has_pending_operations)

    async def test_closed_admission_defers_queued_shutdown_record_until_recovery(self):
        gate = Activities()

        async def execute(identity, _command):
            self.fail("closed worker executed a queued command")

        operations = ContentOperations(gate, execute, self.catalog)
        await operations.start()
        identity = operations.submit("owner", RevokeRoot("root"))
        generation = gate.begin()
        self.assertTrue(gate.seal(generation))
        with patch.object(
            self.catalog, "finish_operation", side_effect=AssertionError("closed write")
        ):
            await operations.aclose()
        with self.assertRaises(MaintenanceActive):
            operations.result("owner", identity)
        gate.resume(generation)
        self.assertEqual(operations.result("owner", identity)["state"], "queued")
        self.catalog.recover_operations()
        self.assertEqual(operations.result("owner", identity)["error"], OPERATION_INTERRUPTED)

    async def test_result_is_owner_scoped_and_waits_for_mutation(self):
        entered, finish = asyncio.Event(), asyncio.Event()

        async def adopt(identity, command):
            entered.set()
            await finish.wait()
            return ProjectRef("project", command.name, command.path, ProjectLayout.LEGACY, True)

        operations = ContentOperations(Activities(), adopt, self.catalog)
        await operations.start()
        identity = operations.submit("owner", AdoptProject("/candidate", "Candidate"))
        await entered.wait()
        self.assertEqual(operations.result("owner", identity)["state"], "running")
        with self.assertRaises(ContentError):
            operations.result("other", identity)
        finish.set()
        for _ in range(20):
            if operations.result("owner", identity)["state"] == "succeeded":
                break
            await asyncio.sleep(0)
        result = operations.result("owner", identity)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["result"]["id"], "project")
        await operations.aclose()
        with self.assertRaises(MaintenanceActive):
            operations.submit("owner", AdoptProject("/another", "Another"))

    async def test_close_cancellation_waits_for_real_transaction_and_discards_queued_intent(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        calls = []

        async def adopt(identity, command):
            calls.append(command)
            entered.set()
            await finish.wait()
            raise ContentError("candidate_rejected")

        operations = ContentOperations(Activities(), adopt, self.catalog)
        await operations.start()
        first = operations.submit("owner", AdoptProject("/first", "First"))
        second = operations.submit("owner", AdoptProject("/second", "Second"))
        await entered.wait()
        closing = asyncio.create_task(operations.aclose())
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.sleep(0)
        self.assertFalse(closing.done())
        finish.set()
        with self.assertRaises(asyncio.CancelledError):
            await closing
        self.assertEqual(len(calls), 1)
        self.assertEqual(operations.result("owner", first)["error"], "candidate_rejected")
        self.assertEqual(operations.result("owner", second)["error"], "content_operations_closed")

    async def test_revocation_keeps_terminal_payload_and_owner_scope(self):
        result = {
            "root_id": "root",
            "revoked": True,
            "writableRoots": [],
            "agentSessionsAffected": [],
        }

        async def revoke(identity, command):
            self.assertEqual(command, RevokeRoot("root", "project"))
            return result

        operations = ContentOperations(Activities(), revoke, self.catalog)
        await operations.start()
        identity = operations.submit("owner", RevokeRoot("root", "project"))
        await asyncio.sleep(0)
        self.assertEqual(operations.result("owner", identity)["result"], result)
        with self.assertRaises(ContentError):
            operations.result("other", identity)
        await operations.aclose()

    async def test_internal_waiter_can_start_before_lifespan_worker(self):
        gate = Activities()
        called = asyncio.Event()

        async def execute(identity, _command):
            called.set()
            return {"linked": 1}

        operations = ContentOperations(gate, execute, self.catalog)
        waiting = asyncio.create_task(operations.execute("owner", RevokeRoot("root")))
        await asyncio.sleep(0)
        self.assertFalse(called.is_set())
        self.assertEqual(gate.snapshot().counts, {})
        await operations.start()
        self.assertEqual(await waiting, {"linked": 1})
        await operations.aclose()

    async def test_internal_waiter_cancellation_waits_for_accepted_command(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        gate = Activities()

        async def execute(identity, _command):
            entered.set()
            await finish.wait()
            return {"linked": 1}

        operations = ContentOperations(gate, execute, self.catalog)
        await operations.start()
        waiting = asyncio.create_task(operations.execute("owner", RevokeRoot("root")))
        await entered.wait()
        self.assertEqual(gate.snapshot().counts, {})
        waiting.cancel()
        await asyncio.sleep(0)
        waiting.cancel()
        await asyncio.sleep(0)
        self.assertFalse(waiting.done())
        finish.set()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertEqual(next(iter(operations._operations.values())).result, {"linked": 1})
        await operations.aclose()

    async def test_closed_admission_does_not_queue_a_command(self):
        gate = Activities()

        async def adopt(identity, _command):
            self.fail("maintenance accepted an operation")

        operations = ContentOperations(gate, adopt, self.catalog)
        await operations.start()
        generation = gate.begin()
        with self.assertRaises(MaintenanceActive):
            operations.submit("owner", AdoptProject("/candidate", "Candidate"))
        gate.resume(generation)
        await operations.aclose()


if __name__ == "__main__":
    unittest.main()
