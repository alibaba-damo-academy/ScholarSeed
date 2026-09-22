"""Codex plan snapshot persistence contract for the task monitor."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from service.chat.persistence.catalog import (
    MAX_PERSISTED_TODOS,
    SESSION_CATALOG_TABLE,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)

PRINCIPAL = SessionPrincipal(user_id="todo-user")
SESSION_ID = "todo-session"


def step(content: str, status: str, ident: str) -> dict[str, object]:
    return {"content": content, "status": status, "id": ident}


class TodoMonitorContract(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="scholarseed-todo-")
        self.database = Path(self._temporary.name) / "catalog.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.catalog.register(
            SESSION_ID,
            PRINCIPAL,
            runtime_id="codex",
            vendor_thread_id="thread-todo",
            vendor_session_id="process-todo",
            runtime_workdir=str(Path(self._temporary.name) / SESSION_ID),
            project_path=None,
            output_root=str(Path(self._temporary.name) / SESSION_ID / "outputs"),
            codex_version="0.42.0",
            model_id="gpt-5-codex",
            policy_id="workspace-write",
            status=SessionStatus.RUNNING,
            title="",
            created_at=1.0,
        )

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def test_codex_plan_is_an_authoritative_full_snapshot(self) -> None:
        first = [
            step("检索文献", "completed", "t1"),
            step("读全文", "in_progress", "t2"),
        ]
        replacement = [
            step("执行实验", "in_progress", "n1"),
            step("生成报告", "pending", "n2"),
        ]
        self.catalog.save_todos(
            SESSION_ID,
            first,
            vendor_turn_id="turn-1",
            product_seq=1,
            explanation="initial plan",
        )
        self.catalog.save_todos(
            SESSION_ID,
            replacement,
            vendor_turn_id="turn-1",
            product_seq=2,
            explanation="experiment selected",
        )

        reopened = SessionCatalogStore(self.database).get(SESSION_ID)
        self.assertIsNotNone(reopened)
        assert reopened is not None
        self.assertEqual(reopened.todos, tuple(replacement))
        self.assertEqual(reopened.todo_turn_id, "turn-1")
        self.assertEqual(reopened.todo_product_seq, 2)
        self.assertEqual(reopened.todo_explanation, "experiment selected")

    def test_older_plan_sequence_cannot_overwrite_newer_snapshot(self) -> None:
        current = [step("当前任务", "in_progress", "t2")]
        stale = [step("旧任务", "pending", "t1")]
        self.catalog.save_todos(
            SESSION_ID,
            current,
            vendor_turn_id="turn-2",
            product_seq=5,
            explanation=None,
        )
        result = self.catalog.save_todos(
            SESSION_ID,
            stale,
            vendor_turn_id="turn-1",
            product_seq=4,
            explanation=None,
        )

        self.assertEqual(result, tuple(current))
        self.assertEqual(self.catalog.todos(SESSION_ID), tuple(current))

    def test_plan_is_bounded_and_corrupt_display_data_fails_soft(self) -> None:
        oversized = [
            step(f"步骤{index}", "pending", f"x{index}")
            for index in range(MAX_PERSISTED_TODOS + 120)
        ]
        self.catalog.save_todos(
            SESSION_ID,
            oversized,
            vendor_turn_id="turn-1",
            product_seq=1,
            explanation=None,
        )
        self.assertEqual(len(self.catalog.todos(SESSION_ID)), MAX_PERSISTED_TODOS)

        with sqlite3.connect(self.database) as connection:
            connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET todos = ? WHERE session_id = ?",
                ("{not json", SESSION_ID),
            )
        self.assertEqual(self.catalog.todos(SESSION_ID), ())


if __name__ == "__main__":
    unittest.main()
