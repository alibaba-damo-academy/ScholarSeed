"""Legacy binary PPT selection processor."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from service.workbench.domain.slides import IMPRESS_LOCATOR_KIND, SlideSelectionError
from service.workbench.domain.slides import SlideSnapshotRequired as PptSnapshotRequired


def _integer(locator: Mapping[str, Any], key: str) -> int:
    value = locator.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SlideSelectionError(key)
    return value


def _string(locator: Mapping[str, Any], key: str) -> str:
    value = locator.get(key)
    if not isinstance(value, str) or not value:
        raise SlideSelectionError(key)
    return value


def _validate_locator(locator: Mapping[str, Any]) -> None:
    if locator.get("kind") != IMPRESS_LOCATOR_KIND:
        raise SlideSelectionError("kind")
    if _integer(locator, "slide") < 1:
        raise SlideSelectionError("slide")
    _string(locator, "shape")
    has_start = "start" in locator
    has_end = "end" in locator
    if has_start != has_end:
        raise SlideSelectionError("range")
    if has_start:
        start = _integer(locator, "start")
        end = _integer(locator, "end")
        if start < 0 or end <= start:
            raise SlideSelectionError("range")


class PptSelectionProcessor:
    """Fail closed until a verified frozen snapshot is supplied by the action layer."""

    def resolve_selection(self, payload: bytes, locator: Mapping[str, Any]) -> str:
        _validate_locator(locator)
        raise PptSnapshotRequired("ppt_snapshot_required")

    def resolve_context(
        self,
        payload: bytes,
        locator: Mapping[str, Any],
        selected: str,
        *,
        max_chars: int,
    ) -> str:
        _validate_locator(locator)
        raise PptSnapshotRequired("ppt_snapshot_required")


__all__ = ["PptSelectionProcessor", "PptSnapshotRequired"]
