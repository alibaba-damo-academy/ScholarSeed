"""Owner-local SQLite revisions; structural validators remain authoritative.

The caller owns directory admission. Revision steps run only on the supplied
connection and atomically publish their receipt after structural convergence.
There is deliberately no downgrade, autogeneration or source DDL execution.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

from service.persistence.project import schema_transaction, sql_tokens

LEGACY_REVISION = 0
REVISION_ROW_ID = 1
REVISION_SAVEPOINT = "scholarseed_schema_revision"
UPGRADE_REQUIRED = "SCHOLARSEED_SCHEMA_UPGRADE_REQUIRED"
SQLITE_MAX_INTEGER = (1 << 63) - 1


class SchemaUpgradeRequired(RuntimeError):
    """A valid receipt declares a revision newer than this reader supports."""


class SchemaRevisionInvalid(RuntimeError):
    """Revision metadata is malformed; upgrading is not a recovery diagnosis."""


@dataclass(frozen=True)
class Migration:
    revision: int
    parent: int
    upgrade: Callable[[sqlite3.Connection], None]


@dataclass(frozen=True)
class Revisions:
    owner: str
    steps: tuple[Migration, ...]

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", self.owner) or not self.steps:
            raise ValueError("invalid schema revision policy")
        for number, step in enumerate(self.steps, start=1):
            if (
                not isinstance(step.revision, int)
                or isinstance(step.revision, bool)
                or not isinstance(step.parent, int)
                or isinstance(step.parent, bool)
                or step.revision != number
                or step.parent != number - 1
                or not callable(step.upgrade)
            ):
                raise ValueError("schema revisions require one contiguous forward chain")

    @property
    def current(self) -> int:
        return self.steps[-1].revision

    @property
    def table(self) -> str:
        return self.owner + "_schema_revision"

    @property
    def declaration(self) -> str:
        return (
            f"CREATE TABLE {self.table} ("
            "id INTEGER PRIMARY KEY CHECK(id = 1), "
            "revision INTEGER NOT NULL CHECK(revision >= 1))"
        )

    def inspect_definition(self, connection: sqlite3.Connection) -> bool:
        """Check metadata DDL only; not proof of a valid revision receipt."""
        objects = connection.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE name=? OR tbl_name=?",
            (self.table, self.table),
        ).fetchall()
        if not objects:
            return False
        # No views, triggers, extra indices or schema supplied by the database.
        if (
            len(objects) != 1
            or objects[0][0] != "table"
            or objects[0][1] != self.table
            or sql_tokens(objects[0][2] or "") != sql_tokens(self.declaration)
        ):
            raise SchemaRevisionInvalid("invalid schema revision declaration")
        return True

    def inspect(self, connection: sqlite3.Connection) -> int:
        if not self.inspect_definition(connection):
            return LEGACY_REVISION
        rows = connection.execute(f"SELECT id,revision FROM {self.table} LIMIT 2").fetchall()
        if (
            len(rows) != 1
            or not isinstance(rows[0][0], int)
            or isinstance(rows[0][0], bool)
            or rows[0][0] != REVISION_ROW_ID
            or not isinstance(rows[0][1], int)
            or isinstance(rows[0][1], bool)
            or not 1 <= rows[0][1] <= SQLITE_MAX_INTEGER
        ):
            raise SchemaRevisionInvalid("invalid schema revision receipt")
        revision = rows[0][1]
        if revision > self.current:
            raise SchemaUpgradeRequired(
                f"{UPGRADE_REQUIRED} owner={self.owner} "
                f"revision={revision} supported={self.current}"
            )
        return revision

    def migrate(
        self,
        connection: sqlite3.Connection,
        *,
        validate: Callable[[sqlite3.Connection], bool],
        repair: Callable[[sqlite3.Connection], None],
    ) -> None:
        """Validate first; rollback DDL, rows and receipt together on any failure.

        validate returns whether a known structure needs owner maintenance.
        Current revisions still validate and may repair known additive omissions;
        the receipt never makes arbitrary structure acceptable.
        """
        with _atomic(connection):
            revision = self.inspect(connection)
            needs_repair = validate(connection)
            if revision == self.current:
                if needs_repair:
                    repair(connection)
            else:
                for step in self.steps[revision:]:
                    step.upgrade(connection)
            if validate(connection):
                raise RuntimeError("schema revision migration did not converge")
            if revision != self.current:
                if revision == LEGACY_REVISION:
                    connection.execute(self.declaration)
                    connection.execute(
                        f"INSERT INTO {self.table}(id,revision) VALUES (?,?)",
                        (REVISION_ROW_ID, self.current),
                    )
                else:
                    connection.execute(
                        f"UPDATE {self.table} SET revision=? WHERE id=?",
                        (self.current, REVISION_ROW_ID),
                    )
            if self.inspect(connection) != self.current:
                raise RuntimeError("schema revision receipt did not converge")


@contextmanager
def _atomic(connection: sqlite3.Connection) -> Iterator[None]:
    if not connection.in_transaction:
        with schema_transaction(connection):
            yield
        return
    connection.execute(f"SAVEPOINT {REVISION_SAVEPOINT}")
    try:
        yield
    except BaseException:
        connection.execute(f"ROLLBACK TO {REVISION_SAVEPOINT}")
        raise
    finally:
        connection.execute(f"RELEASE {REVISION_SAVEPOINT}")
