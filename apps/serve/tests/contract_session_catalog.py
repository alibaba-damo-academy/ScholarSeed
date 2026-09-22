"""Contract for the final product session catalog and durable HIL state."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from scholarseed_runtime.contract import (
    CapabilitySet,
    CapabilityState,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeCapabilityName,
)
from service.assistant.service.authorization import (
    AUTHORIZATION_REQUIRED,
    LITERATURE_REVIEW_AUTHORIZATION_HEADER,
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_AUTHORIZATION_HEADER,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_AUTHORIZATION_HEADER,
    RESEARCH_IDEA_FULLTEXT,
    FulltextAuthorizer,
    authorization_question,
)
from service.chat.constants import SESSION_TITLE_DEFAULT, SessionTitleFallback
from service.chat.persistence.catalog import (
    CATALOG_COLUMNS,
    LEGACY_RUNTIME_ID,
    MAX_QUEUED_MESSAGES_PER_SESSION,
    QUEUE_RECOVERY_WAIT_INTERRUPTED,
    SESSION_CATALOG_TABLE,
    SESSION_MESSAGE_QUEUE_TABLE,
    HilStatus,
    OpenState,
    QueuedMessageState,
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionQueueCapacityError,
    SessionStateConflictError,
    SessionStatus,
)
from service.chat.runtime.interaction import SessionInteractions

OWNER = SessionPrincipal("catalog-owner")
OTHER_OWNER = SessionPrincipal("other-owner")
RUNTIME_ID = "codex"
TEST_DEADLINE = 2_000_000_000.0
ATTACHMENT_COUNT = 8


def allocate_session(catalog: SessionCatalogStore, session_id: str) -> None:
    catalog.allocate(
        session_id,
        OWNER,
        runtime_id=RUNTIME_ID,
        runtime_workdir=f"/research/{session_id}",
        project_path="/research",
        output_root=f"/research/{session_id}/outputs",
        model_id="gpt-5-codex",
        created_at=20.0,
        required_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
    )


def native_binding(session_id: str, thread_id: str) -> RuntimeBinding:
    return RuntimeBinding(
        product_session_id=session_id,
        runtime_id=RUNTIME_ID,
        adapter_version="0.2.0",
        runtime_version="0.147.0",
        protocol_version="2",
        protocol_schema_hash="a" * 64,
        opaque_session_ref=thread_id,
        capabilities=CapabilitySet(),
    )


def register_session(
    catalog: SessionCatalogStore,
    session_id: str,
    vendor_thread_id: str,
) -> None:
    catalog.register(
        session_id,
        OWNER,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=vendor_thread_id,
        vendor_session_id="vendor-process-1",
        runtime_workdir=f"/research/{session_id}",
        project_path="/research",
        output_root=f"/research/{session_id}/outputs",
        codex_version="0.42.0",
        model_id="gpt-5-codex",
        policy_id="workspace-write",
        status=SessionStatus.READY,
        title="新研究会话",
        created_at=20.0,
    )


class SessionCatalogContract(unittest.TestCase):
    def test_product_owned_question_resolves_without_runtime_delivery(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "product-question")
            events = []

            async def publish(kind, data, **kwargs):
                events.append((kind, data, kwargs))
                return None

            interactions = SessionInteractions("product-question", catalog, publish)
            question = {
                "id": "literature-review-fulltext:opaque",
                "header": "综述检索授权",
                "question": "是否允许读取全文？",
                "options": [{"label": "一键授权 (Recommended)"}, {"label": "拒绝"}],
            }
            waiting = asyncio.create_task(
                interactions.request_product_input(question, turn_id="turn-1")
            )
            await asyncio.sleep(0)
            resolved = await interactions.resolve(
                None,
                question["id"],
                {"answers": {question["id"]: "一键授权"}},
            )
            self.assertIsNotNone(resolved)
            self.assertEqual(await waiting, {"answers": {question["id"]: "一键授权"}})
            self.assertEqual(catalog.hil(question["id"]).status, HilStatus.RESOLVED)
            self.assertEqual([event[0] for event in events], ["hil_requested", "hil_resolved"])

        asyncio.run(scenario())

    def test_default_title_provenance_is_explicit_durable_and_cleared_atomically(self) -> None:
        catalog = SessionCatalogStore(self.database)
        values = dict(
            runtime_id=RUNTIME_ID,
            runtime_workdir="/research/title-source",
            project_path=None,
            output_root="/research/title-source/outputs",
            title=SESSION_TITLE_DEFAULT,
        )
        original = catalog.allocate(
            "generated", OWNER, **values, title_fallback=SessionTitleFallback.NEW_SESSION
        )
        self.assertEqual(catalog.allocate("generated", OWNER, **values), original)
        self.assertEqual(
            SessionCatalogStore(self.database).get("generated").title_fallback,
            SessionTitleFallback.NEW_SESSION,
        )
        untouched = catalog.adopt_generated_title(
            "generated", "ignored", replaceable_titles=("different",)
        )
        self.assertEqual(untouched, original)
        adopted = catalog.adopt_generated_title(
            "generated", "First message", replaceable_titles=(SESSION_TITLE_DEFAULT,)
        )
        self.assertEqual(adopted.title, "First message")
        self.assertIsNone(adopted.title_fallback)
        same_name = catalog.allocate("user", OWNER, **values)
        self.assertIsNone(same_name.title_fallback)
        catalog.allocate(
            "renamed", OWNER, **values, title_fallback=SessionTitleFallback.NEW_SESSION
        )
        renamed = catalog.rename("renamed", OWNER, SESSION_TITLE_DEFAULT)
        self.assertEqual(renamed.title, SESSION_TITLE_DEFAULT)
        self.assertIsNone(renamed.title_fallback)

    def test_old_title_column_upgrades_without_guessing_same_name_or_unknown_sources(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "legacy-empty")
        allocate_session(catalog, "legacy-same-name")
        catalog.rename("legacy-same-name", OWNER, SESSION_TITLE_DEFAULT)
        with sqlite3.connect(self.database) as connection:
            connection.execute(f"ALTER TABLE {SESSION_CATALOG_TABLE} DROP COLUMN title_fallback")
            connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET output_root = '', updated_at = 0"
            )
        upgraded = SessionCatalogStore(self.database)
        self.assertEqual(upgraded.get("legacy-empty").title, "")
        self.assertEqual(upgraded.get("legacy-same-name").title, SESSION_TITLE_DEFAULT)
        self.assertIsNone(upgraded.get("legacy-empty").title_fallback)
        self.assertIsNone(upgraded.get("legacy-same-name").title_fallback)
        self.assertEqual(upgraded.get("legacy-empty").output_root, "")
        self.assertEqual(upgraded.get("legacy-empty").updated_at, 0)
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET title_fallback = 'future-title'"
            )
        self.assertIsNone(upgraded.get("legacy-same-name").title_fallback)

    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="session-catalog-")
        self.database = Path(self._temporary.name) / "sessions.sqlite3"

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def test_runtime_binding_is_committed_with_the_product_session(self) -> None:
        catalog = SessionCatalogStore(self.database)
        binding = RuntimeBinding(
            product_session_id="product-bound",
            runtime_id=RUNTIME_ID,
            adapter_version="0.2.0",
            runtime_version="0.147.0",
            protocol_version="2",
            protocol_schema_hash="a" * 64,
            opaque_session_ref="thread-bound",
            capabilities=CapabilitySet(
                (RuntimeCapability("interrupt", CapabilityState.SUPPORTED),)
            ),
            profile="official",
        )
        catalog.register(
            "product-bound",
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id="thread-bound",
            vendor_session_id=None,
            runtime_workdir="/research/product-bound",
            project_path="/research",
            output_root="/research/product-bound/outputs",
            codex_version="0.147.0",
            model_id="gpt-5-codex",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="绑定会话",
            created_at=20.0,
            runtime_binding=binding,
        )

        self.assertEqual(catalog.runtime_binding("product-bound"), binding)

    def test_obsolete_work_schema_is_extended_without_rebuilding_rows(self) -> None:
        with sqlite3.connect(self.database) as connection:
            connection.execute("""
                CREATE TABLE session_access (
                    session_id TEXT PRIMARY KEY,
                    principal_id TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    work TEXT NOT NULL DEFAULT '',
                    runtime_workdir TEXT NOT NULL DEFAULT '',
                    project_path TEXT,
                    assignment_known INTEGER NOT NULL DEFAULT 0,
                    todos TEXT NOT NULL DEFAULT ''
                )
                """)
            connection.execute(
                "INSERT INTO session_access VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "legacy",
                    OWNER.user_id,
                    10.0,
                    "scholar",
                    "/legacy/workdir",
                    None,
                    1,
                    '[{"content":"旧待办"}]',
                ),
            )

        catalog = SessionCatalogStore(self.database)
        legacy = catalog.get("legacy")

        self.assertIsNotNone(legacy)
        assert legacy is not None
        self.assertEqual(legacy.runtime_id, LEGACY_RUNTIME_ID)
        self.assertEqual(legacy.status, SessionStatus.LEGACY_READONLY)
        self.assertIsNone(legacy.vendor_thread_id)
        self.assertEqual(legacy.todos, ({"content": "旧待办"},))
        with sqlite3.connect(self.database) as connection:
            columns = {
                str(row[1])
                for row in connection.execute(
                    f"PRAGMA table_info({SESSION_CATALOG_TABLE})"
                ).fetchall()
            }
        self.assertTrue(set(CATALOG_COLUMNS).issubset(columns))
        self.assertIn("work", columns)
        self.assertIn("assignment_known", columns)

    def test_binding_is_immutable_and_vendor_thread_is_unique(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        original = catalog.get("product-a")

        register_session(catalog, "product-a", "thread-a")
        self.assertEqual(catalog.get("product-a"), original)

        with self.assertRaises(SessionBindingConflictError):
            register_session(catalog, "product-b", "thread-a")
        with self.assertRaises(SessionBindingConflictError):
            catalog.register(
                "product-a",
                OWNER,
                runtime_id=RUNTIME_ID,
                vendor_thread_id="thread-b",
                vendor_session_id=None,
                runtime_workdir="/other",
                project_path=None,
                output_root="/other/outputs",
                codex_version=None,
                model_id=None,
                policy_id=None,
                status=SessionStatus.READY,
                title="",
                created_at=99.0,
            )

    def test_status_title_and_full_plan_survive_reopen(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.update_status(
            "product-a",
            SessionStatus.RUNNING,
            turn_id="turn-1",
            turn_status="in_progress",
            updated_at=30.0,
        )
        catalog.rename("product-a", OWNER, "材料疲劳研究", updated_at=31.0)
        first_plan = [{"step": "检索文献", "status": "completed"}]
        second_plan = [{"step": "运行实验", "status": "in_progress"}]
        catalog.save_todos(
            "product-a",
            first_plan,
            vendor_turn_id="turn-1",
            product_seq=1,
            explanation="initial",
        )
        catalog.save_todos(
            "product-a",
            second_plan,
            vendor_turn_id="turn-1",
            product_seq=2,
            explanation="replanned",
        )
        stale = catalog.save_todos(
            "product-a",
            first_plan,
            vendor_turn_id="turn-1",
            product_seq=1,
            explanation="initial",
        )

        self.assertEqual(stale, tuple(second_plan))
        reopened = SessionCatalogStore(self.database).get("product-a")
        self.assertIsNotNone(reopened)
        assert reopened is not None
        self.assertEqual(reopened.title, "材料疲劳研究")
        self.assertEqual(reopened.status, SessionStatus.RUNNING)
        self.assertEqual(reopened.last_turn_id, "turn-1")
        self.assertEqual(reopened.todos, tuple(second_plan))
        self.assertEqual(reopened.todo_product_seq, 2)
        self.assertEqual(reopened.todo_explanation, "replanned")

        with self.assertRaises(SessionStateConflictError):
            catalog.save_todos(
                "product-a",
                first_plan,
                vendor_turn_id="turn-1",
                product_seq=2,
                explanation="conflict",
            )

    def test_permission_policy_can_be_updated_for_existing_session(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")

        updated = catalog.set_policy("product-a", OWNER, "safe_auto", updated_at=40.0)

        self.assertEqual(updated.policy_id, "safe_auto")
        self.assertEqual(updated.updated_at, 40.0)
        reopened = SessionCatalogStore(self.database).get("product-a")
        self.assertIsNotNone(reopened)
        assert reopened is not None
        self.assertEqual(reopened.policy_id, "safe_auto")

    def test_hil_mapping_is_durable_and_consumed_once(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        payload = {"command": "python experiment.py", "choices": ["accept", "decline"]}
        first = catalog.record_hil(
            product_request_id="hil-product-1",
            session_id="product-a",
            vendor_request_id="rpc-7",
            vendor_turn_id="turn-1",
            vendor_item_id="item-2",
            method="item/commandExecution/requestApproval",
            payload=payload,
            created_at=40.0,
        )
        repeated = catalog.record_hil(
            product_request_id="hil-product-1",
            session_id="product-a",
            vendor_request_id="rpc-7",
            vendor_turn_id="turn-1",
            vendor_item_id="item-2",
            method="item/commandExecution/requestApproval",
            payload=payload,
            created_at=40.0,
        )

        self.assertEqual(first, repeated)
        self.assertEqual(SessionCatalogStore(self.database).pending_hil("product-a"), (first,))
        self.assertEqual(catalog.pending_hil_for_principal(OWNER), (first,))
        self.assertEqual(catalog.pending_hil_for_principal(OTHER_OWNER), ())
        decision = {"decision": "accept"}
        self.assertTrue(catalog.resolve_hil("hil-product-1", decision, resolved_at=41.0))
        self.assertFalse(catalog.resolve_hil("hil-product-1", decision, resolved_at=42.0))
        resolved = catalog.hil("hil-product-1")
        self.assertEqual(resolved.status, HilStatus.RESOLVED)
        self.assertEqual(resolved.decision, decision)
        self.assertEqual(catalog.acknowledge_hil("hil-product-1").decision, decision)
        self.assertEqual(catalog.pending_hil("product-a"), ())

    def test_fulltext_authorization_is_exact_turn_scope_and_fail_closed(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        authorizer = FulltextAuthorizer(self.database, catalog)
        first = authorizer.prepare(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=("literature:b", "literature:a", "literature:a"),
        )
        self.assertEqual(first.refs, ("literature:a", "literature:b"))
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            authorizer.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:a",
            )
        reopened = FulltextAuthorizer(self.database, SessionCatalogStore(self.database))
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            reopened.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:a",
            )
        catalog.record_hil(
            product_request_id="hil-product-idea",
            session_id="product-a",
            vendor_request_id="rpc-idea",
            vendor_turn_id="turn-1",
            vendor_item_id="item-idea",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": first.question_id}]},
        )
        catalog.resolve_hil(
            "hil-product-idea",
            {"answers": {first.question_id: "一键授权"}},
        )
        authorizer.require(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            ref_id="literature:a",
        )
        reopened.require(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            ref_id="literature:a",
        )
        for snapshot_id, turn_id, ref_id in (
            ("snapshot-1", "turn-1", "literature:c"),
            ("snapshot-2", "turn-1", "literature:a"),
            ("snapshot-1", "turn-2", "literature:a"),
        ):
            with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
                authorizer.require(
                    session_id="product-a",
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=RESEARCH_IDEA_FULLTEXT,
                    ref_id=ref_id,
                )

    def test_fulltext_authorization_policies_are_typed_and_isolated(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        authorizer = FulltextAuthorizer(self.database, catalog)
        cases = (
            (RESEARCH_IDEA_FULLTEXT, RESEARCH_IDEA_AUTHORIZATION_HEADER),
            (PRECISE_SEARCH_FULLTEXT, PRECISE_SEARCH_AUTHORIZATION_HEADER),
            (LITERATURE_REVIEW_FULLTEXT, LITERATURE_REVIEW_AUTHORIZATION_HEADER),
        )
        records = {}
        for authorization_type, header in cases:
            record = authorizer.prepare(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=authorization_type,
                refs=("literature:a",),
            )
            records[authorization_type] = record
            question = authorization_question(record)
            self.assertEqual(question["header"], header)
            self.assertEqual(
                [option["label"] for option in question["options"]],
                ["一键授权 (Recommended)", "拒绝"],
            )

        granted = records[PRECISE_SEARCH_FULLTEXT]
        catalog.record_hil(
            product_request_id="hil-precise",
            session_id="product-a",
            vendor_request_id="rpc-precise",
            vendor_turn_id="turn-1",
            vendor_item_id="item-precise",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": granted.question_id}]},
        )
        catalog.resolve_hil(
            "hil-precise",
            {"answers": {granted.question_id: "一键授权"}},
        )
        authorizer.require(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            ref_id="literature:a",
        )
        for authorization_type in (RESEARCH_IDEA_FULLTEXT, LITERATURE_REVIEW_FULLTEXT):
            with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
                authorizer.require(
                    session_id="product-a",
                    snapshot_id="snapshot-1",
                    turn_id="turn-1",
                    authorization_type=authorization_type,
                    ref_id="literature:a",
                )

    def test_denied_or_superseded_fulltext_authorization_never_grants(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        authorizer = FulltextAuthorizer(self.database, catalog)
        denied = authorizer.prepare(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=("literature:a",),
        )
        catalog.record_hil(
            product_request_id="hil-denied",
            session_id="product-a",
            vendor_request_id="rpc-denied",
            vendor_turn_id="turn-1",
            vendor_item_id="item-denied",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": denied.question_id}]},
        )
        catalog.resolve_hil(
            "hil-denied",
            {"answers": {denied.question_id: {"answers": ["拒绝"]}}},
        )
        replacement = authorizer.prepare(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=("literature:b",),
        )
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            authorizer.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:a",
            )
        catalog.record_hil(
            product_request_id="hil-stale",
            session_id="product-a",
            vendor_request_id="rpc-stale",
            vendor_turn_id="turn-1",
            vendor_item_id="item-stale",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": replacement.question_id}]},
        )
        self.assertTrue(catalog.stale_hil("hil-stale"))
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            authorizer.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:b",
            )

    def test_release_is_owner_scoped_and_cascades_hil(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.record_hil(
            product_request_id="hil-product-1",
            session_id="product-a",
            vendor_request_id="rpc-7",
            vendor_turn_id=None,
            vendor_item_id=None,
            method="item/fileChange/requestApproval",
            payload={},
        )

        catalog.release("product-a", OTHER_OWNER)
        self.assertIsNotNone(catalog.get("product-a"))
        catalog.release("product-a", OWNER)
        self.assertIsNone(catalog.get("product-a"))
        self.assertEqual(catalog.pending_hil("product-a"), ())

    def test_message_queue_preserves_enqueue_and_operation_order(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        one = catalog.enqueue_message(
            "product-a", "queue-1", {"input": [{"type": "text", "text": "1"}]}
        )
        two = catalog.enqueue_message(
            "product-a", "queue-2", {"input": [{"type": "text", "text": "2"}]}
        )
        three = catalog.enqueue_message(
            "product-a", "queue-3", {"input": [{"type": "text", "text": "3"}]}
        )
        self.assertEqual((one.enqueue_seq, two.enqueue_seq, three.enqueue_seq), (1, 2, 3))

        third_submission = catalog.begin_queued_submission("product-a", "queue-3")
        first_submission = catalog.begin_queued_submission("product-a", "queue-1")
        self.assertIsNotNone(third_submission)
        self.assertIsNotNone(first_submission)
        self.assertEqual((third_submission.operation_seq, first_submission.operation_seq), (1, 2))
        self.assertEqual(
            catalog.queued_message("product-a", "queue-2").state, QueuedMessageState.QUEUED
        )
        self.assertTrue(catalog.remove_queued_message("product-a", "queue-3"))
        self.assertEqual(
            [
                record.queued_message_id
                for record in SessionCatalogStore(self.database).queued_messages("product-a")
            ],
            ["queue-1", "queue-2"],
        )

    def test_message_queue_never_resubmits_an_unknown_outcome(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.enqueue_message(
            "product-a", "queue-unknown", {"input": [{"type": "text", "text": "once"}]}
        )
        claimed = catalog.begin_queued_submission("product-a", "queue-unknown")
        self.assertIsNotNone(claimed)
        catalog.fail_queued_submission(
            "product-a",
            "queue-unknown",
            unknown=True,
            safe_error="delivery_unknown",
        )

        self.assertIsNone(catalog.begin_queued_submission("product-a", "queue-unknown"))
        retained = catalog.queued_message("product-a", "queue-unknown")
        self.assertIsNotNone(retained)
        assert retained is not None
        self.assertEqual(retained.state, QueuedMessageState.OUTCOME_UNKNOWN)
        self.assertEqual(retained.operation_seq, 1)

    def test_message_queue_reconcile_applied_removes_only_the_exact_operation(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.enqueue_message(
            "product-a", "queue-applied", {"input": [{"type": "text", "text": "once"}]}
        )
        claimed = catalog.begin_queued_submission("product-a", "queue-applied")
        assert claimed is not None and claimed.operation_seq is not None
        catalog.fail_queued_submission(
            "product-a",
            "queue-applied",
            unknown=True,
            safe_error="delivery_unknown",
        )

        removed = catalog.remove_reconciled_unknown_message(
            "product-a",
            "queue-applied",
            claimed.operation_seq,
        )

        self.assertTrue(removed)
        self.assertEqual(
            catalog.queued_message("product-a", "queue-applied").state,
            QueuedMessageState.COMPLETED,
        )
        self.assertEqual(catalog.queued_messages("product-a"), ())
        self.assertFalse(
            catalog.remove_reconciled_unknown_message(
                "product-a", "queue-applied", claimed.operation_seq
            )
        )

    def test_first_open_is_durable_and_only_one_attempt_can_claim_it(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        before = catalog.activation("product-new")
        self.assertEqual(before.open_state, OpenState.NEVER_STARTED)
        self.assertIsNone(catalog.get("product-new").vendor_thread_id)
        self.assertIsNone(catalog.runtime_binding("product-new"))
        self.assertEqual(before.required_capabilities, (RuntimeCapabilityName.WEB_SEARCH,))
        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = tuple(
                executor.map(
                    lambda attempt: catalog.begin_open("product-new", attempt),
                    ("attempt-a", "attempt-b"),
                )
            )
        winners = tuple(claim for claim in claims if claim is not None)
        self.assertEqual(len(winners), 1)
        winner = winners[0]
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.activation("product-new"), winner)
        self.assertIsNone(reopened.begin_open("product-new", winner.open_attempt_id))
        self.assertFalse(reopened.mark_open_unknown("product-new", "wrong-attempt"))

    def test_open_binding_and_generation_are_committed_atomically(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        catalog.begin_open("product-new", "attempt-a")
        binding = native_binding("product-new", "thread-new")
        with self.assertRaises(SessionBindingConflictError):
            catalog.bind_open("product-new", "wrong-attempt", binding)
        self.assertIsNone(catalog.runtime_binding("product-new"))
        self.assertIsNone(catalog.get("product-new").vendor_thread_id)
        self.assertEqual(catalog.begin_attachment("product-new"), 1)
        record = catalog.bind_open("product-new", "attempt-a", binding)
        self.assertEqual(record.vendor_thread_id, "thread-new")
        self.assertEqual(catalog.runtime_binding("product-new"), binding)
        self.assertEqual(catalog.activation("product-new").open_state, OpenState.BOUND)
        self.assertEqual(catalog.bind_open("product-new", "attempt-a", binding), record)
        with self.assertRaises(SessionBindingConflictError):
            catalog.bind_open("product-new", "attempt-a", native_binding("product-new", "other"))
        with ThreadPoolExecutor(max_workers=4) as executor:
            generations = tuple(
                executor.map(
                    lambda _: catalog.begin_attachment("product-new"), range(ATTACHMENT_COUNT)
                )
            )
        self.assertEqual(sorted(generations), list(range(2, ATTACHMENT_COUNT + 2)))
        self.assertEqual(
            SessionCatalogStore(self.database).activation("product-new").generation,
            ATTACHMENT_COUNT + 1,
        )

    def test_native_binding_conflict_rolls_back_all_open_state(self) -> None:
        catalog = SessionCatalogStore(self.database)
        for session_id in ("product-a", "product-b"):
            allocate_session(catalog, session_id)
            catalog.begin_open(session_id, session_id)
        catalog.bind_open("product-a", "product-a", native_binding("product-a", "shared-thread"))
        with self.assertRaises(SessionBindingConflictError):
            catalog.bind_open(
                "product-b", "product-b", native_binding("product-b", "shared-thread")
            )
        self.assertEqual(catalog.activation("product-b").open_state, OpenState.OPENING)
        self.assertIsNone(catalog.get("product-b").vendor_thread_id)
        self.assertIsNone(catalog.runtime_binding("product-b"))

    def test_unknown_open_requires_positive_evidence_before_binding(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        with self.assertRaises(SessionStateConflictError):
            catalog.begin_attachment("product-new")
        catalog.begin_open("product-new", "attempt-a")
        self.assertTrue(catalog.mark_open_unknown("product-new", "attempt-a"))
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.activation("product-new").open_state, OpenState.OPEN_UNKNOWN)
        self.assertIsNone(reopened.begin_open("product-new", "attempt-b"))
        with self.assertRaises(SessionStateConflictError):
            reopened.begin_attachment("product-new")
        reopened.bind_open(
            "product-new", "attempt-a", native_binding("product-new", "known-thread")
        )
        self.assertEqual(reopened.activation("product-new").open_state, OpenState.BOUND)

    def test_existing_bindings_seed_bound_but_missing_bindings_do_not_seed_new(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-old", "thread-old")
        self.assertEqual(catalog.activation("product-old").open_state, OpenState.BOUND)
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                f"INSERT INTO {SESSION_CATALOG_TABLE} "
                "(session_id, principal_id, runtime_id, runtime_workdir, output_root, status, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("unbound-old", OWNER.user_id, RUNTIME_ID, "/old", "/old/out", "ready", 1.0, 1.0),
            )
        reopened = SessionCatalogStore(self.database)
        self.assertIsNone(reopened.activation("unbound-old"))
        self.assertIsNone(reopened.begin_open("unbound-old", "unsafe-retry"))

    def test_owned_connections_close_after_commit_and_rollback(self) -> None:
        real_connect = sqlite3.connect
        connections: list[sqlite3.Connection] = []

        def connect(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            connections.append(connection)
            return connection

        with patch("service.chat.persistence.catalog.sqlite3.connect", side_effect=connect):
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "connection-owner")
            catalog.get("connection-owner")
            catalog.activation("connection-owner")
            catalog.enqueue_message("connection-owner", "request", {"text": "hello"})
            with self.assertRaises(Exception):
                catalog.enqueue_message("connection-owner", "request", {"text": "changed"})
            catalog.recover_inflight()
        self.assertGreater(len(connections), 5)
        for connection in connections:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")

    def test_explicit_restart_recovery_pauses_waiting_and_preserves_completed_requests(
        self,
    ) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        catalog.begin_open("product-new", "attempt-a")
        for request_id in ("waiting", "submitted", "running", "completed"):
            catalog.enqueue_message("product-new", request_id, {"text": request_id})
            if request_id != "waiting":
                catalog.begin_queued_submission("product-new", request_id)
        catalog.begin_resource_wait(
            "product-new", "waiting", purpose="turn", deadline=TEST_DEADLINE
        )
        catalog.mark_queue_running("product-new", "running", "native-turn")
        catalog.complete_queued_message("product-new", "completed")
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.activation("product-new").open_state, OpenState.OPENING)
        self.assertEqual(
            reopened.queued_message("product-new", "running").state, QueuedMessageState.RUNNING
        )
        self.assertEqual(reopened.recover_inflight(), (1, 2))
        self.assertEqual(reopened.recover_inflight(), (0, 0))
        uncertainties = reopened.uncertainties("product-new", unresolved_only=True)
        self.assertEqual(
            {row.correlation_id for row in uncertainties}, {"submitted", "native-turn"}
        )
        self.assertTrue(all(row.state.value == "unknown" for row in uncertainties))
        self.assertEqual(reopened.activation("product-new").open_state, OpenState.OPEN_UNKNOWN)
        self.assertEqual(
            reopened.queued_message("product-new", "waiting").state,
            QueuedMessageState.FAILED,
        )
        self.assertEqual(
            reopened.queued_message("product-new", "waiting").safe_error,
            QUEUE_RECOVERY_WAIT_INTERRUPTED,
        )
        self.assertEqual(reopened.queued_message("product-new", "waiting").deadline, TEST_DEADLINE)
        self.assertEqual(
            reopened.queued_message("product-new", "running").native_turn_id, "native-turn"
        )
        self.assertEqual(
            reopened.queued_message("product-new", "running").state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        self.assertIsNone(reopened.begin_queued_submission("product-new", "submitted"))
        self.assertEqual(
            reopened.queued_message("product-new", "completed").state, QueuedMessageState.COMPLETED
        )

    def test_cancel_and_complete_keep_exact_request_idempotency(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        body = {"text": "once"}
        catalog.enqueue_message("product-new", "cancelled", body)
        waiting = catalog.begin_resource_wait(
            "product-new", "cancelled", purpose="turn", deadline=TEST_DEADLINE
        )
        self.assertEqual(waiting.deadline, TEST_DEADLINE)
        self.assertTrue(catalog.delete_queued_message("product-new", "cancelled"))
        self.assertEqual(
            catalog.enqueue_message("product-new", "cancelled", body).state,
            QueuedMessageState.CANCELLED,
        )
        self.assertIsNone(catalog.begin_queued_submission("product-new", "cancelled"))
        with self.assertRaises(SessionStateConflictError):
            catalog.enqueue_message("product-new", "cancelled", {"text": "different"})
        catalog.enqueue_message("product-new", "typed-value", {"value": True})
        with self.assertRaises(SessionStateConflictError):
            catalog.enqueue_message("product-new", "typed-value", {"value": 1})
        catalog.delete_queued_message("product-new", "typed-value")
        catalog.enqueue_message("product-new", "complete", body)
        catalog.begin_queued_submission("product-new", "complete")
        running = catalog.mark_queue_running("product-new", "complete", "native-turn")
        self.assertEqual(running.state, QueuedMessageState.RUNNING)
        self.assertEqual(catalog.queued_messages("product-new"), ())
        catalog.fail_queued_submission(
            "product-new", "complete", unknown=False, safe_error="late-rejection"
        )
        self.assertEqual(
            catalog.queued_message("product-new", "complete").state, QueuedMessageState.RUNNING
        )
        self.assertEqual(
            catalog.mark_queue_running("product-new", "complete", "native-turn"), running
        )
        with self.assertRaises(SessionStateConflictError):
            catalog.mark_queue_running("product-new", "complete", "different-turn")
        self.assertTrue(catalog.complete_queued_message("product-new", "complete"))
        self.assertEqual(
            catalog.enqueue_message("product-new", "complete", body).state,
            QueuedMessageState.COMPLETED,
        )
        self.assertIsNone(catalog.begin_queued_submission("product-new", "complete"))

    def test_old_queue_schema_is_extended_in_place(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-old", "thread-old")
        with sqlite3.connect(self.database) as connection:
            connection.execute(f"DROP TABLE {SESSION_MESSAGE_QUEUE_TABLE}")
            connection.execute(f"""
                CREATE TABLE {SESSION_MESSAGE_QUEUE_TABLE} (
                    queued_message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    enqueue_seq INTEGER NOT NULL, operation_seq INTEGER, state TEXT NOT NULL,
                    body TEXT NOT NULL, safe_error TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL, updated_at REAL NOT NULL
                )
                """)
            connection.execute(
                f"INSERT INTO {SESSION_MESSAGE_QUEUE_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "old-request",
                    "product-old",
                    1,
                    None,
                    "queued",
                    '{"text":"preserved"}',
                    "",
                    1.0,
                    1.0,
                ),
            )
        reopened = SessionCatalogStore(self.database)
        record = reopened.queued_message("product-old", "old-request")
        self.assertEqual(record.body, {"text": "preserved"})
        self.assertEqual(record.purpose, "turn")
        self.assertIsNone(record.deadline)
        self.assertEqual(record.native_turn_id, "")
        self.assertEqual(
            reopened.enqueue_message("product-old", "old-request", {"text": "preserved"}), record
        )

    def test_message_queue_has_a_durable_per_session_capacity(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        for index in range(MAX_QUEUED_MESSAGES_PER_SESSION):
            catalog.enqueue_message(
                "product-a",
                f"queue-{index}",
                {"input": [{"type": "text", "text": str(index)}]},
            )

        with self.assertRaises(SessionQueueCapacityError):
            catalog.enqueue_message(
                "product-a",
                "queue-overflow",
                {"input": [{"type": "text", "text": "overflow"}]},
            )
        self.assertEqual(
            len(SessionCatalogStore(self.database).queued_messages("product-a")),
            MAX_QUEUED_MESSAGES_PER_SESSION,
        )
        catalog.begin_queued_submission("product-a", "queue-0")
        catalog.mark_queue_running("product-a", "queue-0", "native-turn")
        with self.assertRaises(SessionQueueCapacityError):
            catalog.enqueue_message("product-a", "still-full", {"text": "later"})
        self.assertTrue(catalog.complete_queued_message("product-a", "queue-0"))
        replacement = catalog.enqueue_message("product-a", "after-completion", {"text": "later"})
        self.assertEqual(replacement.enqueue_seq, MAX_QUEUED_MESSAGES_PER_SESSION + 1)
        self.assertTrue(catalog.delete_queued_message("product-a", "queue-1"))
        catalog.enqueue_message("product-a", "after-cancellation", {"text": "later"})
        self.assertEqual(len(catalog.queued_messages("product-a")), MAX_QUEUED_MESSAGES_PER_SESSION)


if __name__ == "__main__":
    unittest.main()
