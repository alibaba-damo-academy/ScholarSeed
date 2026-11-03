"""Resource history codecs on private copies; not whole-product admission."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from service.paths import PROJECT_DB_RELATIVE
from service.persistence.preview import SchemaOwner, preview_database, require_candidate_layout
from service.platform.resources import (
    FileState,
    PendingOrigin,
    PendingReview,
    SnapshotIdentity,
    TurnOutcome,
    VersionOrigin,
)
from service.resources.domain.version import DiskObservation, ObservationState, SnapshotVersion
from service.resources.persistence import pending
from service.resources.persistence.codecs import WholeCodec
from service.resources.persistence.objects import CasLayout, CasStore, ObjectDescriptor
from service.resources.persistence.version import (
    InitialVersionPlan,
    VersionStore,
    VersionStoreConflict,
)

OWNERS = (
    SchemaOwner(
        "resource-versions",
        VersionStore.inspect_connection,
        VersionStore.initialize_schema,
        VersionStore.inspect_rows,
        triggers=VersionStore.preview_triggers,
    ),
)


class ResourceHistoryRowContracts(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.database = self.root / PROJECT_DB_RELATIVE
        self.store = VersionStore(self.database, self.root)
        self.store.begin_turn("session", "turn", (), ("private-unavailable.md",))
        self.store.receive_terminal("session", "turn", TurnOutcome.COMPLETED)
        self.store.stage_delivery("session", "turn", "digest", ())

    def dump(self):
        with closing(sqlite3.connect(self.database)) as connection:
            return tuple(connection.iterdump())

    def test_first_version_recovery_matches_live_rows_and_reuses_explicit_identities(self):
        for state in ("new", "active", "pending", "versioned"):
            with self.subTest(state=state):
                root = self.root / state
                root.mkdir()
                database = root / PROJECT_DB_RELATIVE
                store = VersionStore(database, root)
                store.ensure()
                cas = CasStore(root / "versions", project_root=root)
                identifier = cas.put(b"first version bytes")
                descriptor = cas.verify(identifier)
                snapshot = SnapshotVersion(
                    "resources/论文.md",
                    "text/markdown",
                    identifier,
                    identifier,
                    0o600,
                    1,
                    VersionOrigin.INITIAL_SCAN,
                )
                if state == "active":
                    store.begin_turn("active", "turn", (), ())
                elif state == "pending":
                    store.accept_working(
                        None,
                        replace(snapshot, origin=VersionOrigin.USER),
                        descriptor,
                        None,
                        "external",
                        now_ms=1000,
                    )
                elif state == "versioned":
                    store.seal(snapshot, descriptor)
                plan = InitialVersionPlan.for_recovery(
                    "a" * 64, "authorization", state, snapshot.path, now_ms=1234
                )
                with (
                    closing(sqlite3.connect(database)) as source,
                    closing(sqlite3.connect(":memory:")) as projected,
                ):
                    source.backup(projected)
                    projected.row_factory = sqlite3.Row
                    before = tuple(source.iterdump())
                    with (
                        patch(
                            "service.resources.persistence.version.uuid4",
                            side_effect=AssertionError("projection sampled random identity"),
                        ),
                        patch(
                            "service.resources.persistence.version._now_ms",
                            side_effect=AssertionError("projection sampled clock"),
                        ),
                    ):
                        with projected:
                            projected.execute("BEGIN IMMEDIATE")
                            result = VersionStore.initialize_first_rows(
                                projected, snapshot, descriptor, plan=plan
                            )
                        expected = tuple(projected.iterdump())
                        with projected:
                            projected.execute("BEGIN IMMEDIATE")
                            again = VersionStore.initialize_first_rows(
                                projected, snapshot, descriptor, plan=plan
                            )
                        self.assertEqual(tuple(projected.iterdump()), expected)
                    VersionStore.inspect_rows(projected)
                    self.assertEqual(tuple(source.iterdump()), before)
                    actual = store.initialize_first(snapshot, descriptor, plan=plan)
                    self.assertEqual(actual, result)
                    self.assertEqual(tuple(source.iterdump()), expected)
                    if state == "new":
                        self.assertEqual(result.version.id, plan.version_id)
                        self.assertEqual(result.version.file_id, plan.file_id)
                        self.assertEqual(result.version.created_at_ms, plan.now_ms)
                        self.assertTrue(again.unchanged)
                    elif state in ("pending", "active"):
                        self.assertIsNone(actual)
                        self.assertEqual(store.history(snapshot.path), ())
                        file_id = store.identity(snapshot.path)[0]
                        self.assertEqual(store.pending(file_id).origin, PendingOrigin.EXTERNAL)

    def test_first_version_recovery_scope_separates_operations_and_rejects_invalid_plans(self):
        arguments = ("a" * 64, "authorization", "project", "resources/new.md")
        plan = InitialVersionPlan.for_recovery(*arguments, now_ms=1234)
        self.assertEqual(InitialVersionPlan.for_recovery(*arguments, now_ms=1234), plan)
        for index, replacement in enumerate(
            ("b" * 64, "other-operation", "other-project", "resources/other.md")
        ):
            changed = list(arguments)
            changed[index] = replacement
            alternate = InitialVersionPlan.for_recovery(*changed, now_ms=1234)
            self.assertTrue(
                {plan.file_id, plan.path_id, plan.version_id, plan.observation_id}.isdisjoint(
                    {
                        alternate.file_id,
                        alternate.path_id,
                        alternate.version_id,
                        alternate.observation_id,
                    }
                )
            )
        for invalid in (
            replace(plan, now_ms=True),
            replace(plan, file_id=""),
            replace(plan, observation_id="../"),
        ):
            with self.assertRaises(ValueError):
                invalid.validate()

    def test_external_reconciliation_private_rows_match_live_head_and_pending_transitions(self):
        for state in (
            ObservationState.PRESENT,
            ObservationState.TOMBSTONE,
            ObservationState.UNAVAILABLE,
        ):
            for fence in ("none", "active", "review"):
                with self.subTest(state=state, fence=fence):
                    project = self.root / f"{state.value}-{fence}"
                    project.mkdir()
                    store = VersionStore(project / PROJECT_DB_RELATIVE, project)
                    cas = CasStore(project / "versions", project_root=project)
                    old_id, new_id = cas.put(b"old bytes"), cas.put(b"changed bytes")
                    original = SnapshotVersion(
                        "resource.md", "text/markdown", old_id, old_id, 0o600, 1, VersionOrigin.USER
                    )
                    sealed = store.seal(original, cas.verify(old_id))
                    if fence == "active":
                        store.begin_turn("active", "turn", (), ())
                    elif fence == "review":
                        identity = SnapshotIdentity(
                            old_id, FileState.PRESENT, original.path, 0o600, None
                        )
                        review = PendingReview(
                            "review",
                            "group",
                            "session",
                            "turn",
                            "turn",
                            TurnOutcome.COMPLETED,
                            PendingOrigin.AGENT,
                            identity,
                            identity,
                            old_id,
                            old_id,
                            PendingOrigin.USER,
                            sealed.version.id,
                            False,
                        )
                        with (
                            closing(sqlite3.connect(project / PROJECT_DB_RELATIVE)) as connection,
                            connection,
                        ):
                            connection.row_factory = sqlite3.Row
                            pending.capture(connection, sealed.version.file_id, review, 1000)
                    if state is ObservationState.PRESENT:
                        snapshot = replace(original, revision=new_id, object_id=new_id, mtime_ns=2)
                        descriptor = cas.verify(new_id)
                        observation = DiskObservation(
                            state, new_id, descriptor.raw_size_bytes, 2, 0o600
                        )
                    elif state is ObservationState.TOMBSTONE:
                        snapshot = replace(
                            original,
                            revision=None,
                            object_id=None,
                            mode_bits=None,
                            mtime_ns=None,
                            state=FileState.TOMBSTONE,
                        )
                        descriptor = None
                        observation = DiskObservation(state)
                    else:
                        snapshot, descriptor = None, None
                        observation = DiskObservation(state)
                    with (
                        closing(sqlite3.connect(project / PROJECT_DB_RELATIVE)) as source,
                        closing(sqlite3.connect(":memory:")) as projected,
                    ):
                        source.backup(projected)
                        projected.row_factory = sqlite3.Row
                        before = tuple(source.iterdump())
                        with projected:
                            projected.execute("BEGIN IMMEDIATE")
                            transition = VersionStore.reconcile_external_rows(
                                projected,
                                sealed.version.file_id,
                                original.path,
                                observation,
                                snapshot,
                                descriptor,
                                now=1234,
                            )
                        VersionStore.inspect_rows(projected)
                        expected = tuple(projected.iterdump())
                        self.assertEqual(tuple(source.iterdump()), before)
                        actual = store.reconcile_external(
                            sealed.version.file_id,
                            original.path,
                            observation,
                            snapshot,
                            descriptor,
                            now_ms=1234,
                        )
                        self.assertEqual(actual, transition)
                        self.assertEqual(tuple(source.iterdump()), expected)
                        self.assertEqual(
                            actual.accepted,
                            state is not ObservationState.UNAVAILABLE and fence == "none",
                        )
                        self.assertEqual(len(store.history(original.path)), 1)
                        if not actual.accepted:
                            self.assertEqual(
                                store.working_snapshot(sealed.version.file_id).object_id, old_id
                            )
                        if fence == "review":
                            self.assertEqual(store.pending(sealed.version.file_id).review, review)

    def test_private_working_head_rejects_missing_new_identities_and_bad_capture_before_writes(
        self,
    ):
        descriptor = ObjectDescriptor(
            1, "object", CasLayout.WHOLE, WholeCodec.IDENTITY, 3, 3, "descriptor"
        )
        snapshot = SnapshotVersion(
            "resource.md", "text/markdown", "object", "object", 0o600, 1, VersionOrigin.USER
        )
        sealed = self.store.seal(snapshot, descriptor)
        with (
            closing(sqlite3.connect(self.database)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            before = tuple(projected.iterdump())
            with self.assertRaises(ValueError):
                VersionStore.observe_rows(
                    projected,
                    sealed.version.file_id,
                    DiskObservation(ObservationState.TOMBSTONE),
                    now=1234,
                )
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                with self.assertRaises(ValueError):
                    VersionStore.accept_working_rows(
                        projected, None, snapshot, descriptor, None, "external", now=1234
                    )
                with self.assertRaises(VersionStoreConflict):
                    VersionStore.reconcile_external_rows(
                        projected,
                        sealed.version.file_id,
                        snapshot.path,
                        DiskObservation(ObservationState.PRESENT, "different", 3, 1, 0o600),
                        snapshot,
                        descriptor,
                        now=1234,
                    )
            self.assertEqual(tuple(projected.iterdump()), before)
            self.assertEqual(tuple(source.iterdump()), before)

    def test_preflight_preserves_pending_finalization_and_does_not_create_cas(self):
        before = self.dump()
        files = set(self.root.rglob("*"))
        finalization = self.store.finalization("session", "turn")
        preview = preview_database(self.database, "project", OWNERS)
        check = require_candidate_layout(preview, preview, OWNERS)
        self.assertEqual(check.row_readers, ("resource-versions",))
        self.assertEqual(self.dump(), before)
        self.assertEqual(set(self.root.rglob("*")), files)
        self.assertEqual(self.store.staged_delivery("session", "turn"), ())
        self.assertEqual(self.store.finalization("session", "turn"), finalization)
        self.assertEqual(self.store.pending_finalizations(), (("session", "turn"),))
        self.assertNotIn("private-unavailable.md", repr(preview))

    def reject_field(self, table, column, value):
        with closing(sqlite3.connect(self.database)) as connection:
            original = connection.execute(f"SELECT {column} FROM {table}").fetchall()
            self.assertEqual(len(original), 1)
            connection.execute(f"UPDATE {table} SET {column}=?", (value,))
            connection.commit()
            before = self.dump()
            try:
                with self.assertRaises((ValueError, TypeError, RuntimeError, KeyError)):
                    preview_database(self.database, "project", OWNERS)
                self.assertEqual(self.dump(), before)
            finally:
                connection.execute(f"UPDATE {table} SET {column}=?", original[0])
                connection.commit()

    def test_corrupt_turn_payloads_reject_without_recovery_or_rewrite(self):
        for column, value in (
            ("initial_paths_json", "{broken"),
            ("initial_paths_json", "[1]"),
            ("finalization_manifest_json", "{broken"),
            ("finalization_manifest_json", '{"members":{}}'),
            ("capture_result_json", "{broken"),
            ("capture_result_json", "{}"),
            ("started_at_ms", "future-time"),
        ):
            with self.subTest(column=column, value=value):
                self.reject_field("resources_turns", column, value)
        self.assertEqual(self.store.pending_finalizations(), (("session", "turn"),))

    def test_completed_review_receipt_and_migration_resolution_are_read_without_replay(self):
        # These are persisted-format fixtures, not evidence of a real review flow.
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "INSERT INTO resources_review_batches VALUES ('batch','session','turn','group','completed',1,1)"
            )
            connection.execute(
                "INSERT INTO resources_review_batch_requests VALUES ('request','batch','digest','completed','{}',1,1)"
            )
            connection.execute(
                "INSERT INTO resources_review_migrations "
                "(source_id,path,source_revision,source_digest,status,decision,updated_at_ms,resolution) "
                "VALUES ('source','private-unavailable.md',1,'digest','resolved','accept',1,'{}')"
            )
        before = self.dump()
        preview_database(self.database, "project", OWNERS)
        self.assertEqual(self.dump(), before)
        self.reject_field("resources_review_batch_requests", "result_json", "{broken")
        self.reject_field("resources_review_migrations", "resolution", "{broken")
        self.assertEqual(self.dump(), before)

    def test_file_projections_preserve_external_drift_without_observing_disk(self):
        # Seed the real ledger writer with a descriptor. Physical CAS validation
        # is deliberately outside this persisted-row contract.
        descriptor = ObjectDescriptor(
            1, "object", CasLayout.WHOLE, WholeCodec.IDENTITY, 3, 3, "descriptor"
        )
        snapshot = SnapshotVersion(
            path="unavailable/file.md",
            media_type="text/markdown",
            revision="object",
            object_id="object",
            mode_bits=0o644,
            mtime_ns=1,
            origin=VersionOrigin.USER,
        )
        sealed = self.store.seal(snapshot, descriptor)
        self.store.observe(
            sealed.version.file_id,
            DiskObservation(ObservationState.PRESENT, revision="external", mode_bits=0o600),
        )
        paths = (snapshot.path,)
        files = self.store.versioned_files(FileState.PRESENT)
        managed = self.store.managed_files()
        capabilities = self.store.capability_states(paths)
        self.assertTrue(capabilities[snapshot.path].drifted)
        before = self.dump()
        preview = preview_database(self.database, "project", OWNERS)
        require_candidate_layout(preview, preview, OWNERS)
        self.assertEqual(self.dump(), before)
        self.assertEqual(self.store.versioned_files(FileState.PRESENT), files)
        self.assertEqual(self.store.managed_files(), managed)
        self.assertEqual(self.store.capability_states(paths), capabilities)
        self.assertFalse((self.root / "unavailable").exists())
        self.reject_field("resources_heads", "mode_bits", "future-mode")


if __name__ == "__main__":
    unittest.main()
