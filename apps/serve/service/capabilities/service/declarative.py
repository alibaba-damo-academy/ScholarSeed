"""Product envelope admission for declarative conversation surfaces."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

OPENUI_SLOT = "conversation.ui"
CANVAS_SLOT = "canvas.ui"
CANVAS_REVISION = "host-canvas-v1"
OPENUI_FORMAT = "openui-lang"
OPENUI_ROOT = "Conversation"
OPENUI_ROOT_REQUIRED = "openui_root_required"
OPENUI_SOURCE_BYTES = 65536
OPENUI_LAYOUT_DEPTH = 16
OPENUI_LAYOUT_NAME = re.compile(r"[A-Z][A-Za-z0-9]*")
OPENUI_LITERAL_TYPES = frozenset({"string", "number", "integer", "boolean", "null"})
OPENUI_OPENING_DELIMITERS = frozenset("([{")
OPENUI_DECLARATIONS = re.compile(
    r"""(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:\#|//)[^\r\n]*)"""
    rf"|(?P<root>^[ \t]*root\s*=\s*{OPENUI_ROOT}\s*(?=\())|(?P<delimiter>[()\[\]{{}}])",
    re.MULTILINE,
)


class ConversationDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    format: Literal["openui-lang"]
    version: Literal[1]
    source: str = Field(min_length=1, max_length=OPENUI_SOURCE_BYTES)

    @classmethod
    def for_publication(cls, data: object) -> ConversationDocument:
        document = cls.model_validate(data)
        depth = 0
        for match in OPENUI_DECLARATIONS.finditer(document.source):
            if depth == 0 and match.group("root"):
                return document
            delimiter = match.group("delimiter")
            if delimiter:
                depth += 1 if delimiter in OPENUI_OPENING_DELIMITERS else -1
        raise ValueError(OPENUI_ROOT_REQUIRED)

    @field_validator("source")
    @classmethod
    def bounded_source(cls, source: str) -> str:
        if not source.strip() or len(source.encode()) > OPENUI_SOURCE_BYTES:
            raise ValueError("openui_source_size")
        return source


class ConversationLayout(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    component: Literal["Conversation"]
    args: list[Any]

    @staticmethod
    def literal_field(schema: object) -> bool:
        while isinstance(schema, dict):
            kind = schema.get("type")
            if not isinstance(kind, str):
                return False
            if kind != "array":
                return kind in OPENUI_LITERAL_TYPES
            schema = schema.get("items")
        return False

    def validate_fields(self, schema: dict[str, Any]) -> None:
        required = set(schema.get("required", ()))
        pending = [(self.args, 0)]
        while pending:
            value, depth = pending.pop()
            if depth > OPENUI_LAYOUT_DEPTH:
                raise ValueError("openui_layout_depth")
            if isinstance(value, list):
                pending.extend((item, depth + 1) for item in value)
            elif isinstance(value, dict):
                if set(value) == {"field"}:
                    field = value["field"]
                    if (
                        not isinstance(field, str)
                        or field not in required
                        or not self.literal_field(schema.get("properties", {}).get(field))
                        or field in {"__proto__", "constructor", "prototype"}
                    ):
                        raise ValueError("openui_layout_field_invalid")
                elif (
                    set(value) == {"component", "args"}
                    and isinstance(value["component"], str)
                    and OPENUI_LAYOUT_NAME.fullmatch(value["component"])
                    and isinstance(value["args"], list)
                ):
                    pending.append((value["args"], depth + 1))
                else:
                    raise ValueError("openui_layout_node_invalid")
