"""Forward-compatible additive columns for Assistant-owned tables."""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Mapping

from service.persistence.project import table_clauses

_COLUMN_TYPES = frozenset(("text", "integer", "real", "blob", "numeric"))
_NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\Z")


def extensions(
    connection: sqlite3.Connection, table: str, known_columns: set[str]
) -> dict[str, tuple[str, ...]]:
    """Allow only extra ordinary columns old named-column writes can omit.

    Required declarations remain the caller's responsibility. Extra constraints,
    generated columns and expressions are not treated as additive compatibility.
    """
    definition = connection.execute(
        "SELECT sql FROM sqlite_master WHERE name=? AND type='table'", (table,)
    ).fetchone()
    if definition is None:
        return {}
    columns = {
        str(row[1]).casefold(): row
        for row in connection.execute(f'PRAGMA table_xinfo("{table}")')
        if str(row[1]).casefold() not in {name.casefold() for name in known_columns}
    }
    result = {}
    for clause in table_clauses(definition[0], table):
        if clause[0] not in columns:
            continue
        column = columns[clause[0]]
        if len(clause) < 2 or clause[1] not in _COLUMN_TYPES or column[5] or column[6]:
            raise ValueError("unsupported extension column")
        tail = clause[2:]
        required = tail[:2] == ("not", "null")
        if required:
            tail = tail[2:]
        elif tail[:1] == ("null",):
            tail = tail[1:]
        if tail:
            literal = "".join(tail[1:])
            if tail[0] != "default" or not (
                (len(tail) == 2 and literal.startswith("'") and literal.endswith("'"))
                or _NUMBER.fullmatch(literal)
                or (not required and tail == ("default", "null"))
            ):
                raise ValueError("unsupported extension default or constraint")
        elif required:
            raise ValueError("required extension column has no default")
        result[clause[0]] = clause
    if result.keys() != columns.keys():
        raise ValueError("unsupported extension declaration")
    return result


def extend(
    connection: sqlite3.Connection, table: str, columns: Mapping[str, tuple[str, ...]]
) -> None:
    """Retain validated extra declarations when an owned FK repair rebuilds a table."""
    for name, clause in columns.items():
        quoted = '"' + name.replace('"', '""') + '"'
        declaration = " ".join(clause[1:])
        if "default" in clause[2:]:
            position = clause.index("default", 2)
            declaration = " ".join(clause[1 : position + 1]) + " " + "".join(clause[position + 1 :])
        connection.execute(f'ALTER TABLE "{table}" ADD COLUMN {quoted} {declaration}')
