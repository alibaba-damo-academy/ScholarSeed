"""Parse configured file declarations only from completed assistant messages."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from hashlib import sha256

from scholarseed_runtime.contract.artifact import (
    ArtifactDeclaration,
    ArtifactDirectiveSpec,
    ArtifactRole,
)

DIRECTIVE_MARKER = "::"
DIRECTIVE_LINE_MAX_CHARS = 8192
DIRECTIVE_TITLE_MAX_CHARS = 512
DIRECTIVE_FIELDS = frozenset({"file", "title", "role", "sha256"})
DIRECTIVE_INVALID = "artifact_directive_invalid"
DIRECTIVE_TOO_LARGE = "artifact_directive_too_large"
DIRECTIVE_ENCODING = "utf-8"
CONTROL_CHARACTER_LIMIT = 32
CODE_INDENT = 4
FENCE_START = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
ATTRIBUTE_NAME = re.compile(r"[a-z][a-z0-9_]*")
HASH_VALUE = re.compile(r"[0-9a-f]{64}")
DIRECTIVE_NAME = re.compile(r"[a-z][a-z0-9-]*")


@dataclass(frozen=True)
class DeclarationFailure:
    declaration_id: str
    code: str


@dataclass(frozen=True)
class ParsedDeclarations:
    text: str
    declarations: tuple[ArtifactDeclaration, ...]
    failures: tuple[DeclarationFailure, ...]


def _attributes(source: str) -> dict[str, str]:
    decoder = json.JSONDecoder()
    values: dict[str, str] = {}
    remaining = source.strip()
    while remaining:
        match = ATTRIBUTE_NAME.match(remaining)
        if match is None:
            raise ValueError(DIRECTIVE_INVALID)
        name = match.group()
        if name not in DIRECTIVE_FIELDS or name in values:
            raise ValueError(DIRECTIVE_INVALID)
        remaining = remaining[match.end() :].lstrip()
        if not remaining.startswith("="):
            raise ValueError(DIRECTIVE_INVALID)
        value, end = decoder.raw_decode(remaining[1:].lstrip())
        if not isinstance(value, str) or any(ord(char) < CONTROL_CHARACTER_LIMIT for char in value):
            raise ValueError(DIRECTIVE_INVALID)
        # JSON permits escaped lone surrogates; filesystem/event UTF-8 does not.
        # Reject at the protocol boundary instead of failing the event consumer.
        try:
            value.encode(DIRECTIVE_ENCODING)
        except UnicodeEncodeError as exc:
            raise ValueError(DIRECTIVE_INVALID) from exc
        remaining = remaining[1:].lstrip()[end:]
        if remaining and not remaining[0].isspace():
            raise ValueError(DIRECTIVE_INVALID)
        values[name] = value
        remaining = remaining.lstrip()
    return values


def parse_declarations(
    text: str,
    specs: tuple[ArtifactDirectiveSpec, ...],
    *,
    message_identity: str,
) -> ParsedDeclarations:
    """Keep examples untouched; reject malformed control lines without executing text."""

    configured = {spec.name: spec for spec in specs}
    if len(configured) != len(specs) or any(
        DIRECTIVE_NAME.fullmatch(name) is None for name in configured
    ):
        raise ValueError("invalid artifact directive configuration")
    visible: list[str] = []
    declarations: list[ArtifactDeclaration] = []
    failures: list[DeclarationFailure] = []
    fence = ""
    for index, line in enumerate(text.splitlines(keepends=True)):
        candidate = line.rstrip("\r\n")
        marker = FENCE_START.match(candidate)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                if not marker[2].strip():
                    fence = ""
            visible.append(line)
            continue
        if marker and (marker[1][0] != "`" or "`" not in marker[2]):
            fence = marker[1]
            visible.append(line)
            continue
        if candidate.startswith((" " * CODE_INDENT, "\t")):
            visible.append(line)
            continue
        stripped = candidate.lstrip(" ")
        matched = next(
            (
                spec
                for name, spec in configured.items()
                if stripped.startswith(f"{DIRECTIVE_MARKER}{name}")
                and (
                    len(stripped) == len(DIRECTIVE_MARKER) + len(name)
                    or stripped[len(DIRECTIVE_MARKER) + len(name)] in "{ \t"
                )
            ),
            None,
        )
        if matched is None:
            visible.append(line)
            continue
        declaration_id = sha256(
            f"{message_identity}\0{index}".encode(DIRECTIVE_ENCODING)
        ).hexdigest()
        if len(candidate) > DIRECTIVE_LINE_MAX_CHARS:
            failures.append(DeclarationFailure(declaration_id, DIRECTIVE_TOO_LARGE))
            continue
        try:
            body = stripped[len(DIRECTIVE_MARKER) + len(matched.name) :].strip()
            if not body.startswith("{") or not body.endswith("}"):
                raise ValueError(DIRECTIVE_INVALID)
            values = _attributes(body[1:-1])
            path = values.get("file", "").strip()
            title = values.get("title", "").strip()
            digest = values.get("sha256", "")
            if not path or len(title) > DIRECTIVE_TITLE_MAX_CHARS:
                raise ValueError(DIRECTIVE_INVALID)
            if digest and HASH_VALUE.fullmatch(digest) is None:
                raise ValueError(DIRECTIVE_INVALID)
            role = ArtifactRole(values.get("role", matched.default_role.value))
            declarations.append(ArtifactDeclaration(declaration_id, path, role, title, digest))
        except (ValueError, TypeError):
            failures.append(DeclarationFailure(declaration_id, DIRECTIVE_INVALID))
    return ParsedDeclarations("".join(visible).rstrip(), tuple(declarations), tuple(failures))
