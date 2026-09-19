"""Contract for Session-scoped Assistant selection and snapshot persistence."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from pathlib import Path

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
        with sqlite3.connect(self.database) as connection:
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
        with sqlite3.connect(self.database) as connection:
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
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} RENAME TO broken_selection"
            )
            connection.execute(
                f"CREATE TABLE {ASSISTANT_SELECTION_TABLE} AS SELECT * FROM broken_selection"
            )
        repaired = AssistantStore(self.database)
        self.assertEqual(repaired.selection(SESSION_A), selected)
        self.assertEqual(repaired.snapshot_for_turn(SESSION_A, "repair-turn"), snapshot)
        with sqlite3.connect(self.database) as connection:
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
        with sqlite3.connect(self.database) as connection:
            for table in (ASSISTANT_REF_TABLE, ASSISTANT_ITEM_TABLE):
                connection.execute(f"ALTER TABLE {table} DROP COLUMN label_fallback")
                connection.execute(f"ALTER TABLE {table} DROP COLUMN selection_source_label")
            connection.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} ADD COLUMN preserved_extra TEXT")
            connection.execute(f"UPDATE {ASSISTANT_REF_TABLE} SET preserved_extra = 'user-asset'")
        upgraded = AssistantStore(self.database)
        self.assertEqual(upgraded.selection(SESSION_A), selected)
        self.assertEqual(upgraded.snapshot_for_turn(SESSION_A, "legacy-turn"), snapshot)
        self.assertIsNone(upgraded.selection(SESSION_A).refs[0].label_fallback)
        with sqlite3.connect(self.database) as connection:
            self.assertEqual(
                connection.execute(f"SELECT preserved_extra FROM {ASSISTANT_REF_TABLE}").fetchone()[
                    0
                ],
                "user-asset",
            )
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
        self.assertEqual(self.store.selection(SESSION_A), selected)

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
        with sqlite3.connect(self.database) as connection:
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
        with self.assertRaises(AssistantStateConflictError):
            self.replace(selected.revision, refs=(persistent,))

        next_ref = file_ref("next-round")
        edited = self.replace(selected.revision, refs=(persistent, transient, next_ref))
        consumed = self.store.consume_claim(
            session_id=SESSION_A,
            client_turn_id="turn-claim",
        )
        self.assertEqual(consumed.revision, edited.revision + 1)
        self.assertEqual(consumed.refs, (persistent, next_ref))

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

    def test_store_repairs_catalog_rebuild_foreign_key(self) -> None:
        selected = self.replace(0, refs=(file_ref(),))
        with sqlite3.connect(self.database) as connection:
            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute(f"ALTER TABLE {ASSISTANT_REF_TABLE} RENAME TO broken_ref")
            connection.execute(
                f"ALTER TABLE {ASSISTANT_SELECTION_TABLE} RENAME TO broken_selection"
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
                SELECT * FROM broken_selection
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
                    FOREIGN KEY(session_id) REFERENCES broken_selection(session_id)
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
            connection.execute("DROP TABLE broken_selection")

        repaired = AssistantStore(self.database)
        self.assertEqual(repaired.selection(SESSION_A), selected)
        self.assertEqual(repaired.selection(SESSION_A).refs[0].retention, ContextRetention.SESSION)
        with sqlite3.connect(self.database) as connection:
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
        self.assertEqual(returned["anchor"]["locator"], selection_ref["anchor"]["locator"])

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
