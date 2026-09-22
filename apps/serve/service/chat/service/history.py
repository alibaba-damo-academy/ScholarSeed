"""Scoped product-message retrieval, independent of vendor history files."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import NotRequired, TypedDict

from scholarseed_runtime.contract.history import HistoryEntry
from service.chat.constants import SessionTitleFallback
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogRecord,
    SessionCatalogStore,
    SessionListScope,
    SessionPrincipal,
)
from service.chat.persistence.events import ProductEventStore
from service.platform.bridge import (
    HISTORY_LABEL_CHARS,
    HISTORY_PAGE_CHARS,
    HISTORY_SNIPPET_CHARS,
    HISTORY_TEXT_CHARS,
    HISTORY_UNTRUSTED_NOTICE,
    HistoryList,
    HistoryRead,
    HistorySearch,
)
from service.platform.content import ProjectRef
from service.platform.context import HistoryScope

ROLE_LABELS = {"user": "用户", "assistant": "AI"}
REVISION_PREFIX = "sha256:"
WORD_PATTERN = re.compile(r"[a-z0-9_]+|[\u4e00-\u9fff]+", re.IGNORECASE)
CJK_PATTERN = re.compile(r"^[\u4e00-\u9fff]+$")
PHRASE_WEIGHT = 10
CURSOR_FIELDS = 3


class HistoryError(ValueError):
    """Safe domain error suitable for a CLI response."""


class HistoryMessage(TypedDict):
    session_id: str
    message_id: str
    title: str
    role: str
    text: str
    source_revision: str
    text_offset: NotRequired[int]
    truncated: NotRequired[bool]


@dataclass(frozen=True)
class HistorySource:
    session_id: str
    title: str
    revision: str
    entries: tuple[HistoryEntry, ...]
    title_fallback: SessionTitleFallback | None = None


def content_revision(text: str) -> str:
    return REVISION_PREFIX + hashlib.sha256(text.encode()).hexdigest()


class HistoryService:
    def __init__(
        self,
        catalog: SessionCatalogStore,
        events: ProductEventStore,
        *,
        project_for_session: Callable[[str], ProjectRef | None] | None = None,
    ) -> None:
        self._catalog = catalog
        self._events = events
        self._project_for_session = project_for_session

    def _authorized_record(self, requester_id: str, target_id: str) -> SessionCatalogRecord:
        requester = self._catalog.get(requester_id)
        target = self._catalog.get(target_id)
        if requester is None or target is None:
            raise HistoryError("session_not_found")
        try:
            self._catalog.require(target_id, SessionPrincipal(requester.principal_id))
        except SessionAccessError as error:
            raise HistoryError("session_forbidden") from error
        requester_path = Path(requester.project_path).resolve() if requester.project_path else None
        target_path = Path(target.project_path).resolve() if target.project_path else None
        if requester_path != target_path:
            raise HistoryError("session_forbidden")
        return target

    def source(self, requester_id: str, target_id: str) -> HistorySource:
        target = self._authorized_record(requester_id, target_id)
        visible = self._events.portable_history(target_id)
        history = (
            self._events.portable_history(target_id, exclude_rejected=True)
            if visible
            else self._catalog.portable_history(target_id)
        )
        entries = tuple(
            entry for entry in history if entry.role in ROLE_LABELS and entry.text.strip()
        )
        canonical = "\n\n".join(f"[{ROLE_LABELS[e.role]}]\n{e.text.strip()}" for e in entries)
        return HistorySource(
            target_id, target.title, content_revision(canonical), entries, target.title_fallback
        )

    def _candidates(
        self, requester_id: str, scope: HistoryScope
    ) -> tuple[SessionCatalogRecord, ...]:
        if scope.unavailable:
            raise HistoryError("history_source_unavailable")
        project = None
        if scope.project_id:
            project = self._project_for_session(requester_id) if self._project_for_session else None
            if project is None or project.id != scope.project_id or not project.available:
                raise HistoryError("history_project_unavailable")
        if scope.refs:
            records = (
                self._authorized_record(requester_id, target)
                for target in dict.fromkeys(ref.source_id for ref in scope.refs)
                if target != requester_id
            )
            return tuple(
                sorted(records, key=lambda record: (-record.updated_at, record.session_id))
            )
        if project is None:
            return ()
        requester = self._catalog.get(requester_id)
        if requester is None:
            raise HistoryError("session_not_found")
        return self._catalog.listed(
            SessionPrincipal(requester.principal_id),
            runtime_id=None,
            scope=SessionListScope.PROJECT,
            project_path=project.root,
            limit=None,
            exclude_session_id=requester_id,
            created_before=scope.created_at,
        )

    def _list(
        self, scope: HistoryScope, records: tuple[SessionCatalogRecord, ...], request: HistoryList
    ) -> dict:
        rows = [
            {
                "session_id": record.session_id,
                "title": record.title[:HISTORY_LABEL_CHARS],
                "created_at": record.created_at,
                "updated_at": record.updated_at,
            }
            for record in records
        ]
        fingerprint = content_revision(json.dumps([scope.snapshot_id, rows], ensure_ascii=False))
        offset, text_offset = self._cursor(request.cursor, fingerprint)
        if offset > len(rows) or text_offset:
            raise HistoryError("history_cursor_invalid")
        page = rows[offset : offset + request.limit]
        offset += len(page)
        cursor = self._encode_cursor(fingerprint, offset, 0) if offset < len(rows) else ""
        return {
            "ok": True,
            "notice": HISTORY_UNTRUSTED_NOTICE,
            "sessions": page,
            "has_more": bool(cursor),
            "next_cursor": cursor,
        }

    @staticmethod
    def message_id(entry: HistoryEntry) -> str:
        identity = json.dumps([entry.role, entry.turn_id, entry.item_id], ensure_ascii=False)
        return hashlib.sha256(identity.encode()).hexdigest()

    def query(
        self,
        requester_id: str,
        scope: HistoryScope,
        request: HistoryList | HistorySearch | HistoryRead,
    ) -> dict:
        records = self._candidates(requester_id, scope)
        if isinstance(request, HistoryList):
            return self._list(scope, records, request)
        allowed = {record.session_id for record in records}
        revisions = {ref.source_id: ref.source_revision for ref in scope.refs}
        selected = (
            request.session_ids if isinstance(request, HistorySearch) else [request.session_id]
        )
        selected = (
            [record.session_id for record in records]
            if selected is None
            else list(dict.fromkeys(selected))
        )
        if any(target not in allowed for target in selected):
            raise HistoryError("history_scope_forbidden")
        sources = [self.source(requester_id, target) for target in selected]
        for source in sources:
            revision = revisions.get(source.session_id)
            if revision and revision != source.revision:
                raise HistoryError("source_revision_changed; start a new turn")
        rows: list[HistoryMessage] = []
        for source in sources:
            for entry in source.entries:
                rows.append(
                    {
                        "session_id": source.session_id,
                        "message_id": self.message_id(entry),
                        "title": source.title[:HISTORY_LABEL_CHARS],
                        "role": entry.role,
                        "text": entry.text,
                        "source_revision": source.revision,
                    }
                )
        if isinstance(request, HistorySearch):
            source_order = {source.session_id: index for index, source in enumerate(sources)}
            query = request.query.strip().casefold()
            if not query:
                raise HistoryError("history_query_empty")
            terms: set[str] = set()
            for word in WORD_PATTERN.findall(query):
                if CJK_PATTERN.match(word) and len(word) > 1:
                    terms.update(word[index : index + 2] for index in range(len(word) - 1))
                else:
                    terms.add(word)
            scored = []
            for position, row in enumerate(rows):
                text = row["text"].casefold()
                score = PHRASE_WEIGHT * (query in text) + sum(term in text for term in terms)
                if score:
                    # Match against the original text so Unicode case folding cannot
                    # shift source offsets (for example, a preceding ß becomes ss).
                    first = min(
                        (
                            match.start()
                            for term in terms
                            if (match := re.search(re.escape(term), row["text"], re.IGNORECASE))
                        ),
                        default=0,
                    )
                    snippet = row["text"][first : first + HISTORY_SNIPPET_CHARS]
                    row = {
                        **row,
                        "text": snippet,
                        "text_offset": first,
                        "truncated": first > 0 or len(snippet) < len(row["text"]),
                    }
                    scored.append((score, source_order[row["session_id"]], position, row))
            rows = [
                row
                for _, _, _, row in sorted(scored, key=lambda item: (-item[0], item[1], -item[2]))
            ]
        elif request.message_id:
            indices = [
                index for index, row in enumerate(rows) if row["message_id"] == request.message_id
            ]
            if not indices:
                raise HistoryError("history_message_missing")
            index = indices[0]
            rows = rows[max(0, index - request.before) : index + request.after + 1]
        else:
            if request.before or request.after:
                raise HistoryError("history_context_requires_message_id")
            if request.order == "desc":
                rows.reverse()
        fingerprint = content_revision(
            json.dumps(
                {
                    "snapshot_id": scope.snapshot_id,
                    "request": request.model_dump(exclude={"cursor", "limit"}),
                    "sources": [(source.session_id, source.revision) for source in sources],
                },
                sort_keys=True,
                ensure_ascii=False,
            )
        )
        offset, text_offset = self._cursor(request.cursor, fingerprint)
        if offset > len(rows) or (offset == len(rows) and text_offset):
            raise HistoryError("history_cursor_invalid")
        result: list[HistoryMessage] = []
        remaining = HISTORY_PAGE_CHARS
        while offset < len(rows) and len(result) < request.limit and remaining:
            row = rows[offset]
            text = row["text"]
            if text_offset > len(text):
                raise HistoryError("history_cursor_invalid")
            fragment = text[text_offset : text_offset + min(HISTORY_TEXT_CHARS, remaining)]
            remaining -= len(fragment)
            more = text_offset + len(fragment) < len(text)
            result.append(
                {
                    **row,
                    "text": fragment,
                    "text_offset": row.get("text_offset", 0) + text_offset,
                    "truncated": bool(row.get("truncated")) or text_offset > 0 or more,
                }
            )
            if more:
                text_offset += len(fragment)
                break
            offset += 1
            text_offset = 0
        cursor = ""
        if offset < len(rows):
            cursor = self._encode_cursor(fingerprint, offset, text_offset)
        return {
            "ok": True,
            "notice": HISTORY_UNTRUSTED_NOTICE,
            "session_ids": list(dict.fromkeys(row["session_id"] for row in result)),
            "messages": result,
            "next_cursor": cursor,
            "has_more": bool(cursor),
        }

    @staticmethod
    def _encode_cursor(fingerprint: str, offset: int, text_offset: int) -> str:
        return base64.urlsafe_b64encode(
            json.dumps([fingerprint, offset, text_offset]).encode()
        ).decode()

    @staticmethod
    def _cursor(cursor: str, fingerprint: str) -> tuple[int, int]:
        if not cursor:
            return 0, 0
        try:
            values = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
            if not isinstance(values, list) or len(values) != CURSOR_FIELDS:
                raise ValueError
            revision, offset, text_offset = values
            if revision != fingerprint or any(
                type(value) is not int or value < 0 for value in (offset, text_offset)
            ):
                raise ValueError
            return offset, text_offset
        except (ValueError, TypeError, binascii.Error) as error:
            raise HistoryError("history_cursor_invalid_or_stale") from error
