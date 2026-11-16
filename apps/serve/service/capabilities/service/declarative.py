"""Product envelope admission for declarative conversation surfaces."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

OPENUI_SLOT = "conversation.ui"
CANVAS_SLOT = "canvas.ui"
CANVAS_REVISION = "host-canvas-v1"
OPENUI_FORMAT = "openui-lang"
OPENUI_ROOT = "Conversation"
OPENUI_ROOT_REQUIRED = "openui_root_required"
OPENUI_SOURCE_BYTES = 65536
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
