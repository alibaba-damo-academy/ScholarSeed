"""Generic validation and canonicalization for typed conversation cards."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from hashlib import sha256
from pathlib import Path
from typing import Any

from service.chat.constants import PRODUCT_EVENT_DISPLAY_CARD
from service.chat.persistence.events import ProductEventStore
from service.platform.bridge import DisplayCardContent

DISPLAY_CARD_MAX_CONTENT_BYTES = 65_536
DISPLAY_CARD_MAX_PER_TURN = 4
DISPLAY_CARD_MAX_BYTES_PER_TURN = 131_072
DISPLAY_CARD_ENCODING = "utf-8"
DISPLAY_CARD_ID_PREFIX = "card"
DISPLAY_CARD_IDEMPOTENCY_PREFIX = "display-card"
DISPLAY_CARD_IDENTITY_SEPARATOR = "\0"


class DisplayCardError(ValueError):
    """Stable validation failure returned by the display-card bridge."""


CardValidator = Callable[[Mapping[str, Any]], dict[str, Any]]


class CardRegistry:
    """Product composition registry for domain-owned card validators."""

    def __init__(self) -> None:
        self._validators: dict[str, CardValidator] = {}
        self._direct: set[str] = set()

    def register(self, card_type: str, validator: CardValidator, *, direct: bool = True) -> None:
        if not card_type or card_type in self._validators:
            raise ValueError("display_card_type_registration_invalid")
        self._validators[card_type] = validator
        if direct:
            self._direct.add(card_type)

    def allows_direct(self, card_type: str) -> bool:
        return card_type in self._direct

    def validate(self, card_type: str, value: Mapping[str, Any]) -> dict[str, Any]:
        validator = self._validators.get(card_type)
        if validator is None:
            raise DisplayCardError("display_card_type_unknown")
        try:
            return validator(value)
        except DisplayCardError:
            raise
        except (TypeError, ValueError) as error:
            raise DisplayCardError("display_card_content_invalid") from error


def normalize_card(
    workdir: Path,
    registry: CardRegistry,
    card_type: str,
    content: DisplayCardContent,
) -> tuple[dict[str, Any], str, int]:
    """Return one validated immutable payload, digest, and encoded size."""

    value: Any = content.data
    if content.path:
        try:
            candidate = Path(content.path)
            if candidate.is_absolute():
                raise DisplayCardError("display_card_path_invalid")
            root = workdir.resolve()
            source = (root / candidate).resolve()
            if not source.is_relative_to(root) or not source.is_file():
                raise DisplayCardError("display_card_path_invalid")
        except (OSError, ValueError) as error:
            raise DisplayCardError("display_card_path_invalid") from error
        try:
            with source.open("rb") as stream:
                encoded_source = stream.read(DISPLAY_CARD_MAX_CONTENT_BYTES + 1)
            if len(encoded_source) > DISPLAY_CARD_MAX_CONTENT_BYTES:
                raise DisplayCardError("display_card_content_too_large")
            value = json.loads(encoded_source.decode(DISPLAY_CARD_ENCODING))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise DisplayCardError("display_card_content_invalid") from error
    if not isinstance(value, Mapping):
        raise DisplayCardError("display_card_content_invalid")
    normalized = registry.validate(card_type, value)
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    encoded_size = len(encoded.encode(DISPLAY_CARD_ENCODING))
    if encoded_size > DISPLAY_CARD_MAX_CONTENT_BYTES:
        raise DisplayCardError("display_card_content_too_large")
    return normalized, sha256(encoded.encode(DISPLAY_CARD_ENCODING)).hexdigest(), encoded_size


def card_identity(session_id: str, turn_id: str, card_type: str, content_digest: str) -> str:
    """Return a stable card id scoped to one session turn and payload."""

    source = DISPLAY_CARD_IDENTITY_SEPARATOR.join((session_id, turn_id, card_type, content_digest))
    digest = sha256(source.encode(DISPLAY_CARD_ENCODING)).hexdigest()
    return f"{DISPLAY_CARD_ID_PREFIX}-{digest}"


def session_cards(
    events: ProductEventStore, session_id: str, card_type: str
) -> list[dict[str, Any]]:
    """Read durable typed cards, including sessions beyond one replay page."""
    result: list[dict[str, Any]] = []
    cursor = 0
    while records := events.replay(session_id, after_seq=cursor):
        result.extend(
            record.payload
            for record in records
            if record.kind == PRODUCT_EVENT_DISPLAY_CARD and record.payload.get("type") == card_type
        )
        cursor = records[-1].product_seq
    return result
