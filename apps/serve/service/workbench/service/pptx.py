"""OOXML PPTX selection processor."""

from __future__ import annotations

from collections.abc import Mapping
from io import BytesIO
from typing import Any, cast
from zipfile import BadZipFile

from pptx import Presentation
from pptx.shapes.autoshape import Shape

from service.workbench.domain.slides import IMPRESS_LOCATOR_KIND, SlideSelectionError


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


def _utf16_slice(text: str, start: int, end: int) -> str:
    if start < 0 or end < start:
        raise SlideSelectionError("range")
    encoded = text.encode("utf-16-le")
    if end * 2 > len(encoded):
        raise SlideSelectionError("range")
    try:
        return encoded[start * 2 : end * 2].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise SlideSelectionError("range") from exc


def _slide(payload: bytes, locator: Mapping[str, Any]):
    if locator.get("kind") != IMPRESS_LOCATOR_KIND:
        raise SlideSelectionError("kind")
    try:
        presentation = Presentation(BytesIO(payload))
        slide_number = _integer(locator, "slide")
        if slide_number < 1 or slide_number > len(presentation.slides):
            raise SlideSelectionError("slide")
        return presentation.slides[slide_number - 1]
    except SlideSelectionError:
        raise
    except (BadZipFile, KeyError, ValueError) as exc:
        raise SlideSelectionError("pptx_document") from exc


class PptxSelectionProcessor:
    """Resolve selection evidence from authoritative OOXML package bytes."""

    def resolve_selection(self, payload: bytes, locator: Mapping[str, Any]) -> str:
        shape_name = _string(locator, "shape")
        matching = tuple(
            shape
            for shape in _slide(payload, locator).shapes
            if shape.name == shape_name and getattr(shape, "has_text_frame", False)
        )
        if len(matching) != 1:
            raise SlideSelectionError("shape")
        text = cast(Shape, matching[0]).text
        if "start" not in locator and "end" not in locator:
            return text
        return _utf16_slice(text, _integer(locator, "start"), _integer(locator, "end"))

    def resolve_context(
        self,
        payload: bytes,
        locator: Mapping[str, Any],
        selected: str,
        *,
        max_chars: int,
    ) -> str:
        text = "\n".join(
            cast(Shape, shape).text
            for shape in _slide(payload, locator).shapes
            if getattr(shape, "has_text_frame", False)
        )
        if len(text) <= max_chars:
            return text
        index = text.find(selected)
        if index < 0:
            return text[:max_chars]
        start = max(0, index - (max_chars - len(selected)) // 2)
        return text[start : start + max_chars]


__all__ = ["PptxSelectionProcessor"]
