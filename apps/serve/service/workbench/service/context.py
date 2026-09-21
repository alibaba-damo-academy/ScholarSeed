"""Resolve Workbench selection anchors against immutable Content bytes.

Viewer-provided preview text is presentation data only. This provider reopens the
project-relative source and resolves the native tagged locator. A changed source revision
may be rebound only when the authoritative selected text still has the declared digest.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from io import BytesIO
from pathlib import PurePosixPath
from typing import Any
from zipfile import BadZipFile

from openpyxl.utils.cell import get_column_letter, range_boundaries
from openpyxl.xml.constants import MAX_COLUMN, MAX_ROW

from service.content.domain.model import ContentError
from service.content.service.port import REVISION_PREFIX, ContentService
from service.content.service.spreadsheet import (
    MAXIMUM_SPREADSHEET_RANGE_CHARS,
    SpreadsheetRangeError,
    SpreadsheetRangeTooLarge,
    read_spreadsheet_range,
)
from service.platform.context import (
    AssistantContextIssue,
    AssistantContextResolution,
    AssistantContextResolvedItem,
    AssistantContextResolveRequest,
    ContextItemRole,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
)
from service.platform.pdf import (
    PdfSelectionError,
    pdf_document_info,
    pdf_page_layout,
    pdf_selection_matches,
    resolve_pdf_selection,
)
from service.workbench.domain.model import capabilities_for
from service.workbench.domain.selection import (
    CALC_REFERENCE_RESOLVED_STATUS,
    REFERENCE_CONTENT_MODE,
    REFERENCE_CONTENT_MODE_KEY,
    SelectionDraftEvidence,
    SelectionEvidenceError,
    SelectionEvidenceMode,
    SelectionEvidenceReference,
    VerifiedSelectionEvidence,
    calc_reference_descriptor,
    is_calc_reference,
)
from service.workbench.domain.slides import (
    IMPRESS_LOCATOR_KIND,
    SlideSelectionError,
    SlideSnapshotRequired,
)
from service.workbench.service import doc as doc_selection
from service.workbench.service import docx as docx_selection
from service.workbench.service.slides import slide_processor_for

PROVIDER_VERSION = "workbench.selection/v2"
SUPPORTED_KIND = ContextRefKind.SELECTION
LOCATOR_TEXT = "text"
LOCATOR_MARKDOWN = "markdown"
LOCATOR_PDF = "pdf"
LOCATOR_WRITER = "writer"
LOCATOR_CALC = "calc"
LOCATOR_IMPRESS = IMPRESS_LOCATOR_KIND
SUPPORTED_LOCATORS = frozenset(
    (
        LOCATOR_TEXT,
        LOCATOR_MARKDOWN,
        LOCATOR_PDF,
        LOCATOR_WRITER,
        LOCATOR_CALC,
        LOCATOR_IMPRESS,
    )
)
DRAFT_LOCATORS = frozenset((LOCATOR_TEXT, LOCATOR_MARKDOWN, LOCATOR_WRITER))
UTF8_ENCODING = "utf-8"
SELECTION_HASH_PREFIX = REVISION_PREFIX
WRITER_PROCESSORS = {
    doc_selection.SUFFIX: doc_selection,
    docx_selection.SUFFIX: docx_selection,
}
MAXIMUM_SELECTED_CELLS = 150
MAXIMUM_MARKDOWN_SEGMENTS = 64
MAXIMUM_ACTION_CONTEXT_CHARS = MAXIMUM_SPREADSHEET_RANGE_CHARS
CONTEXT_SURROUNDING_ROWS = 20
CONTEXT_SURROUNDING_COLUMNS = 8
REASON_PROJECT_UNAVAILABLE = "session_project_unavailable"
REASON_SOURCE_MISSING = "source_missing"
REASON_SOURCE_FORBIDDEN = "source_forbidden"
REASON_SOURCE_UNSUPPORTED = "source_type_unsupported"
REASON_SOURCE_UNAVAILABLE = "source_unavailable"
REASON_SOURCE_STALE = "source_revision_changed"
REASON_SELECTION_STALE = "selection_text_changed"
REASON_LOCATOR_INVALID = "selection_locator_invalid"
REFERENCE_SEPARATOR = " · "


class SelectionLocatorError(ValueError):
    """The stable locator cannot be resolved against its declared source type."""


def _digest(payload: bytes) -> str:
    return f"{SELECTION_HASH_PREFIX}{hashlib.sha256(payload).hexdigest()}"


def _text_digest(text: str) -> str:
    return _digest(text.encode(UTF8_ENCODING))


def _selection_matches(
    locator_kind: str,
    locator: Mapping[str, Any],
    selected: str,
    expected_hash: str,
) -> bool:
    if locator_kind == LOCATOR_PDF:
        return pdf_selection_matches(selected, locator, expected_hash)
    return _text_digest(selected) == expected_hash


def _integer(locator: Mapping[str, Any], key: str) -> int:
    value = locator.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SelectionLocatorError(key)
    return value


def _string(locator: Mapping[str, Any], key: str) -> str:
    value = locator.get(key)
    if not isinstance(value, str) or not value:
        raise SelectionLocatorError(key)
    return value


def _utf16_slice(text: str, start: int, end: int) -> str:
    if start < 0 or end < start:
        raise SelectionLocatorError("utf16_range")
    encoded = text.encode("utf-16-le")
    start_byte = start * 2
    end_byte = end * 2
    if end_byte > len(encoded):
        raise SelectionLocatorError("utf16_range")
    try:
        return encoded[start_byte:end_byte].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise SelectionLocatorError("utf16_boundary") from exc


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _line_utf16_offset(text: str, line_number: int, column: int) -> int:
    if line_number < 0 or column < 0:
        raise SelectionLocatorError("text_position")
    lines = text.splitlines(keepends=True)
    if text.endswith(("\n", "\r")):
        lines.append("")
    if not lines:
        lines = [""]
    if line_number >= len(lines):
        raise SelectionLocatorError("text_position")
    line = lines[line_number]
    content = line.rstrip("\r\n")
    if column > len(content.encode("utf-16-le")) // 2:
        raise SelectionLocatorError("text_position")
    prefix_units = len("".join(lines[:line_number]).encode("utf-16-le")) // 2
    return prefix_units + column


def _text_selection(payload: bytes, locator: Mapping[str, Any]) -> str:
    try:
        text = payload.decode(UTF8_ENCODING)
    except UnicodeDecodeError as exc:
        raise SelectionLocatorError("text_encoding") from exc
    start = _line_utf16_offset(
        text,
        _integer(locator, "start_line"),
        _integer(locator, "start_column"),
    )
    end = _line_utf16_offset(
        text,
        _integer(locator, "end_line"),
        _integer(locator, "end_column"),
    )
    return _utf16_slice(text, start, end)


def _markdown_selection(payload: bytes, locator: Mapping[str, Any]) -> str:
    try:
        text = payload.decode(UTF8_ENCODING)
    except UnicodeDecodeError as exc:
        raise SelectionLocatorError("markdown_encoding") from exc
    start = _integer(locator, "start")
    end = _integer(locator, "end")
    segments = locator.get("segments")
    if segments is None:
        return _utf16_slice(text, start, end)
    if not isinstance(segments, list) or not 1 <= len(segments) <= MAXIMUM_MARKDOWN_SEGMENTS:
        raise SelectionLocatorError("markdown_segments")
    selected: list[str] = []
    previous_end = start
    for segment in segments:
        if not isinstance(segment, Mapping):
            raise SelectionLocatorError("markdown_segments")
        segment_start = _integer(segment, "start")
        segment_end = _integer(segment, "end")
        if segment_start < previous_end or segment_end <= segment_start or segment_end > end:
            raise SelectionLocatorError("markdown_segments")
        selected.append(_utf16_slice(text, segment_start, segment_end))
        previous_end = segment_end
    return "".join(selected)


def _writer_processor(source_id: str, locator: Mapping[str, Any]):
    processor = WRITER_PROCESSORS.get(PurePosixPath(source_id).suffix.lower())
    declared_format = locator.get("format")
    if processor is None or (declared_format is not None and declared_format != processor.FORMAT):
        raise SelectionLocatorError("writer_format")
    return processor


def _writer_selection(payload: bytes, source_id: str, locator: Mapping[str, Any]) -> str:
    processor = _writer_processor(source_id, locator)
    try:
        return processor.resolve_selection(payload, locator)
    except (doc_selection.DocSelectionError, docx_selection.DocxSelectionError) as exc:
        raise SelectionLocatorError(str(exc)) from exc


def _calc_boundaries(selected_range: str) -> tuple[int, int, int, int]:
    minimum_column, minimum_row, maximum_column, maximum_row = range_boundaries(selected_range)
    if (
        minimum_column is None
        or minimum_row is None
        or maximum_column is None
        or maximum_row is None
    ):
        raise SelectionLocatorError("calc_range")
    return minimum_column, minimum_row, maximum_column, maximum_row


def _calc_reference_text(source_id: str, locator: Mapping[str, Any]) -> str | None:
    if locator.get(REFERENCE_CONTENT_MODE_KEY) != REFERENCE_CONTENT_MODE:
        return None
    if not is_calc_reference(locator):
        raise SelectionLocatorError("calc_reference_kind")
    sheet_name = _string(locator, "sheet")
    selected_range = _string(locator, "range")
    minimum_column, minimum_row, maximum_column, maximum_row = range_boundaries(selected_range)
    minimum_column = minimum_column or 1
    minimum_row = minimum_row or 1
    maximum_column = maximum_column or MAX_COLUMN
    maximum_row = maximum_row or MAX_ROW
    cell_count = (maximum_column - minimum_column + 1) * (maximum_row - minimum_row + 1)
    if cell_count <= MAXIMUM_SELECTED_CELLS:
        raise SelectionLocatorError("calc_reference_range")
    filename = PurePosixPath(source_id).name
    if not filename:
        raise SelectionLocatorError("calc_reference_source")
    return f"{filename}{REFERENCE_SEPARATOR}{sheet_name}!{selected_range}"


def _calc_selection(payload: bytes, source_id: str, locator: Mapping[str, Any]) -> str:
    try:
        return read_spreadsheet_range(
            source_id,
            payload,
            _string(locator, "sheet"),
            _string(locator, "range"),
            max_chars=MAXIMUM_ACTION_CONTEXT_CHARS,
        ).text
    except SpreadsheetRangeTooLarge:
        raise
    except SpreadsheetRangeError as exc:
        raise SelectionLocatorError("calc_document") from exc


def _bounded_context(text: str, selected: str) -> str:
    if len(text) <= MAXIMUM_ACTION_CONTEXT_CHARS:
        return text
    index = text.find(selected)
    if index < 0:
        return text[:MAXIMUM_ACTION_CONTEXT_CHARS]
    start = max(0, index - (MAXIMUM_ACTION_CONTEXT_CHARS - len(selected)) // 2)
    return text[start : start + MAXIMUM_ACTION_CONTEXT_CHARS]


def _action_context(
    payload: bytes,
    source_id: str,
    locator_kind: str,
    locator: Mapping[str, Any],
    selected: str,
) -> str:
    if locator_kind in (LOCATOR_TEXT, LOCATOR_MARKDOWN):
        return _bounded_context(payload.decode(UTF8_ENCODING), selected)
    if locator_kind == LOCATOR_PDF:
        page_number = _integer(locator, "page")
        if page_number < 1 or page_number > pdf_document_info(payload).page_count:
            raise SelectionLocatorError("pdf_page")
        return _bounded_context(pdf_page_layout(payload, page_number).text, selected)
    if locator_kind == LOCATOR_WRITER:
        processor = _writer_processor(source_id, locator)
        try:
            return processor.resolve_context(payload, locator, selected)
        except (doc_selection.DocSelectionError, docx_selection.DocxSelectionError) as exc:
            raise SelectionLocatorError(str(exc)) from exc
    if locator_kind == LOCATOR_CALC:
        min_col, min_row, max_col, max_row = _calc_boundaries(_string(locator, "range"))
        surrounding_range = (
            f"{get_column_letter(max(1, min_col - CONTEXT_SURROUNDING_COLUMNS))}"
            f"{max(1, min_row - CONTEXT_SURROUNDING_ROWS)}:"
            f"{get_column_letter(max_col + CONTEXT_SURROUNDING_COLUMNS)}"
            f"{max_row + CONTEXT_SURROUNDING_ROWS}"
        )
        try:
            content = read_spreadsheet_range(
                source_id,
                payload,
                _string(locator, "sheet"),
                surrounding_range,
                max_chars=MAXIMUM_ACTION_CONTEXT_CHARS,
            )
        except SpreadsheetRangeTooLarge:
            return selected
        except SpreadsheetRangeError as exc:
            raise SelectionLocatorError("calc_document") from exc
        return _bounded_context(content.text, selected)
    if locator_kind == LOCATOR_IMPRESS:
        return slide_processor_for(source_id).resolve_context(
            payload,
            locator,
            selected,
            max_chars=MAXIMUM_ACTION_CONTEXT_CHARS,
        )
    raise SelectionLocatorError("locator_kind")


class SelectionContextProvider:
    """Assistant provider for exact Workbench selections in project Content."""

    def __init__(
        self,
        content: ContentService,
        revision_reader: Callable[[str, str, str], bytes | None] | None = None,
    ) -> None:
        self._content = content
        self._revision_reader = revision_reader

    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution:
        ref = request.ref
        if ref.kind is not SUPPORTED_KIND or ref.anchor is None:
            return self._item(ref, ContextResolutionState.UNSUPPORTED, REASON_SOURCE_UNSUPPORTED)
        if not request.project_id:
            return self._item(ref, ContextResolutionState.UNAVAILABLE, REASON_PROJECT_UNAVAILABLE)
        anchor = ref.anchor
        locator = anchor.locator
        try:
            reference_text = _calc_reference_text(ref.source_id, locator)
        except SelectionLocatorError:
            return self._item(ref, ContextResolutionState.UNSUPPORTED, REASON_LOCATOR_INVALID)
        if reference_text is not None and not ref.source_revision:
            return self._item(ref, ContextResolutionState.STALE, REASON_SOURCE_STALE)
        if reference_text is not None and not _selection_matches(
            LOCATOR_CALC, locator, reference_text, anchor.selected_text_hash
        ):
            return self._item(ref, ContextResolutionState.STALE, REASON_SELECTION_STALE)
        try:
            payload, _media_type = self._content.read_bytes(request.project_id, ref.source_id)
        except ContentError as exc:
            state, reason = self._content_failure(exc)
            return self._item(ref, state, reason)
        except OSError:
            return self._item(ref, ContextResolutionState.UNAVAILABLE, REASON_SOURCE_UNAVAILABLE)

        revision = _digest(payload)
        if not ref.source_revision:
            return self._item(ref, ContextResolutionState.STALE, REASON_SOURCE_STALE)
        if reference_text is not None and revision != ref.source_revision:
            return self._item(ref, ContextResolutionState.STALE, REASON_SOURCE_STALE)
        locator_kind = locator.get("kind") if isinstance(locator, Mapping) else None
        if not isinstance(locator_kind, str) or locator_kind not in SUPPORTED_LOCATORS:
            return self._item(ref, ContextResolutionState.UNSUPPORTED, REASON_LOCATOR_INVALID)
        resolved_range = ""
        try:
            if reference_text is not None:
                spreadsheet_content = read_spreadsheet_range(
                    ref.source_id,
                    payload,
                    _string(locator, "sheet"),
                    _string(locator, "range"),
                    max_chars=MAXIMUM_ACTION_CONTEXT_CHARS,
                )
                selected = spreadsheet_content.text
                resolved_range = spreadsheet_content.selected_range
            else:
                selected = self._resolve(
                    payload,
                    ref.source_id,
                    locator_kind,
                    locator,
                    anchor.selected_text_hash,
                )
        except SpreadsheetRangeTooLarge:
            return self._item(ref, ContextResolutionState.TOO_LARGE, "selection_budget_exceeded")
        except SpreadsheetRangeError:
            return self._item(ref, ContextResolutionState.UNSUPPORTED, REASON_LOCATOR_INVALID)
        except (SelectionLocatorError, SlideSelectionError):
            return self._item(ref, ContextResolutionState.UNSUPPORTED, REASON_LOCATOR_INVALID)
        if not selected or (
            reference_text is None
            and not _selection_matches(
                locator_kind,
                locator,
                selected,
                anchor.selected_text_hash,
            )
        ):
            return self._item(ref, ContextResolutionState.STALE, REASON_SELECTION_STALE)
        if request.budget.max_items < 1 or len(selected) > request.budget.max_chars:
            return self._item(ref, ContextResolutionState.TOO_LARGE, "selection_budget_exceeded")
        return AssistantContextResolution(
            state=ContextResolutionState.READY,
            provider_version=PROVIDER_VERSION,
            source_revision=revision,
            items=(
                AssistantContextResolvedItem(
                    item_id=ref.ref_id,
                    source_id=ref.source_id,
                    label=ref.label,
                    selection_source_label=ref.selection_source_label,
                    source_revision=revision,
                    text=selected,
                    role=ContextItemRole.MATERIAL,
                    model_locator=(
                        json.dumps(
                            calc_reference_descriptor(
                                ref.source_id,
                                _string(locator, "sheet"),
                                resolved_range,
                                content_status=CALC_REFERENCE_RESOLVED_STATUS,
                            ),
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        if reference_text is not None
                        else ""
                    ),
                    anchor=anchor,
                    content_hash=_text_digest(selected),
                    media_type=_media_type,
                ),
            ),
        )

    def resolve_action(
        self,
        reference: SelectionEvidenceReference,
        draft: SelectionDraftEvidence | None = None,
    ) -> VerifiedSelectionEvidence:
        """Resolve selection actions through the same authoritative locator implementation."""

        try:
            reference_text = _calc_reference_text(reference.source_id, reference.locator)
        except SelectionLocatorError as exc:
            raise SelectionEvidenceError("selection_unsupported") from exc
        if reference_text is not None and (
            draft is not None
            or reference.locator_kind != LOCATOR_CALC
            or not reference.source_revision
        ):
            raise SelectionEvidenceError("selection_unsupported")
        if reference_text is not None and not _selection_matches(
            LOCATOR_CALC,
            reference.locator,
            reference_text,
            reference.selected_text_hash,
        ):
            raise SelectionEvidenceError("selection_stale")

        try:
            payload, _media_type = self._content.read_bytes(
                reference.project_id,
                reference.source_id,
            )
        except ContentError as exc:
            state, _reason = self._content_failure(exc)
            code = {
                ContextResolutionState.MISSING: "selection_missing",
                ContextResolutionState.FORBIDDEN: "selection_forbidden",
                ContextResolutionState.UNSUPPORTED: "selection_unsupported",
            }.get(state, "selection_unavailable")
            raise SelectionEvidenceError(code) from exc
        revision = _digest(payload)
        if reference_text is not None and revision != reference.source_revision:
            raise SelectionEvidenceError("selection_stale")
        if revision != reference.source_revision:
            historical = (
                self._revision_reader(
                    reference.project_id,
                    reference.source_id,
                    reference.source_revision,
                )
                if self._revision_reader is not None and reference.locator_kind == LOCATOR_PDF
                else None
            )
            if historical is None or _digest(historical) != reference.source_revision:
                raise SelectionEvidenceError("selection_stale")
            payload = historical
            revision = reference.source_revision
        locator_kind = reference.locator.get("kind")
        if locator_kind != reference.locator_kind or locator_kind not in SUPPORTED_LOCATORS:
            raise SelectionEvidenceError("selection_unsupported")
        if draft is not None:
            if locator_kind not in DRAFT_LOCATORS:
                raise SelectionEvidenceError("selection_unsupported")
            if (
                draft.change_version < 1
                or draft.selected_text_hash != reference.selected_text_hash
                or _text_digest(draft.selected_text) != reference.selected_text_hash
                or not draft.selected_text
                or draft.selected_text not in draft.context_text
            ):
                raise SelectionEvidenceError("selection_stale")
            return VerifiedSelectionEvidence(
                reference=reference,
                selected_text=draft.selected_text,
                context_text=draft.context_text,
                evidence_revision=revision,
                mode=SelectionEvidenceMode.DRAFT,
                change_version=draft.change_version,
                can_edit=capabilities_for(reference.source_id, payload).can_edit,
            )
        try:
            if reference_text is not None:
                spreadsheet_content = read_spreadsheet_range(
                    reference.source_id,
                    payload,
                    _string(reference.locator, "sheet"),
                    _string(reference.locator, "range"),
                    max_chars=MAXIMUM_ACTION_CONTEXT_CHARS,
                )
                selected = spreadsheet_content.text
                context_text = selected
                resolved_locator = {
                    **reference.locator,
                    "range": spreadsheet_content.selected_range,
                }
                resolved_reference = SelectionEvidenceReference(
                    project_id=reference.project_id,
                    source_id=reference.source_id,
                    source_revision=reference.source_revision,
                    locator_kind=reference.locator_kind,
                    selected_text_hash=reference.selected_text_hash,
                    locator=resolved_locator,
                )
            else:
                selected = self._resolve(
                    payload,
                    reference.source_id,
                    reference.locator_kind,
                    reference.locator,
                    reference.selected_text_hash,
                )
                context_text = _action_context(
                    payload,
                    reference.source_id,
                    reference.locator_kind,
                    reference.locator,
                    selected,
                )
                resolved_reference = reference
        except SpreadsheetRangeTooLarge as exc:
            raise SelectionEvidenceError("selection_too_large") from exc
        except SpreadsheetRangeError as exc:
            raise SelectionEvidenceError("selection_unsupported") from exc
        except SlideSnapshotRequired as exc:
            raise SelectionEvidenceError("selection_snapshot_required") from exc
        except (KeyError, SelectionLocatorError, SlideSelectionError, UnicodeDecodeError) as exc:
            raise SelectionEvidenceError("selection_unsupported") from exc
        if not selected or (
            reference_text is None
            and not _selection_matches(
                reference.locator_kind,
                reference.locator,
                selected,
                reference.selected_text_hash,
            )
        ):
            raise SelectionEvidenceError("selection_stale")
        return VerifiedSelectionEvidence(
            reference=resolved_reference,
            selected_text=selected,
            context_text=context_text,
            evidence_revision=revision,
            can_edit=(
                False
                if reference_text is not None
                else capabilities_for(reference.source_id, payload).can_edit
            ),
        )

    @staticmethod
    def _resolve(
        payload: bytes,
        source_id: str,
        locator_kind: str,
        locator: Mapping[str, Any],
        expected_hash: str,
    ) -> str:
        if locator_kind == LOCATOR_TEXT:
            return _text_selection(payload, locator)
        if locator_kind == LOCATOR_MARKDOWN:
            return _markdown_selection(payload, locator)
        if locator_kind == LOCATOR_PDF:
            try:
                return resolve_pdf_selection(payload, locator, expected_hash)
            except PdfSelectionError as exc:
                raise SelectionLocatorError(str(exc)) from exc
        if locator_kind == LOCATOR_WRITER:
            return _writer_selection(payload, source_id, locator)
        if locator_kind == LOCATOR_CALC:
            return _calc_selection(payload, source_id, locator)
        if locator_kind == LOCATOR_IMPRESS:
            return slide_processor_for(source_id).resolve_selection(payload, locator)
        raise SelectionLocatorError("locator_kind")

    @staticmethod
    def _item(
        ref: ContextRef,
        state: ContextResolutionState,
        reason: str,
    ) -> AssistantContextResolution:
        return AssistantContextResolution(
            state=state,
            provider_version=PROVIDER_VERSION,
            source_revision=ref.source_revision or "",
            issues=(AssistantContextIssue(code=reason),),
        )

    @staticmethod
    def _content_failure(exc: ContentError) -> tuple[ContextResolutionState, str]:
        reason = str(exc)
        if reason in ("file_not_found", "unknown_project"):
            return ContextResolutionState.MISSING, REASON_SOURCE_MISSING
        if reason in ("path_outside_project", "path_not_authorized"):
            return ContextResolutionState.FORBIDDEN, REASON_SOURCE_FORBIDDEN
        if reason in ("not_text_file", REASON_SOURCE_UNSUPPORTED):
            return ContextResolutionState.UNSUPPORTED, REASON_SOURCE_UNSUPPORTED
        return ContextResolutionState.UNAVAILABLE, reason or REASON_SOURCE_UNAVAILABLE


__all__ = ["SelectionContextProvider"]
