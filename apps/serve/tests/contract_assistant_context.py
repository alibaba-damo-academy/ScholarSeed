"""Contract for Session-scoped Assistant selection and snapshot persistence."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.history import HistoryEntry
from service.assistant.api.routes import register_assistant_routes
from service.assistant.persistence.store import (
    ASSISTANT_ITEM_TABLE,
    ASSISTANT_REF_TABLE,
    ASSISTANT_SELECTION_TABLE,
    ASSISTANT_SNAPSHOT_TABLE,
    AssistantRevisionConflictError,
    AssistantStateConflictError,
    AssistantStore,
)
from service.assistant.service.context import AssistantService
from service.chat.active import RUNTIME_ID
from service.chat.constants import SESSION_TITLE_DEFAULT, SessionTitleFallback
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.service.context import SessionContextProvider
from service.chat.service.history import HistoryService
from service.persistence.project import rebuild_table
from service.platform.context import (
    AssistantContextFailureKind,
    AssistantTurnItem,
    AssistantTurnSnapshot,
    ContextItemRole,
    ContextLabelFallback,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ContextRetention,
    ProjectContextPolicy,
    SearchScope,
    SelectionAnchor,
)

SESSION_A = "assistant-session-a"
SESSION_B = "assistant-session-b"
OWNER = SessionPrincipal("local")


def register_session(catalog: SessionCatalogStore, session_id: str) -> None:
    root = catalog.database.parent / session_id
    catalog.register(
        session_id,
        OWNER,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=f"vendor-{session_id}",
        vendor_session_id=None,
        runtime_workdir=str(root),
        project_path=None,
        output_root=str(root / "output"),
        codex_version="contract",
        model_id="contract-model",
        policy_id="ask",
        status=SessionStatus.READY,
        title=session_id,
        created_at=1.0,
    )


def file_ref(
    ref_id: str = "ref-a",
    retention: ContextRetention = ContextRetention.SESSION,
) -> ContextRef:
    return ContextRef(
        ref_id=ref_id,
        kind=ContextRefKind.FILE,
        source_id="资料/证据.md",
        label="证据.md",
        source_revision="rev-1",
        retention=retention,
    )


class AssistantContextContract(unittest.TestCase):
    def test_context_api_preserves_large_reference_sets(self) -> None:
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = AssistantService(self.store)
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context"
        revision = 0
        for count in (32, 33, 40, 65, 128):
            with self.subTest(count=count):
                refs = [
                    {
                        "ref_id": f"paper-{index}",
                        "kind": "literature",
                        "source_id": f"paper-{index}",
                        "label": f"Paper {index}",
                    }
                    for index in range(count)
                ]
                body = {
                    "expected_revision": revision,
                    "project_policy": "explicit_only",
                    "search_scope": "disabled",
                    "refs": refs,
                }
                response = client.patch(endpoint, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                revision = response.json()["revision"]
                expected_ids = [ref["ref_id"] for ref in refs]
                self.assertEqual(
                    [ref["ref_id"] for ref in client.get(endpoint).json()["refs"]], expected_ids
                )
                self.assertEqual(
                    [ref.ref_id for ref in AssistantStore(self.database).selection(SESSION_A).refs],
                    expected_ids,
                )
                for invalid in (refs + [refs[0]], [*refs[:-1], {**refs[-1], "source_id": ""}]):
                    rejected = client.patch(
                        endpoint, json={**body, "expected_revision": revision, "refs": invalid}
                    )
                    self.assertEqual(rejected.status_code, 422, rejected.text)
                self.assertEqual(client.get(endpoint).json()["revision"], revision)

    def test_default_turn_omits_model_card_but_preserves_snapshot(self) -> None:
        service = AssistantService(self.store)
        result = service.freeze(
            session_id=SESSION_A,
            client_turn_id="greeting-turn",
            expected_revision=None,
            question="你好",
        )
        self.assertIsNone(result.failure)
        self.assertIsNotNone(result.context)
        context = result.context
        self.assertEqual(context.model_context, "")
        self.assertEqual(context.snapshot.search_scope, SearchScope.WEB)
        self.assertEqual(self.store.snapshot_for_turn(SESSION_A, "greeting-turn"), context.snapshot)
        cold = AssistantService(AssistantStore(self.database))
        replay = cold.freeze(
            session_id=SESSION_A,
            client_turn_id="greeting-turn",
            expected_revision=None,
            question="你好",
        )
        self.assertEqual(replay.context, context)

    def test_changed_model_card_hash_still_rejects_replay(self) -> None:
        service = AssistantService(self.store)
        arguments = dict(
            session_id=SESSION_A,
            client_turn_id="old-renderer-turn",
            expected_revision=None,
            question="你好",
        )
        frozen = service.freeze(**arguments).context
        self.assertIsNotNone(frozen)
        old_hash = hashlib.sha256(b"previous renderer model card").hexdigest()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"UPDATE {ASSISTANT_SNAPSHOT_TABLE} SET model_card_hash = ? WHERE snapshot_id = ?",
                (old_hash, frozen.snapshot.snapshot_id),
            )
        replay = AssistantService(AssistantStore(self.database)).freeze(**arguments)
        self.assertIsNone(replay.context)
        self.assertEqual(replay.failure.kind, AssistantContextFailureKind.IDEMPOTENCY_CONFLICT)
        self.assertIn("model card hash mismatch", replay.failure.detail)
        self.assertEqual(
            self.store.snapshot_for_turn(SESSION_A, "old-renderer-turn").model_card_hash, old_hash
        )

    def test_search_overrides_are_compact_and_reset_to_default(self) -> None:
        service = AssistantService(self.store)
        for scope in (SearchScope.DISABLED, SearchScope.WEB, SearchScope.ACADEMIC, SearchScope.WEB):
            selection = service.replace_selection(
                session_id=SESSION_A,
                expected_revision=self.store.selection(SESSION_A).revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=scope,
                refs=(),
            )
            result = service.freeze(
                session_id=SESSION_A,
                client_turn_id=f"scope-{selection.revision}",
                expected_revision=selection.revision,
                question="你好",
            )
            self.assertIsNone(result.failure)
            self.assertIsNotNone(result.context)
            if scope is SearchScope.WEB:
                self.assertEqual(result.context.model_context, "")
            else:
                self.assertEqual(
                    json.loads(result.context.model_context.splitlines()[1]),
                    {"search_scope": scope.value},
                )

    def test_metadata_only_freeze_never_resolves_selected_source_bytes(self) -> None:
        class ByteReadingProvider:
            def __init__(self) -> None:
                self.calls = 0

            def resolve(self, request):
                self.calls += 1
                raise AssertionError("metadata-only freeze reached source provider")

        provider = ByteReadingProvider()
        service = AssistantService(
            self.store,
            providers={ContextRefKind.FILE: provider},
        )
        selected = service.replace_selection(
            session_id=SESSION_A,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(file_ref(),),
        )
        frozen = service.freeze(
            session_id=SESSION_A,
            client_turn_id="idea-turn",
            expected_revision=selected.revision,
            question="生成想法",
            metadata_only=True,
        ).context
        assert frozen is not None
        self.assertEqual(provider.calls, 0)
        self.assertEqual(frozen.snapshot.items[0].role, ContextItemRole.SCOPE)
        self.assertEqual(frozen.snapshot.items[0].excerpt_text, "")
        self.assertNotIn("证据正文", frozen.model_context)

    def test_default_session_title_freezes_source_without_changing_model_or_history_content(
        self,
    ) -> None:
        self.catalog.transition_model_thread(
            SESSION_B,
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id=f"vendor-{SESSION_B}",
            vendor_thread_id="default-title-source",
            model_id="contract-model",
            portable_history=(HistoryEntry(role="user", text="原始消息"),),
        )
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET title = ?, title_fallback = ? WHERE session_id = ?",
                (SESSION_TITLE_DEFAULT, SessionTitleFallback.NEW_SESSION, SESSION_B),
            )
        history = HistoryService(self.catalog, ProductEventStore(self.database))
        source = history.source(SESSION_A, SESSION_B)
        self.assertEqual(source.title, SESSION_TITLE_DEFAULT)
        self.assertEqual(source.title_fallback, SessionTitleFallback.NEW_SESSION)
        service = AssistantService(
            self.store, providers={ContextRefKind.SESSION: SessionContextProvider(history)}
        )
        selected = service.replace_selection(
            session_id=SESSION_A,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(
                ContextRef(
                    "default-ref",
                    ContextRefKind.SESSION,
                    SESSION_B,
                    SESSION_TITLE_DEFAULT,
                    label_fallback=ContextLabelFallback.NEW_SESSION,
                ),
            ),
        )
        frozen = service.freeze(
            session_id=SESSION_A,
            client_turn_id="default-title",
            expected_revision=selected.revision,
            question="问题",
        ).context
        assert frozen is not None
        self.assertEqual(
            frozen.snapshot.items[0].ref.label_fallback, ContextLabelFallback.NEW_SESSION
        )
        self.assertEqual(frozen.surface_refs[0]["label_fallback"], ContextLabelFallback.NEW_SESSION)
        self.catalog.enqueue_message(
            SESSION_A, "queued-title", {"assistant_references": list(frozen.surface_refs)}
        )
        self.assertEqual(
            SessionCatalogStore(self.database)
            .queued_message(SESSION_A, "queued-title")
            .body["assistant_references"][0]["label_fallback"],
            "new_session",
        )
        self.assertNotIn("title_fallback", frozen.model_context)
        self.assertNotIn("label_fallback", frozen.model_context)
        cold = AssistantService(AssistantStore(self.database))
        self.assertEqual(
            cold.freeze(
                session_id=SESSION_A,
                client_turn_id="default-title",
                expected_revision=selected.revision,
                question="问题",
            ).context,
            frozen,
        )
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = cold
        app.state.history_service = history
        register_assistant_routes(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context/{frozen.snapshot.snapshot_id}/session-preview?source_id={SESSION_B}"
        client = TestClient(app)
        self.assertEqual(client.get(endpoint).json()["label_fallback"], "new_session")
        self.catalog.rename(SESSION_B, OWNER, SESSION_TITLE_DEFAULT)
        renamed_source = history.source(SESSION_A, SESSION_B)
        self.assertEqual(renamed_source.title, source.title)
        self.assertEqual(renamed_source.revision, source.revision)
        self.assertEqual(renamed_source.entries, source.entries)
        self.assertIsNone(renamed_source.title_fallback)
        next_context = service.freeze(
            session_id=SESSION_A,
            client_turn_id="same-name-user",
            expected_revision=selected.revision,
            question="问题",
        ).context
        assert next_context is not None
        self.assertIsNone(next_context.snapshot.items[0].ref.label_fallback)
        same_identity = replace(next_context.snapshot, snapshot_id=frozen.snapshot.snapshot_id)
        self.assertEqual(service._render_model_card(same_identity), frozen.model_context)
        self.assertIsNone(client.get(endpoint).json()["label_fallback"])
        failed = AssistantService(self.store).freeze(
            session_id=SESSION_A,
            client_turn_id="unavailable-source",
            expected_revision=selected.revision,
            question="问题",
        )
        assert failed.failure is not None
        self.assertEqual(failed.failure.issues[0].label_fallback, ContextLabelFallback.NEW_SESSION)

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="assistant-context-")
        self.database = Path(self.temporary.name) / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        register_session(self.catalog, SESSION_A)
        register_session(self.catalog, SESSION_B)
        self.store = AssistantStore(self.database)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def replace(
        self,
        expected_revision: int,
        *,
        session_id: str = SESSION_A,
        refs: tuple[ContextRef, ...] = (),
    ):
        return self.store.replace_selection(
            session_id=session_id,
            expected_revision=expected_revision,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.ACADEMIC,
            refs=refs,
            updated_at=float(expected_revision + 1),
        )

    def test_label_provenance_schema_and_selection_round_trip(self) -> None:
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = AssistantService(self.store)
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context"
        reference = {
            "ref_id": "untitled-ref",
            "kind": "session",
            "source_id": SESSION_B,
            "label": "未命名对话",
            "label_fallback": "untitled_session",
        }
        body = {
            "expected_revision": 0,
            "project_policy": "explicit_only",
            "search_scope": "disabled",
            "refs": [reference],
        }
        for kind in ContextRefKind:
            if kind is ContextRefKind.SESSION:
                continue
            rejected = client.patch(
                endpoint, json={**body, "refs": [{**reference, "kind": kind.value}]}
            )
            self.assertEqual(rejected.status_code, 422)
        rejected = client.patch(
            endpoint, json={**body, "refs": [{**reference, "label_fallback": "unknown"}]}
        )
        self.assertEqual(rejected.status_code, 422)
        accepted = client.patch(endpoint, json=body)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["refs"][0]["label_fallback"], "untitled_session")
        restored = AssistantStore(self.database).selection(SESSION_A)
        self.assertEqual(restored.refs[0].label, "未命名对话")
        self.assertEqual(restored.refs[0].label_fallback, ContextLabelFallback.UNTITLED_SESSION)
        with self.assertRaises(ValueError):
            app.state.assistant.replace_selection(
                session_id=SESSION_A,
                expected_revision=1,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(replace(file_ref(), label_fallback=ContextLabelFallback.UNTITLED_SESSION),),
            )

    def test_selection_source_label_validates_and_preserves_raw_empty_titles(self) -> None:
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        service = AssistantService(self.store)
        app.state.assistant = service
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context"
        anchor = {
            "document_id": "attachment-selection",
            "locator": {"kind": "markdown", "start": 0, "end": 1, "source_map_version": "v1"},
            "selected_text_hash": "sha256:" + "a" * 64,
            "preview_text": "原文",
        }
        revision = 0
        for kind in ("selection", "literature"):
            for base in ("", " 原始标题 · 划词 "):
                ref = {
                    "ref_id": "selected",
                    "kind": kind,
                    "source_id": "source",
                    "label": "canonical · 划词",
                    "anchor": anchor,
                    "selection_source_label": base,
                }
                body = {
                    "expected_revision": revision,
                    "project_policy": "explicit_only",
                    "search_scope": "disabled",
                    "refs": [ref],
                }
                accepted = client.patch(endpoint, json=body)
                self.assertEqual(accepted.status_code, 200, accepted.text)
                revision = accepted.json()["revision"]
                self.assertEqual(accepted.json()["refs"][0]["selection_source_label"], base)
                restored = AssistantStore(self.database).selection(SESSION_A).refs[0]
                self.assertEqual(restored.selection_source_label, base)
                self.assertEqual(restored.label, "canonical · 划词")
                assert restored.anchor is not None
                self.assertEqual(restored.anchor.document_id, "attachment-selection")
                for invalid in (
                    {**ref, "anchor": None},
                    {**ref, "kind": "session"},
                    {**ref, "selection_source_label": 7},
                ):
                    self.assertEqual(
                        client.patch(
                            endpoint,
                            json={**body, "expected_revision": revision, "refs": [invalid]},
                        ).status_code,
                        422,
                    )

                for invalid in (
                    replace(restored, anchor=None),
                    replace(restored, kind=ContextRefKind.FILE),
                    replace(restored, selection_source_label=7),
                ):
                    with self.assertRaises(ValueError):
                        service._validate_refs((invalid,))
        self.assertIsNone(client.get(endpoint).json()["refs"][0]["label_fallback"])

    def test_calc_reference_content_mode_survives_context_round_trip(self) -> None:
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = AssistantService(self.store)
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context"
        body = {
            "expected_revision": 0,
            "project_policy": "explicit_only",
            "search_scope": "disabled",
            "refs": [
                {
                    "ref_id": "calc-reference",
                    "kind": "selection",
                    "source_id": "resources/large-selection.xlsx",
                    "source_revision": "sha256:" + "1" * 64,
                    "label": "large-selection.xlsx · 划词",
                    "selection_source_label": "large-selection.xlsx",
                    "anchor": {
                        "locator": {
                            "kind": "calc",
                            "sheet": "Results",
                            "range": "B1:B151",
                            "content_mode": "reference",
                        },
                        "selected_text_hash": "sha256:" + "2" * 64,
                        "preview_text": "large-selection.xlsx · Results!B1:B151",
                    },
                }
            ],
        }

        accepted = client.patch(endpoint, json=body)

        self.assertEqual(accepted.status_code, 200, accepted.text)
        locator = accepted.json()["refs"][0]["anchor"]["locator"]
        self.assertEqual(locator["content_mode"], "reference")
        restored = AssistantStore(self.database).selection(SESSION_A).refs[0]
        assert restored.anchor is not None
        self.assertEqual(restored.anchor.locator["content_mode"], "reference")

    def test_selection_source_label_snapshot_failure_and_hash_are_display_only(self) -> None:
        anchor = SelectionAnchor(
            locator={
                "kind": "text",
                "start_line": 0,
                "start_column": 0,
                "end_line": 0,
                "end_column": 1,
            },
            selected_text_hash="sha256:" + "a" * 64,
            preview_text="原文",
        )
        ref = ContextRef(
            "selected",
            ContextRefKind.SELECTION,
            "source.md",
            "标题 · 划词 · 划词",
            anchor=anchor,
            selection_source_label="标题 · 划词",
        )
        selected = self.replace(0, refs=(ref,))
        plain = replace(selected, refs=(replace(ref, selection_source_label=None),))
        self.assertEqual(
            AssistantService._admission_hash(selected, "turn", "问题"),
            AssistantService._admission_hash(plain, "turn", "问题"),
        )
        snapshot = AssistantTurnSnapshot(
            snapshot_id="selection-snapshot",
            session_id=SESSION_A,
            client_turn_id="selection-turn",
            selection_revision=selected.revision,
            project_id=None,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            model_card_hash="card",
            admission_hash="admission",
            items=(
                AssistantTurnItem("e1", ref, ContextResolutionState.READY, excerpt_text="原始选区"),
            ),
        )
        self.store.create_snapshot(snapshot)
        restored = AssistantStore(self.database).snapshot_for_turn(SESSION_A, "selection-turn")
        self.assertEqual(restored, snapshot)
        plain_snapshot = replace(
            snapshot,
            items=(replace(snapshot.items[0], ref=replace(ref, selection_source_label=None)),),
        )
        self.assertEqual(
            AssistantService._render_model_card(snapshot),
            AssistantService._render_model_card(plain_snapshot),
        )
        self.assertEqual(
            AssistantService._surface_refs(snapshot)[0]["selection_source_label"],
            ref.selection_source_label,
        )
        failure = (
            AssistantService(self.store)
            .freeze(
                session_id=SESSION_A,
                client_turn_id="selection-failure",
                expected_revision=selected.revision,
                question="问题",
            )
            .failure
        )
        assert failure is not None
        self.assertEqual(failure.issues[0].selection_source_label, ref.selection_source_label)
        self.assertEqual(failure.issues[0].label, ref.label)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            for table in (ASSISTANT_REF_TABLE, ASSISTANT_ITEM_TABLE):
                connection.execute(f"ALTER TABLE {table} DROP COLUMN selection_source_label")
        upgraded = AssistantStore(self.database)
        legacy_ref = upgraded.selection(SESSION_A).refs[0]
        self.assertIsNone(legacy_ref.selection_source_label)
        self.assertEqual(legacy_ref.label, ref.label)
        legacy_snapshot = upgraded.snapshot_for_turn(SESSION_A, "selection-turn")
        assert legacy_snapshot is not None
        self.assertEqual(legacy_snapshot.items[0].ref.label, ref.label)
        self.assertIsNone(legacy_snapshot.items[0].ref.selection_source_label)

    def test_new_provenance_survives_existing_foreign_key_repair(self) -> None:
        ref = ContextRef(
            "ref",
            ContextRefKind.SESSION,
            SESSION_B,
            "未命名对话",
            label_fallback=ContextLabelFallback.UNTITLED_SESSION,
        )
        selected_ref = ContextRef(
            "selection-ref",
            ContextRefKind.SELECTION,
            "source.md",
            "标题 · 划词 · 划词",
            selection_source_label=" 标题 · 划词 ",
            anchor=SelectionAnchor(
                locator={"kind": "markdown", "start": 0, "end": 1, "source_map_version": "v1"},
                selected_text_hash="sha256:" + "a" * 64,
            ),
        )
        selected = self.replace(0, refs=(ref, selected_ref))
        snapshot = AssistantTurnSnapshot(
            snapshot_id="repair-snapshot",
            session_id=SESSION_A,
            client_turn_id="repair-turn",
            selection_revision=selected.revision,
            project_id=None,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            model_card_hash="card",
            admission_hash="admission",
            items=(
                AssistantTurnItem("e1", ref, ContextResolutionState.READY),
                AssistantTurnItem("e2", selected_ref, ContextResolutionState.READY),
            ),
        )
        self.store.create_snapshot(snapshot)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            definition = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (ASSISTANT_SELECTION_TABLE,)
            ).fetchone()[0]
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} RENAME TO assistant_context_selection_migration"
            )
            connection.execute(
                definition.replace(
                    f"REFERENCES {SESSION_CATALOG_TABLE}(",
                    f"REFERENCES {SESSION_CATALOG_TABLE}_migration(",
                )
            )
            connection.execute(
                f"INSERT INTO {ASSISTANT_SELECTION_TABLE} SELECT * FROM assistant_context_selection_migration"
            )
            connection.execute("DROP TABLE assistant_context_selection_migration")
        repaired = AssistantStore(self.database)
        self.assertEqual(repaired.selection(SESSION_A), selected)
        self.assertEqual(repaired.snapshot_for_turn(SESSION_A, "repair-turn"), snapshot)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_old_label_columns_upgrade_without_inventing_provenance(self) -> None:
        ref = replace(
            file_ref(), kind=ContextRefKind.SESSION, source_id=SESSION_B, label="未命名对话"
        )
        selected = self.replace(0, refs=(ref,))
        snapshot = AssistantTurnSnapshot(
            snapshot_id="legacy-snapshot",
            session_id=SESSION_A,
            client_turn_id="legacy-turn",
            selection_revision=selected.revision,
            project_id=None,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            model_card_hash="card",
            admission_hash="admission",
            items=(AssistantTurnItem("e1", ref, ContextResolutionState.READY),),
        )
        self.store.create_snapshot(snapshot)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            for table in (ASSISTANT_REF_TABLE, ASSISTANT_ITEM_TABLE):
                connection.execute(f"ALTER TABLE {table} DROP COLUMN label_fallback")
                connection.execute(f"ALTER TABLE {table} DROP COLUMN selection_source_label")
        upgraded = AssistantStore(self.database)
        self.assertEqual(upgraded.selection(SESSION_A), selected)
        self.assertEqual(upgraded.snapshot_for_turn(SESSION_A, "legacy-turn"), snapshot)
        self.assertIsNone(upgraded.selection(SESSION_A).refs[0].label_fallback)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"UPDATE {ASSISTANT_REF_TABLE} SET label_fallback = 'future-display'"
            )
        self.assertEqual(upgraded.selection(SESSION_A).refs[0].label, "未命名对话")
        self.assertIsNone(upgraded.selection(SESSION_A).refs[0].label_fallback)

    def test_label_provenance_freezes_restores_and_tracks_authoritative_rename(self) -> None:
        self.catalog.transition_model_thread(
            SESSION_B,
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id=f"vendor-{SESSION_B}",
            vendor_thread_id="title-source",
            model_id="contract-model",
            portable_history=(HistoryEntry(role="user", text="原始消息"),),
            updated_at=4.0,
        )
        history = HistoryService(self.catalog, ProductEventStore(self.database))
        service = AssistantService(
            self.store, providers={ContextRefKind.SESSION: SessionContextProvider(history)}
        )
        ref = ContextRef(
            "untitled-ref",
            ContextRefKind.SESSION,
            SESSION_B,
            "未命名对话",
            label_fallback=ContextLabelFallback.UNTITLED_SESSION,
        )
        self.catalog.rename(SESSION_B, OWNER, "")
        selected = service.replace_selection(
            session_id=SESSION_A,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ref,),
        )
        first = service.freeze(
            session_id=SESSION_A,
            client_turn_id="original",
            expected_revision=selected.revision,
            question="问题",
        )
        self.assertIsNotNone(first.context)
        context = first.context
        assert context is not None
        self.assertEqual(context.snapshot.items[0].ref.label_fallback, ref.label_fallback)
        self.assertEqual(context.surface_refs[0]["label_fallback"], ref.label_fallback)
        self.assertNotIn("label_fallback", context.model_context)
        stripped = replace(
            context.snapshot,
            items=tuple(
                replace(item, ref=replace(item.ref, label_fallback=None))
                for item in context.snapshot.items
            ),
        )
        self.assertEqual(service._render_model_card(stripped), context.model_context)
        self.assertEqual(
            hashlib.sha256(context.model_context.encode()).hexdigest(),
            context.snapshot.model_card_hash,
        )
        cold = AssistantService(AssistantStore(self.database))
        self.assertEqual(
            cold.freeze(
                session_id=SESSION_A,
                client_turn_id="original",
                expected_revision=selected.revision,
                question="问题",
            ).context,
            context,
        )
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = cold
        app.state.history_service = history
        register_assistant_routes(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context/{context.snapshot.snapshot_id}/session-preview?source_id={SESSION_B}"
        client = TestClient(app)
        self.assertEqual(client.get(endpoint).json()["label_fallback"], ref.label_fallback)
        for index, title in enumerate(("新的真实标题", "未命名对话")):
            self.catalog.rename(SESSION_B, OWNER, title)
            updated = service.freeze(
                session_id=SESSION_A,
                client_turn_id=f"renamed-{index}",
                expected_revision=selected.revision,
                question="问题",
            ).context
            assert updated is not None
            self.assertEqual(updated.snapshot.items[0].ref.label, title)
            self.assertIsNone(updated.snapshot.items[0].ref.label_fallback)
            preview = client.get(endpoint).json()
            self.assertEqual(preview["title"], title)
            self.assertIsNone(preview["label_fallback"])
            self.assertEqual(
                cold.freeze(
                    session_id=SESSION_A,
                    client_turn_id="original",
                    expected_revision=selected.revision,
                    question="问题",
                ).context,
                context,
            )
        self.assertEqual(self.catalog.get(SESSION_B).vendor_thread_id, "title-source")
        self.catalog.rename(SESSION_B, OWNER, "")
        selected = service.replace_selection(
            session_id=SESSION_A,
            expected_revision=selected.revision,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(replace(ref, label_fallback=None),),
        )
        legacy = service.freeze(
            session_id=SESSION_A,
            client_turn_id="legacy-unmarked",
            expected_revision=selected.revision,
            question="问题",
        ).context
        assert legacy is not None
        self.assertEqual(legacy.snapshot.items[0].ref.label, "未命名对话")
        self.assertIsNone(legacy.snapshot.items[0].ref.label_fallback)

    def test_display_provenance_is_excluded_from_admission_hash_and_failure_label_is_raw(
        self,
    ) -> None:
        ref = ContextRef("untitled-ref", ContextRefKind.SESSION, SESSION_B, "未命名对话")
        with self.assertRaises(ValueError):
            AssistantService._validate_refs((replace(ref, label_fallback="future-display"),))
        selected = self.replace(0, refs=(ref,))
        marked = replace(
            selected, refs=(replace(ref, label_fallback=ContextLabelFallback.UNTITLED_SESSION),)
        )
        legacy_ref = asdict(ref)
        legacy_ref.pop("label_fallback")
        legacy_ref.pop("selection_source_label")
        legacy_ref.pop("project_id")
        legacy_payload = {
            "client_turn_id": "turn",
            "question_hash": hashlib.sha256("问题".encode()).hexdigest(),
            "revision": selected.revision,
            "project_policy": selected.project_policy.value,
            "search_scope": selected.search_scope.value,
            "refs": [legacy_ref],
        }
        legacy_hash = hashlib.sha256(
            json.dumps(
                legacy_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
        self.assertEqual(AssistantService._admission_hash(selected, "turn", "问题"), legacy_hash)
        self.assertEqual(AssistantService._admission_hash(marked, "turn", "问题"), legacy_hash)
        self.assertNotEqual(
            AssistantService._admission_hash(
                replace(selected, refs=(replace(ref, project_id="source-project"),)),
                "turn",
                "问题",
            ),
            legacy_hash,
        )
        self.assertNotEqual(
            AssistantService._admission_hash(marked, "turn", "另一个问题"), legacy_hash
        )
        self.assertNotEqual(
            AssistantService._admission_hash(
                replace(marked, refs=(replace(marked.refs[0], source_id="another"),)),
                "turn",
                "问题",
            ),
            legacy_hash,
        )
        selected = self.replace(selected.revision, refs=marked.refs)
        result = AssistantService(self.store).freeze(
            session_id=SESSION_A,
            client_turn_id="failure",
            expected_revision=selected.revision,
            question="问题",
        )
        assert result.failure is not None
        self.assertEqual(result.failure.issues[0].label, "未命名对话")
        self.assertEqual(
            result.failure.issues[0].label_fallback, ContextLabelFallback.UNTITLED_SESSION
        )

    def test_selection_cas_is_durable_and_session_scoped(self) -> None:
        initial = self.store.selection(SESSION_A)
        self.assertEqual(initial.search_scope, SearchScope.WEB)
        selected = self.replace(initial.revision, refs=(file_ref(),))

        self.assertEqual(selected.revision, 1)
        self.assertEqual(selected.search_scope, SearchScope.ACADEMIC)
        self.assertEqual(selected.refs, (file_ref(),))
        self.assertEqual(AssistantStore(self.database).selection(SESSION_A), selected)
        self.assertEqual(AssistantStore(self.database).selection(SESSION_B).revision, 0)

        with self.assertRaises(AssistantRevisionConflictError) as conflict:
            self.replace(0)
        self.assertEqual(conflict.exception.latest, selected)
        self.assertEqual(self.store.selection(SESSION_A), selected)

    def test_concurrent_replace_accepts_exactly_one_writer(self) -> None:
        def update(index: int) -> bool:
            try:
                AssistantStore(self.database).replace_selection(
                    session_id=SESSION_A,
                    expected_revision=0,
                    project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                    search_scope=SearchScope.DISABLED,
                    refs=(file_ref(f"ref-{index}"),),
                )
                return True
            except AssistantRevisionConflictError:
                return False

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(update, range(2)))
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(self.store.selection(SESSION_A).revision, 1)

    def test_relocation_selection_clear_is_atomic_and_preserves_snapshot(self) -> None:
        selected = self.replace(0, refs=(file_ref(),))
        snapshot = AssistantTurnSnapshot(
            snapshot_id="relocation-snapshot",
            session_id=SESSION_A,
            client_turn_id="original-turn",
            selection_revision=selected.revision,
            project_id="original-project",
            project_policy=selected.project_policy,
            search_scope=selected.search_scope,
            model_card_hash="card",
            admission_hash="admission",
            items=(),
            created_at=2.0,
        )
        self.store.create_snapshot(snapshot)
        events = ProductEventStore(self.database)
        with self.assertRaisesRegex(ValueError, "abort relocation"):
            with events.transaction() as connection:
                self.assertTrue(self.store.clear_for_relocation(SESSION_A, connection))
                raise ValueError("abort relocation")
        self.assertEqual(self.store.selection(SESSION_A), selected)
        with events.transaction() as connection:
            self.assertTrue(self.store.clear_for_relocation(SESSION_A, connection))
        cleared = self.store.selection(SESSION_A)
        self.assertEqual(cleared.refs, ())
        self.assertEqual(cleared.revision, selected.revision + 1)
        self.assertEqual(self.store.snapshot_for_turn(SESSION_A, "original-turn"), snapshot)

    def test_relocation_does_not_discard_claimed_reference(self) -> None:
        selected = self.replace(0, refs=(file_ref("queued", ContextRetention.NEXT_TURN),))
        self.store.claim_for_turn(
            session_id=SESSION_A,
            client_turn_id="queued-turn",
            expected_revision=selected.revision,
        )
        with ProductEventStore(self.database).transaction() as connection:
            self.assertFalse(self.store.clear_for_relocation(SESSION_A, connection))
        self.assertEqual(
            self.store.selection(SESSION_A),
            replace(selected, claimed_ref_ids=("queued",)),
        )

    def test_snapshot_is_idempotent_and_cascades_with_session(self) -> None:
        ref = file_ref()
        item = AssistantTurnItem(
            evidence_id="e_01",
            ref=ref,
            state=ContextResolutionState.READY,
            excerpt_text="evidence",
            excerpt_hash="hash",
            used_chars=8,
        )
        snapshot = AssistantTurnSnapshot(
            snapshot_id="snapshot-a",
            session_id=SESSION_A,
            client_turn_id="client-turn-a",
            selection_revision=0,
            project_id=None,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            model_card_hash="card",
            admission_hash="admission",
            items=(item,),
            created_at=2.0,
        )
        self.assertEqual(self.store.create_snapshot(snapshot), snapshot)
        self.assertEqual(self.store.create_snapshot(snapshot), snapshot)
        self.assertEqual(self.store.snapshot_for_turn(SESSION_A, "client-turn-a"), snapshot)

        self.catalog.release(SESSION_A, OWNER)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(
                connection.execute(
                    f"SELECT COUNT(*) FROM {ASSISTANT_SELECTION_TABLE} WHERE session_id = ?",
                    (SESSION_A,),
                ).fetchone()[0],
                0,
            )
            self.assertEqual(
                connection.execute(
                    f"SELECT COUNT(*) FROM {ASSISTANT_SNAPSHOT_TABLE} WHERE session_id = ?",
                    (SESSION_A,),
                ).fetchone()[0],
                0,
            )

    def test_scope_snapshot_round_trips_model_locator(self) -> None:
        ref = replace(file_ref(), kind=ContextRefKind.DIR, source_id="folder", label="folder")
        item = AssistantTurnItem(
            evidence_id="e_01",
            ref=ref,
            state=ContextResolutionState.READY,
            role=ContextItemRole.SCOPE,
            model_locator="/validated/project/folder",
        )
        snapshot = AssistantTurnSnapshot(
            snapshot_id="snapshot-scope",
            session_id=SESSION_A,
            client_turn_id="client-turn-scope",
            selection_revision=0,
            project_id="project-a",
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            model_card_hash="card",
            admission_hash="admission",
            items=(item,),
            created_at=3.0,
        )

        self.assertEqual(self.store.create_snapshot(snapshot), snapshot)
        self.assertEqual(
            self.store.snapshot_for_turn(SESSION_A, "client-turn-scope"),
            snapshot,
        )

    def test_next_turn_claim_is_immutable_and_consumes_only_owned_refs(self) -> None:
        persistent = file_ref("persistent")
        transient = file_ref("transient", ContextRetention.NEXT_TURN)
        selected = self.replace(0, refs=(persistent, transient))

        claimed = self.store.claim_for_turn(
            session_id=SESSION_A,
            client_turn_id="turn-claim",
            expected_revision=selected.revision,
        )
        self.assertEqual(claimed.refs, (persistent, transient))
        self.assertEqual(self.store.selection(SESSION_A).claimed_ref_ids, (transient.ref_id,))
        with self.assertRaises(AssistantStateConflictError):
            self.replace(selected.revision, refs=(persistent,))

        next_ref = file_ref("next-round")
        edited = self.replace(selected.revision, refs=(persistent, transient, next_ref))
        self.assertEqual(edited.claimed_ref_ids, (transient.ref_id,))
        consumed = self.store.consume_claim(
            session_id=SESSION_A,
            client_turn_id="turn-claim",
        )
        self.assertEqual(consumed.revision, edited.revision + 1)
        self.assertEqual(consumed.refs, (persistent, next_ref))
        self.assertEqual(consumed.claimed_ref_ids, ())

    def test_rejected_turn_releases_next_turn_ref(self) -> None:
        transient = file_ref("transient", ContextRetention.NEXT_TURN)
        selected = self.replace(0, refs=(transient,))
        self.store.claim_for_turn(
            session_id=SESSION_A,
            client_turn_id="turn-rejected",
            expected_revision=selected.revision,
        )

        released = self.store.release_claim(
            session_id=SESSION_A,
            client_turn_id="turn-rejected",
        )

        self.assertEqual(released, selected)
        self.assertEqual(released.claimed_ref_ids, ())

    def test_snapshot_replay_rejects_a_different_question(self) -> None:
        selected = self.replace(0)
        service = AssistantService(self.store, project_for_session=lambda _session_id: "project-a")

        first = service.freeze(
            session_id=SESSION_A,
            client_turn_id="stable-client-turn",
            expected_revision=selected.revision,
            question="第一个问题",
        )
        replay = service.freeze(
            session_id=SESSION_A,
            client_turn_id="stable-client-turn",
            expected_revision=selected.revision,
            question="第一个问题",
        )
        conflict = service.freeze(
            session_id=SESSION_A,
            client_turn_id="stable-client-turn",
            expected_revision=selected.revision,
            question="另一个问题",
        )

        self.assertIsNotNone(first.context)
        self.assertEqual(replay.context, first.context)
        self.assertIsNotNone(conflict.failure)
        assert conflict.failure is not None
        self.assertEqual(conflict.failure.kind, AssistantContextFailureKind.IDEMPOTENCY_CONFLICT)

    def _legacy_foreign_keys(self):
        selected = self.replace(0, refs=(file_ref(),))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} RENAME TO broken_ref")
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} RENAME TO assistant_context_selection_migration"
            )
            connection.execute(f"""
                CREATE TABLE {ASSISTANT_SELECTION_TABLE} (
                    session_id TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL,
                    project_policy TEXT NOT NULL,
                    search_scope TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES session_catalog_migration(session_id)
                        ON DELETE CASCADE
                )
                """)
            connection.execute(f"""
                INSERT INTO {ASSISTANT_SELECTION_TABLE}
                SELECT * FROM assistant_context_selection_migration
                """)
            connection.execute(f"""
                CREATE TABLE {ASSISTANT_REF_TABLE} (
                    session_id TEXT NOT NULL,
                    ref_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    source_revision TEXT,
                    label TEXT NOT NULL,
                    anchor TEXT,
                    order_index INTEGER NOT NULL,
                    PRIMARY KEY(session_id, ref_id),
                    UNIQUE(session_id, order_index),
                    FOREIGN KEY(session_id) REFERENCES assistant_context_selection_migration(session_id)
                        ON DELETE CASCADE
                )
                """)
            connection.execute(f"""
                INSERT INTO {ASSISTANT_REF_TABLE} (
                    session_id, ref_id, kind, source_id, source_revision, label, anchor, order_index
                )
                SELECT
                    session_id, ref_id, kind, source_id, source_revision, label, anchor, order_index
                FROM broken_ref
                """)
            connection.execute("DROP TABLE broken_ref")
            connection.execute("DROP TABLE assistant_context_selection_migration")

        return selected

    def test_current_store_reopens_without_write_connection(self) -> None:
        with patch.object(
            AssistantStore, "_connect", side_effect=AssertionError("unexpected write")
        ):
            AssistantStore(self.database)

    def test_missing_schema_inspection_does_not_create_database(self) -> None:
        missing = self.database.parent / "absent" / "sessions.sqlite3"
        self.assertTrue(AssistantStore.inspect_schema(missing).needs_write)
        self.assertFalse(missing.parent.exists())

    def test_future_column_reopens_without_write_connection(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} ADD COLUMN future_scope TEXT"
            )
            before = tuple(connection.iterdump())
        with patch.object(AssistantStore, "_connect", side_effect=AssertionError("opened writer")):
            AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_future_default_columns_allow_existing_selection_writes(self) -> None:
        selected = self.replace(0, refs=(file_ref(),))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} ADD COLUMN future_revision INTEGER NOT NULL DEFAULT 7"
            )
            connection.execute(f"UPDATE {ASSISTANT_SELECTION_TABLE} SET future_revision=23")
            connection.execute(
                f"ALTER TABLE {ASSISTANT_REF_TABLE} ADD COLUMN future_label TEXT DEFAULT 'New field' "
            )
        reopened = AssistantStore(self.database)
        self.assertEqual(reopened.selection(SESSION_A), selected)
        self.replace(selected.revision, refs=(file_ref(),))
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(
                    f"SELECT future_revision FROM {ASSISTANT_SELECTION_TABLE}"
                ).fetchall(),
                [(23,)],
            )
            self.assertEqual(
                connection.execute(f"SELECT future_label FROM {ASSISTANT_REF_TABLE}").fetchall(),
                [("New field",)],
            )

    def test_future_column_does_not_hide_missing_required_column(self) -> None:
        self.replace(0, refs=(file_ref(),))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} ADD COLUMN future_scope TEXT")
            connection.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} DROP COLUMN label")
            before = tuple(connection.iterdump())
        with patch.object(AssistantStore, "_connect", side_effect=AssertionError("opened writer")):
            with self.assertRaisesRegex(RuntimeError, "unsupported assistant missing columns"):
                AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_incompatible_future_columns_are_rejected_without_writes(self) -> None:
        for declaration in (
            "TEXT NOT NULL",
            "TEXT NOT NULL DEFAULT NULL",
            "TEXT CHECK(future_value IS NULL)",
            "TEXT REFERENCES session_catalog(session_id)",
            "TEXT GENERATED ALWAYS AS (session_id) VIRTUAL",
        ):
            with self.subTest(declaration=declaration):
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    connection.execute(
                        f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} ADD COLUMN future_value {declaration}"
                    )
                    before = tuple(connection.iterdump())
                with self.assertRaisesRegex(RuntimeError, "unsupported assistant"):
                    AssistantStore(self.database)
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    self.assertEqual(tuple(connection.iterdump()), before)
                    connection.execute(
                        f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} DROP COLUMN future_value"
                    )

    def test_future_column_survives_additive_upgrade(self) -> None:
        self.replace(0, refs=(file_ref(),))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} DROP COLUMN label_fallback")
            connection.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} ADD COLUMN preserved_extra TEXT")
            connection.execute(f"UPDATE {ASSISTANT_REF_TABLE} SET preserved_extra='user-asset'")
        reopened = AssistantStore(self.database)
        self.assertEqual(reopened.selection(SESSION_A).refs, self.store.selection(SESSION_A).refs)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(
                    f"SELECT preserved_extra, label_fallback FROM {ASSISTANT_REF_TABLE}"
                ).fetchall(),
                [("user-asset", None)],
            )
        self.assertFalse(AssistantStore.inspect_schema(self.database).needs_write)

    def test_schema_inspection_sees_wal_columns_and_index_without_writing(self) -> None:
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} DROP COLUMN label_fallback")
            writer.execute(f"DROP INDEX idx_{ASSISTANT_REF_TABLE}_note")
            writer.commit()
            wal = Path(str(self.database) + "-wal")
            before = self.database.read_bytes(), wal.read_bytes()
            schema = AssistantStore.inspect_schema(self.database)
            self.assertEqual(schema.add_columns, ((ASSISTANT_REF_TABLE, "label_fallback"),))
            self.assertEqual(schema.create_indexes, (f"idx_{ASSISTANT_REF_TABLE}_note",))
            self.assertEqual((self.database.read_bytes(), wal.read_bytes()), before)
            AssistantStore(self.database)
            self.assertFalse(AssistantStore.inspect_schema(self.database).needs_write)

    def test_owned_index_predicate_literal_is_not_case_normalized(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection, connection:
            name = f"idx_{ASSISTANT_REF_TABLE}_note"
            definition = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (name,)
            ).fetchone()[0]
            connection.execute(f"DROP INDEX {name}")
            connection.execute(definition.replace("'note'", "'NOTE'"))
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "unsupported assistant owned index"):
            AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_store_repair_failure_restores_all_tables(self) -> None:
        self._legacy_foreign_keys()
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())

        def interrupted(connection, table, create):
            rebuild_table(connection, table, create)
            raise OSError("interrupted after copying and dropping migration table")

        with patch("service.assistant.persistence.store.rebuild_table", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "interrupted after copying"):
                AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)
        repaired = AssistantStore(self.database)
        self.assertEqual(len(repaired.selection(SESSION_A).refs), 1)

    def test_store_repair_preserves_external_dependents(self) -> None:
        selected = self._legacy_foreign_keys()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"CREATE TABLE selection_notes(session_id TEXT REFERENCES {ASSISTANT_SELECTION_TABLE}(session_id) ON DELETE CASCADE, note TEXT)"
            )
            connection.execute(
                "INSERT INTO selection_notes VALUES(?, 'preserve note')", (SESSION_A,)
            )
            connection.execute("CREATE TABLE selection_changes(revision INTEGER)")
            connection.execute(
                f"CREATE INDEX selection_updated ON {ASSISTANT_SELECTION_TABLE}(updated_at)"
            )
            connection.execute(
                f"CREATE TRIGGER selection_changed AFTER UPDATE ON {ASSISTANT_SELECTION_TABLE} BEGIN INSERT INTO selection_changes VALUES(NEW.revision); END"
            )
            definitions = connection.execute(
                "SELECT name,sql FROM sqlite_master WHERE name IN ('selection_updated','selection_changed') ORDER BY name"
            ).fetchall()
        self.assertEqual(AssistantStore(self.database).selection(SESSION_A), selected)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            with self.subTest(check="incoming target"):
                self.assertEqual(
                    connection.execute("PRAGMA foreign_key_list(selection_notes)").fetchone()[2],
                    ASSISTANT_SELECTION_TABLE,
                )
            with self.subTest(check="child row"):
                self.assertEqual(
                    connection.execute("SELECT * FROM selection_notes").fetchall(),
                    [(SESSION_A, "preserve note")],
                )
            with self.subTest(check="index and trigger"):
                self.assertEqual(
                    connection.execute(
                        "SELECT name,sql FROM sqlite_master WHERE name IN ('selection_updated','selection_changed') ORDER BY name"
                    ).fetchall(),
                    definitions,
                )
            connection.execute(
                f"UPDATE {ASSISTANT_SELECTION_TABLE} SET revision=revision+1 WHERE session_id=?",
                (SESSION_A,),
            )
            with self.subTest(check="trigger execution"):
                self.assertEqual(
                    connection.execute("SELECT * FROM selection_changes").fetchall(),
                    [(selected.revision + 1,)],
                )

    def test_store_repair_preserves_future_column(self) -> None:
        self._legacy_foreign_keys()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} ADD COLUMN future_scope TEXT"
            )
            connection.execute(
                f"UPDATE {ASSISTANT_SELECTION_TABLE} SET future_scope='preserve this value'"
            )
            connection.execute(
                f'ALTER TABLE {ASSISTANT_SELECTION_TABLE} ADD COLUMN "future score" REAL NOT NULL DEFAULT -1.25'
            )
        AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(
                    f"SELECT future_scope FROM {ASSISTANT_SELECTION_TABLE}"
                ).fetchall(),
                [("preserve this value",)],
            )
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(
                connection.execute(
                    f'SELECT "future score" FROM {ASSISTANT_SELECTION_TABLE}'
                ).fetchall(),
                [(-1.25,)],
            )
        self.assertFalse(AssistantStore.inspect_schema(self.database).needs_write)

    def test_store_repair_refuses_unknown_constraint(self) -> None:
        self._legacy_foreign_keys()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (ASSISTANT_SELECTION_TABLE,)
            ).fetchone()[0]
            rows = connection.execute(f"SELECT * FROM {ASSISTANT_SELECTION_TABLE}").fetchall()
            connection.execute(f"DROP TABLE {ASSISTANT_SELECTION_TABLE}")
            connection.execute(
                sql.replace(
                    "updated_at REAL NOT NULL", "updated_at REAL NOT NULL CHECK(updated_at >= 0)"
                )
            )
            connection.executemany(
                f"INSERT INTO {ASSISTANT_SELECTION_TABLE} VALUES(?,?,?,?,?)", rows
            )
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "unsupported assistant"):
            AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_store_repair_refuses_unconstrained_table(self) -> None:
        self._legacy_foreign_keys()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} RENAME TO unconstrained_source"
            )
            connection.execute(
                f"CREATE TABLE {ASSISTANT_SELECTION_TABLE} AS SELECT * FROM unconstrained_source"
            )
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "unsupported assistant"):
            AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_store_repair_refuses_unknown_foreign_target(self) -> None:
        self._legacy_foreign_keys()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (ASSISTANT_SELECTION_TABLE,)
            ).fetchone()[0]
            rows = connection.execute(f"SELECT * FROM {ASSISTANT_SELECTION_TABLE}").fetchall()
            connection.execute(f"DROP TABLE {ASSISTANT_SELECTION_TABLE}")
            connection.execute(sql.replace("session_catalog_migration", "unrecognized_sessions"))
            connection.executemany(
                f"INSERT INTO {ASSISTANT_SELECTION_TABLE} VALUES(?,?,?,?,?)", rows
            )
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "unsupported assistant"):
            AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_store_repair_refuses_additional_foreign_constraint(self) -> None:
        self._legacy_foreign_keys()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (ASSISTANT_SELECTION_TABLE,)
            ).fetchone()[0]
            rows = connection.execute(f"SELECT * FROM {ASSISTANT_SELECTION_TABLE}").fetchall()
            connection.execute(f"DROP TABLE {ASSISTANT_SELECTION_TABLE}")
            end = sql.rindex(")")
            connection.execute(
                sql[:end]
                + ", FOREIGN KEY(session_id) REFERENCES session_catalog(session_id) ON DELETE CASCADE"
                + sql[end:]
            )
            connection.executemany(
                f"INSERT INTO {ASSISTANT_SELECTION_TABLE} VALUES(?,?,?,?,?)", rows
            )
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "unsupported assistant"):
            AssistantStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_store_refuses_existing_migration_residue(self) -> None:
        for suffix in ("_migration", "_schema_rebuild", "_foreign_key_migration"):
            with self.subTest(suffix=suffix):
                table = ASSISTANT_SELECTION_TABLE + suffix
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    connection.execute(f"CREATE TABLE {table}(evidence TEXT)")
                    connection.execute(f"INSERT INTO {table} VALUES('recover this data')")
                    before = tuple(connection.iterdump())
                with self.assertRaisesRegex(RuntimeError, "recovery required"):
                    AssistantStore(self.database)
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    self.assertEqual(tuple(connection.iterdump()), before)
                    connection.execute(f"DROP TABLE {table}")

    def test_store_repairs_catalog_rebuild_foreign_key(self) -> None:
        selected = self._legacy_foreign_keys()

        repaired = AssistantStore(self.database)
        self.assertEqual(repaired.selection(SESSION_A), selected)
        self.assertEqual(repaired.selection(SESSION_A).refs[0].retention, ContextRetention.SESSION)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.row_factory = sqlite3.Row
            targets = {
                str(row["table"])
                for row in connection.execute(
                    f"PRAGMA foreign_key_list({ASSISTANT_SELECTION_TABLE})"
                ).fetchall()
            }
        self.assertEqual(targets, {SESSION_CATALOG_TABLE})

    def test_session_api_returns_conflict_and_capabilities(self) -> None:
        service = AssistantService(self.store)
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = service
        register_assistant_routes(app)
        client = TestClient(app)

        initial = client.get(f"/api/assistant/sessions/{SESSION_A}/context")
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(initial.json()["revision"], 0)
        self.assertEqual(initial.json()["search_scope"], "web")
        capability_names = {capability["name"] for capability in initial.json()["capabilities"]}
        self.assertIn("academic", capability_names)
        self.assertIn("web", capability_names)
        self.assertNotIn("disabled", capability_names)

        patch = {
            "expected_revision": 0,
            "project_policy": "explicit_only",
            "search_scope": "academic",
            "refs": [
                {
                    "kind": "file",
                    "source_id": "资料/证据.md",
                    "label": "证据.md",
                }
            ],
        }
        accepted = client.patch(
            f"/api/assistant/sessions/{SESSION_A}/context",
            json=patch,
        )
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["revision"], 1)
        self.assertTrue(accepted.json()["refs"][0]["ref_id"])

        conflict = client.patch(
            f"/api/assistant/sessions/{SESSION_A}/context",
            json=patch,
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["detail"]["latest"]["revision"], 1)

    def test_session_api_exposes_claim_without_mislabeling_immutable_conflict(self) -> None:
        service = AssistantService(self.store)
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = service
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context"
        patch = {
            "expected_revision": 0,
            "project_policy": "explicit_only",
            "search_scope": "web",
            "refs": [
                {
                    "ref_id": "claimed-file",
                    "kind": "file",
                    "source_id": "paper.pdf",
                    "label": "paper.pdf",
                    "retention": "next_turn",
                }
            ],
        }
        selected = client.patch(endpoint, json=patch)
        self.assertEqual(selected.status_code, 200)
        self.assertEqual(selected.json()["claimed_ref_ids"], [])

        self.store.claim_for_turn(
            session_id=SESSION_A,
            client_turn_id="running-turn",
            expected_revision=selected.json()["revision"],
        )
        self.assertEqual(client.get(endpoint).json()["claimed_ref_ids"], ["claimed-file"])
        rejected = client.patch(endpoint, json={**patch, "expected_revision": 1, "refs": []})
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["detail"]["error"], "assistant_claimed_refs_immutable")
        self.assertEqual(rejected.json()["detail"]["latest"]["claimed_ref_ids"], ["claimed-file"])

    def test_session_api_validates_and_round_trips_selection_locator(self) -> None:
        service = AssistantService(self.store)
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = service
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context"
        selection_ref = {
            "kind": "selection",
            "source_id": "资料/证据.md",
            "source_revision": "sha256:" + "1" * 64,
            "label": "证据.md 第 1 段",
            "retention": "next_turn",
            "origin": "explicit",
            "anchor": {
                "locator": {
                    "kind": "markdown",
                    "start": 2,
                    "end": 8,
                    "source_map_version": "markdown/v1",
                },
                "selected_text_hash": "sha256:" + "2" * 64,
                "preview_text": "display only",
            },
        }

        accepted = client.patch(
            endpoint,
            json={
                "expected_revision": 0,
                "project_policy": "explicit_only",
                "search_scope": "web",
                "refs": [selection_ref],
            },
        )

        self.assertEqual(accepted.status_code, 200)
        returned = accepted.json()["refs"][0]
        self.assertEqual(returned["retention"], "next_turn")
        self.assertEqual(returned["origin"], "explicit")
        self.assertEqual(
            returned["anchor"]["locator"],
            {**selection_ref["anchor"]["locator"], "segments": None},
        )

        invalid = dict(selection_ref)
        invalid["anchor"] = {
            **selection_ref["anchor"],
            "locator": {
                "kind": "markdown",
                "start": 9,
                "end": 3,
                "source_map_version": "markdown/v1",
            },
        }
        rejected = client.patch(
            endpoint,
            json={
                "expected_revision": 1,
                "project_policy": "explicit_only",
                "search_scope": "web",
                "refs": [invalid],
            },
        )
        self.assertEqual(rejected.status_code, 422)

        invalid_hash = dict(selection_ref)
        invalid_hash["anchor"] = {
            **selection_ref["anchor"],
            "selected_text_hash": "not-a-sha256",
        }
        rejected_hash = client.patch(
            endpoint,
            json={
                "expected_revision": 1,
                "project_policy": "explicit_only",
                "search_scope": "web",
                "refs": [invalid_hash],
            },
        )
        self.assertEqual(rejected_hash.status_code, 422)

        pdf_ref = {
            **selection_ref,
            "kind": "literature",
            "source_id": "paper-stable-id",
            "label": "A real paper · 划词",
            "anchor": {
                **selection_ref["anchor"],
                "locator": {
                    "kind": "pdf",
                    "page": 1,
                    "quads": [[0.1, 0.2, 0.4, 0.3]],
                    "text_length": 17,
                    "text_shape_hash": "sha256:" + "b" * 64,
                },
            },
        }
        accepted_pdf = client.patch(
            endpoint,
            json={
                "expected_revision": 1,
                "project_policy": "explicit_only",
                "search_scope": "web",
                "refs": [pdf_ref],
            },
        )
        self.assertEqual(accepted_pdf.status_code, 200)
        self.assertEqual(
            accepted_pdf.json()["refs"][0]["anchor"]["locator"]["text_length"],
            17,
        )
        self.assertEqual(
            accepted_pdf.json()["refs"][0]["anchor"]["locator"]["text_shape_hash"],
            "sha256:" + "b" * 64,
        )
        invalid_pdf_shape = {
            **pdf_ref,
            "anchor": {
                **pdf_ref["anchor"],
                "locator": {
                    **pdf_ref["anchor"]["locator"],
                    "text_shape_hash": "not-a-sha256",
                },
            },
        }
        rejected_pdf_shape = client.patch(
            endpoint,
            json={
                "expected_revision": 2,
                "project_policy": "explicit_only",
                "search_scope": "web",
                "refs": [invalid_pdf_shape],
            },
        )
        self.assertEqual(rejected_pdf_shape.status_code, 422)

    def test_session_api_round_trips_frozen_pdf_selection_text(self) -> None:
        service = AssistantService(self.store)
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = service
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = f"/api/assistant/sessions/{SESSION_A}/context"
        snapshot = "As scientific literature grows rapidly"

        accepted = client.patch(
            endpoint,
            json={
                "expected_revision": 0,
                "project_policy": "explicit_only",
                "search_scope": "disabled",
                "refs": [
                    {
                        "kind": "selection",
                        "source_id": "paper.pdf",
                        "source_revision": "sha256:" + "1" * 64,
                        "label": "paper.pdf · 划词",
                        "retention": "next_turn",
                        "origin": "explicit",
                        "anchor": {
                            "locator": {
                                "kind": "pdf",
                                "page": 1,
                                "quads": [[0.1, 0.2, 0.4, 0.3]],
                                "text_length": len(snapshot),
                            },
                            "selected_text_hash": "sha256:" + "2" * 64,
                            "preview_text": snapshot,
                            "snapshot_text": snapshot,
                        },
                    }
                ],
            },
        )

        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["refs"][0]["anchor"]["snapshot_text"], snapshot)
        restored = self.store.selection(SESSION_A)
        self.assertEqual(restored.refs[0].anchor.snapshot_text, snapshot)

    def test_session_api_appends_pdf_quote_while_first_quote_is_claimed(self) -> None:
        service = AssistantService(self.store)
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = service
        register_assistant_routes(app)
        client = TestClient(app)
        for kind, session_id in (("selection", SESSION_A), ("literature", SESSION_B)):
            with self.subTest(kind=kind):
                endpoint = f"/api/assistant/sessions/{session_id}/context"
                first_ref = {
                    "ref_id": "first-quote",
                    "kind": kind,
                    "source_id": "paper.pdf",
                    "source_revision": "sha256:" + "1" * 64,
                    "label": "paper.pdf · 划词",
                    "selection_source_label": "paper.pdf",
                    "retention": "next_turn",
                    "origin": "explicit",
                    "anchor": {
                        "document_id": "pdf-attachment" if kind == "literature" else None,
                        "locator": {
                            "kind": "pdf",
                            "page": 1,
                            "quads": [[0.1, 0.2, 0.4, 0.3]],
                            "text_length": 7,
                            "text_shape_hash": "sha256:" + "2" * 64,
                        },
                        "selected_text_hash": "sha256:" + "3" * 64,
                        "preview_text": "quote A",
                        "snapshot_text": "quote A",
                    },
                }
                patch = {
                    "expected_revision": 0,
                    "project_policy": "explicit_only",
                    "search_scope": "web",
                    "refs": [first_ref],
                }
                selected = client.patch(endpoint, json=patch)
                self.assertEqual(selected.status_code, 200)
                frozen = self.store.claim_for_turn(
                    session_id=session_id,
                    client_turn_id="first-turn",
                    expected_revision=selected.json()["revision"],
                )
                second_ref = {
                    **first_ref,
                    "ref_id": "second-quote",
                    "anchor": {
                        **first_ref["anchor"],
                        "locator": {
                            **first_ref["anchor"]["locator"],
                            "quads": [[0.1, 0.4, 0.4, 0.5]],
                        },
                        "selected_text_hash": "sha256:" + "4" * 64,
                        "preview_text": "quote B",
                        "snapshot_text": "quote B",
                    },
                }
                appended = client.patch(
                    endpoint,
                    json={
                        **patch,
                        "expected_revision": selected.json()["revision"],
                        "refs": [*selected.json()["refs"], second_ref],
                    },
                )
                self.assertEqual(appended.status_code, 200, appended.text)
                selection = appended.json()
                self.assertEqual(selection["claimed_ref_ids"], ["first-quote"])
                self.assertEqual(selection["refs"][0], selected.json()["refs"][0])
                self.assertEqual(self.store.selection(session_id).refs[0], frozen.refs[0])

                modified = {**selection["refs"][0], "label": "changed claimed quote"}
                rejected = client.patch(
                    endpoint,
                    json={
                        **patch,
                        "expected_revision": selection["revision"],
                        "refs": [modified, selection["refs"][1]],
                    },
                )
                self.assertEqual(rejected.status_code, 409)
                self.assertEqual(
                    rejected.json()["detail"]["error"], "assistant_claimed_refs_immutable"
                )
                remaining = self.store.consume_claim(
                    session_id=session_id, client_turn_id="first-turn"
                )
                self.assertEqual([ref.ref_id for ref in remaining.refs], ["second-quote"])
                next_turn = self.store.claim_for_turn(
                    session_id=session_id,
                    client_turn_id="second-turn",
                    expected_revision=remaining.revision,
                )
                self.assertEqual([ref.ref_id for ref in next_turn.refs], ["second-quote"])
                self.assertEqual(next_turn.refs[0].anchor.snapshot_text, "quote B")

    def test_session_reference_preview_is_snapshot_scoped_and_does_not_resume_target(self) -> None:
        history_entries = (
            HistoryEntry(role="user", text="原问题", turn_id="turn-1", item_id="user-1"),
            HistoryEntry(
                role="assistant",
                text="原回答",
                turn_id="turn-1",
                item_id="assistant-1",
            ),
        )
        self.catalog.transition_model_thread(
            SESSION_B,
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id=f"vendor-{SESSION_B}",
            vendor_thread_id="vendor-preview",
            model_id="contract-model",
            portable_history=history_entries,
            updated_at=4.0,
        )
        history = HistoryService(self.catalog, ProductEventStore(self.database))
        revision = history.source(SESSION_A, SESSION_B).revision
        reference = ContextRef(
            ref_id="session-reference",
            kind=ContextRefKind.SESSION,
            source_id=SESSION_B,
            source_revision=revision,
            label="被引用的会话",
        )
        self.store.create_snapshot(
            AssistantTurnSnapshot(
                snapshot_id="session-reference-snapshot",
                session_id=SESSION_A,
                client_turn_id="session-reference-turn",
                selection_revision=0,
                project_id=None,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                model_card_hash="card",
                admission_hash="admission",
                items=(
                    AssistantTurnItem(
                        evidence_id="session-evidence",
                        ref=reference,
                        state=ContextResolutionState.READY,
                        excerpt_text="",
                        excerpt_hash="",
                        used_chars=0,
                    ),
                ),
                created_at=3.0,
            )
        )
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.session_catalog = self.catalog
        app.state.assistant = AssistantService(self.store)
        app.state.history_service = history
        register_assistant_routes(app)
        client = TestClient(app)
        endpoint = (
            f"/api/assistant/sessions/{SESSION_A}/context/"
            f"session-reference-snapshot/session-preview?source_id={SESSION_B}"
        )

        preview = client.get(endpoint)

        self.assertEqual(preview.status_code, 200)
        self.assertEqual(
            [(message["role"], message["text"]) for message in preview.json()["messages"]],
            [("user", "原问题"), ("assistant", "原回答")],
        )
        self.assertFalse(preview.json()["changed"])
        self.assertEqual(self.catalog.get(SESSION_B).vendor_thread_id, "vendor-preview")

        self.catalog.transition_model_thread(
            SESSION_B,
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id="vendor-preview",
            vendor_thread_id="vendor-preview-updated",
            model_id="contract-model",
            portable_history=(
                *history_entries,
                HistoryEntry(
                    role="user",
                    text="引用后的新问题",
                    turn_id="turn-2",
                    item_id="user-2",
                ),
            ),
            updated_at=5.0,
        )
        updated = client.get(endpoint)
        self.assertEqual(updated.status_code, 200)
        self.assertTrue(updated.json()["changed"])
        self.assertEqual(updated.json()["messages"][-1]["text"], "引用后的新问题")
        self.assertEqual(self.catalog.get(SESSION_B).vendor_thread_id, "vendor-preview-updated")

        missing = client.get(
            f"/api/assistant/sessions/{SESSION_A}/context/unknown/"
            f"session-preview?source_id={SESSION_B}"
        )
        self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()
