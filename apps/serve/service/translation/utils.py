from __future__ import annotations

from service.translation.policy import TranslationFailure


def response_text(value: object, path: tuple[str | int, ...]) -> str:
    try:
        for segment in path:
            if isinstance(segment, str) and isinstance(value, dict):
                value = value[segment]
            elif isinstance(segment, int) and isinstance(value, list):
                value = value[segment]
            else:
                raise TranslationFailure("invalid_response")
    except (KeyError, IndexError, TypeError):
        raise TranslationFailure("invalid_response") from None
    if not isinstance(value, str):
        raise TranslationFailure("invalid_response")
    return value
