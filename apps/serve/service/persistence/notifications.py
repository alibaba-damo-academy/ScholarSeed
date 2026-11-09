"""Transactional, connection-local invalidations released after final commit."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from service.platform.notifications import Change, ChangeTopic

PENDING_TABLE = "pending_notifications"
TRIGGER_PREFIX = "notify"


@dataclass(frozen=True)
class NotificationRule:
    table: str
    operation: str
    topic: ChangeTopic
    owner: str = "''"
    subject: str = "''"
    predicate: str = "1"


class NotificationConnection(sqlite3.Connection):
    _notify: Callable[[Iterable[Change]], None] | None = None

    def observe(
        self,
        notify: Callable[[Iterable[Change]], None],
        rules: Iterable[NotificationRule],
    ) -> None:
        self.execute(
            f"CREATE TEMP TABLE {PENDING_TABLE} ("
            "topic TEXT NOT NULL,owner TEXT NOT NULL,subject TEXT NOT NULL,"
            "PRIMARY KEY(topic,owner,subject))"
        )
        tables = {
            row[0] for row in self.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        for index, rule in enumerate(rules):
            if rule.table not in tables:
                continue
            predicate = rule.predicate
            if rule.operation == "UPDATE" and predicate == "1":
                columns = tuple(row[1] for row in self.execute(f"PRAGMA table_info({rule.table})"))
                predicate = " OR ".join(
                    f'NEW."{column}" IS NOT OLD."{column}"' for column in columns
                )
            self.execute(
                f"CREATE TEMP TRIGGER {TRIGGER_PREFIX}_{index} AFTER {rule.operation} "
                f"ON main.{rule.table} WHEN {predicate} BEGIN "
                f"INSERT OR IGNORE INTO {PENDING_TABLE} VALUES "
                f"('{rule.topic.value}',{rule.owner},{rule.subject}); END"
            )
        self._notify = notify

    def commit(self) -> None:
        changes = (
            tuple(
                Change(ChangeTopic(row[0]), row[1], row[2])
                for row in self.execute(f"SELECT topic,owner,subject FROM {PENDING_TABLE}")
            )
            if self._notify is not None
            else ()
        )
        if changes:
            self.execute(f"DELETE FROM {PENDING_TABLE}")
        super().commit()
        if changes and self._notify is not None:
            self._notify(changes)

    def __exit__(self, kind: Any, value: Any, traceback: Any) -> bool:
        if kind is not None:
            self.rollback()
            return False
        try:
            self.commit()
        except BaseException:
            self.rollback()
            raise
        return False
