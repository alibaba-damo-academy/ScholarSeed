"""Bounded display-only projection of selected structured-generation string fields."""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from scholarseed_runtime.contract import RuntimeEvent, RuntimeEventKind
from service.platform.inference import ModelInvocationEvent, ModelInvocationEventKind

PREVIEW_MAX_FIELDS = 16
PREVIEW_MAX_DEPTH = 16
PREVIEW_MAX_INPUT_CHARS = 262_144
PREVIEW_MAX_TEXT_CHARS = 32_768
PREVIEW_MAX_BLOCKS = 128
PREVIEW_REFRESH_SECONDS = 0.2
LOGGER = logging.getLogger(__name__)


class PreviewStatus(str, Enum):
    STREAMING = "streaming"
    GENERATED = "generated"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


class PreviewField(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    path: list[str] = Field(min_length=1, max_length=PREVIEW_MAX_DEPTH)
    kind: Literal["heading1", "heading2", "paragraph"]


class HiddenMarker(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    start: str = Field(min_length=1, max_length=64)
    end: str = Field(min_length=1, max_length=64)
    alternative_starts: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(
        default_factory=list, max_length=5
    )


class PreviewFields(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    format: Literal["markdown_fields", "markdown"]
    fields: list[PreviewField] = Field(default_factory=list, max_length=PREVIEW_MAX_FIELDS)
    hidden_marker: HiddenMarker | None = None


class MarkdownProjection:
    def __init__(self, spec: PreviewFields):
        if spec.fields:
            raise ValueError("markdown_preview_has_no_field_paths")
        self.input = ""
        self.marker = spec.hidden_marker

    def feed(self, chunk: str):
        self.input += chunk
        if len(self.input) > PREVIEW_MAX_INPUT_CHARS:
            raise ValueError("preview_input_limit")
        text = self.input
        if self.marker is not None:
            starts, end = (self.marker.start, *self.marker.alternative_starts), self.marker.end
            pieces, position = [], 0
            while True:
                openings = [(text.find(start, position), start) for start in starts]
                opening, start = min(
                    (item for item in openings if item[0] >= 0),
                    default=(-1, ""),
                    key=lambda item: item[0],
                )
                if opening < 0:
                    tail = text[position:]
                    for length in range(min(max(map(len, starts)) - 1, len(tail)), 0, -1):
                        if any(
                            length < len(marker) and tail.endswith(marker[:length])
                            for marker in starts
                        ):
                            tail = tail[:-length]
                            break
                    pieces.append(tail)
                    break
                pieces.append(text[position:opening])
                closing = text.find(end, opening + len(start))
                if closing < 0:
                    break
                position = closing + len(end)
            text = "".join(pieces)
        if len(text) > PREVIEW_MAX_TEXT_CHARS:
            raise ValueError("preview_output_limit")
        return [{"id": "/markdown", "kind": "paragraph", "text": text}] if text.strip() else []


class IncompletePreview(ValueError):
    """The selected string or its containing JSON has not arrived yet."""


class PreviewProjection:
    def __init__(self, fields: PreviewFields, schema: Mapping):
        if not fields.fields:
            raise ValueError("preview_fields_required")
        self.fields = fields
        self.input = ""
        self.kinds: dict[tuple[str, ...], str] = {}
        self.order: dict[tuple[str, ...], dict[str, int]] = {}
        for field in fields.fields:
            node = schema
            prefix: tuple[str, ...] = ()
            for segment in field.path:
                if not segment or len(segment) > 128:
                    raise ValueError("preview_path_invalid")
                if segment == "*":
                    if node.get("type") != "array" or not isinstance(node.get("items"), Mapping):
                        raise ValueError("preview_wildcard_requires_array")
                    node = node["items"]
                else:
                    properties = node.get("properties")
                    if (
                        node.get("type") != "object"
                        or not isinstance(properties, Mapping)
                        or segment not in properties
                    ):
                        raise ValueError("preview_path_unknown")
                    node = properties[segment]
                ranks = self.order.setdefault(prefix, {})
                ranks.setdefault(segment, len(ranks))
                prefix += (segment,)
            if node.get("type") != "string" or prefix in self.kinds:
                raise ValueError("preview_requires_distinct_string_leaf")
            self.kinds[prefix] = field.kind

    def _kind(self, path):
        return self.kinds.get(tuple("*" if isinstance(part, int) else part for part in path))

    def _rank(self, path):
        result, prefix = [], ()
        for part in path:
            segment = "*" if isinstance(part, int) else part
            result.append(part if isinstance(part, int) else self.order[prefix][segment])
            prefix += (segment,)
        return tuple(result)

    def feed(self, chunk: str) -> list[dict]:
        self.input += chunk
        if len(self.input) > PREVIEW_MAX_INPUT_CHARS:
            raise ValueError("preview_input_limit")
        source = self.input.lstrip()
        if source.startswith("`"):
            match = re.match(r"```json[ \t]*\r?\n", source)
            if match is None:
                if (
                    "```json\n".startswith(source)
                    or "```json\r\n".startswith(source)
                    or re.fullmatch(r"```json[ \t]*\r?", source)
                ):
                    return []
                raise ValueError("preview_fence_invalid")
            source = source[match.end() :]
        position, found = 0, {}
        decoder = json.JSONDecoder()

        def whitespace():
            nonlocal position
            while position < len(source) and source[position].isspace():
                position += 1

        def take(char):
            nonlocal position
            whitespace()
            if position == len(source):
                raise IncompletePreview
            if source[position] != char:
                raise ValueError("preview_json_structure")
            position += 1

        def string(selected=False):
            nonlocal position
            if position == len(source):
                raise IncompletePreview
            if source[position] != '"':
                raise ValueError("preview_string_required")
            start = position
            if not selected:
                try:
                    value, position = decoder.raw_decode(source, position)
                except json.JSONDecodeError as error:
                    if error.msg.startswith("Unterminated") or error.pos >= len(source) - 5:
                        raise IncompletePreview from error
                    raise ValueError("preview_invalid_string") from error
                return value
            position += 1
            encoded = ['"']
            while position < len(source):
                char = source[position]
                if char == "\\":
                    if position + 1 >= len(source):
                        raise IncompletePreview
                    encoded.append(source[position : position + 2])
                    position += 2
                    continue
                if char == '"':
                    following = position + 1
                    while following < len(source) and source[following].isspace():
                        following += 1
                    if following == len(source):
                        raise IncompletePreview
                    if source[following] in ",}]":
                        encoded.append(char)
                        position += 1
                        value = json.loads("".join(encoded))
                        value.encode("utf-8")
                        return value
                    if source[following] == ":" or (
                        following > position + 1 and source[following] == '"'
                    ):
                        raise ValueError("preview_ambiguous_quote")
                    encoded.append("\\")
                encoded.append(char)
                position += 1
            raise IncompletePreview

        def value(path=(), depth=0):
            nonlocal position
            if depth > PREVIEW_MAX_DEPTH:
                raise ValueError("preview_depth_limit")
            whitespace()
            if position == len(source):
                raise IncompletePreview
            char = source[position]
            if char == "{":
                take("{")
                whitespace()
                if position < len(source) and source[position] == "}":
                    take("}")
                    return
                keys = set()
                while True:
                    whitespace()
                    key = string()
                    if key in keys:
                        raise ValueError("preview_duplicate_key")
                    keys.add(key)
                    take(":")
                    value(path + (key,), depth + 1)
                    whitespace()
                    if position < len(source) and source[position] == "}":
                        take("}")
                        return
                    take(",")
            elif char == "[":
                take("[")
                whitespace()
                if position < len(source) and source[position] == "]":
                    take("]")
                    return
                index = 0
                while True:
                    value(path + (index,), depth + 1)
                    index += 1
                    whitespace()
                    if position < len(source) and source[position] == "]":
                        take("]")
                        return
                    take(",")
            elif char == '"':
                kind = self._kind(path)
                text = string(bool(kind))
                if kind and text.strip():
                    found[path] = {
                        "id": "/"
                        + "/".join(str(p).replace("~", "~0").replace("/", "~1") for p in path),
                        "kind": kind,
                        "text": text,
                    }
                    if (
                        len(found) > PREVIEW_MAX_BLOCKS
                        or sum(len(b["text"]) for b in found.values()) > PREVIEW_MAX_TEXT_CHARS
                    ):
                        raise ValueError("preview_output_limit")
            else:
                try:
                    _, position = decoder.raw_decode(source, position)
                except json.JSONDecodeError as error:
                    raise IncompletePreview from error

        try:
            value()
            whitespace()
            if position < len(source) and source[position:].strip() not in ("`", "``", "```"):
                raise ValueError("preview_trailing_content")
        except IncompletePreview:
            pass
        return [found[path] for path in sorted(found, key=self._rank)]


class GenerationPreview:
    """One invocation's best-effort display stream; never validates or edits output."""

    def __init__(
        self,
        identity: str,
        spec: PreviewFields | None,
        schema: Mapping | None,
        publish: Callable[[dict], Awaitable[None]],
        current: Callable[[], bool],
    ):
        self.identity, self.spec, self.schema = identity, spec, schema
        self.publish, self.current = publish, current
        self.blocks: list[dict] = []
        self.revision = 0
        self.item_id, self.disabled = "", False
        self.projection: MarkdownProjection | PreviewProjection | None = None
        self.last_emit = 0.0
        self.raw = ""
        try:
            if spec is None:
                raise ValueError("preview_configuration_invalid")
            self.make_projection()
        except (ValueError, TypeError, KeyError):
            self.disabled = True

    def make_projection(self):
        if self.spec is None:
            raise ValueError("preview_configuration_invalid")
        if self.spec.format == "markdown":
            return MarkdownProjection(self.spec)
        if self.schema is None:
            raise ValueError("preview_configuration_invalid")
        return PreviewProjection(self.spec, self.schema)

    async def emit(self, status: PreviewStatus):
        self.revision += 1
        try:
            await self.publish(
                {
                    "preview_id": self.identity,
                    "revision": self.revision,
                    "status": status.value,
                    "blocks": list(self.blocks),
                    "verified": False,
                }
            )
        except Exception as error:
            self.disabled = True
            LOGGER.warning(
                "generation_preview_publication_failed invocation_id=%s failure_type=%s",
                self.identity,
                type(error).__name__,
            )

    async def observe(self, observation):
        if isinstance(observation, ModelInvocationEvent):
            if observation.kind not in (
                ModelInvocationEventKind.OUTPUT_DELTA,
                ModelInvocationEventKind.OUTPUT_COMPLETED,
            ):
                return
            await self.project(
                observation.item_id,
                observation.text,
                observation.kind is ModelInvocationEventKind.OUTPUT_COMPLETED,
            )
            return
        if self.disabled or not self.current() or not isinstance(observation, RuntimeEvent):
            return
        payload = observation.payload if isinstance(observation.payload, Mapping) else {}
        if (
            observation.kind
            not in (RuntimeEventKind.CONTENT_DELTA, RuntimeEventKind.CONTENT_COMPLETED)
            or payload.get("role") != "assistant"
            or payload.get("phase", "") not in (None, "", "final_answer")
        ):
            return
        await self.project(
            observation.native_item_id,
            payload.get("text") or payload.get("delta") or "",
            observation.kind is RuntimeEventKind.CONTENT_COMPLETED,
        )

    async def project(self, item_id: str, text: object, completed: bool):
        if self.disabled or not self.current():
            return
        try:
            if not isinstance(text, str):
                raise TypeError("preview_text_invalid")
            changed_item = item_id != self.item_id or self.projection is None
            if changed_item:
                self.item_id = item_id
                self.projection = self.make_projection()
                self.raw, self.blocks = "", []
            if completed:
                if text != self.raw:
                    self.projection = self.make_projection()
                    self.raw, self.blocks = "", []
                else:
                    text = ""
            self.raw += text
            projection = self.projection
            if projection is None:
                raise ValueError("preview_configuration_invalid")
            # Parsing and publishing occur at a bounded refresh rate, with a full
            # final snapshot even when the final delta arrives within the interval.
            now = time.monotonic()
            if (
                not completed
                and not changed_item
                and now - self.last_emit < PREVIEW_REFRESH_SECONDS
            ):
                projection.input += text
                if len(projection.input) > PREVIEW_MAX_INPUT_CHARS:
                    raise ValueError("preview_input_limit")
                return
            blocks = projection.feed(text)
            if blocks != self.blocks or changed_item:
                self.blocks = blocks
                self.last_emit = now
                await self.emit(PreviewStatus.STREAMING)
        except (ValueError, TypeError, KeyError, RecursionError):
            self.disabled = True
            await self.emit(PreviewStatus.UNAVAILABLE)

    async def finish(self, status: PreviewStatus):
        if status is PreviewStatus.GENERATED and self.disabled:
            return
        await self.emit(status)
