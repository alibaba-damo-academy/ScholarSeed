"""Legacy binary DOC selection evidence processor."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

FORMAT = "doc"
SUFFIX = ".doc"


class DocSelectionError(ValueError):
    """A legacy DOC selection cannot be resolved by this processor."""


def resolve_selection(_payload: bytes, _locator: Mapping[str, Any]) -> str:
    raise DocSelectionError("writer_legacy_document")


def resolve_context(_payload: bytes, _locator: Mapping[str, Any], _selected: str) -> str:
    raise DocSelectionError("writer_legacy_document")
