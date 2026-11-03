"""Strict JSON decoding shared by package and plugin metadata consumers."""

from __future__ import annotations

import json
import math
from typing import Any


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("non-finite JSON numbers are not supported")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite JSON numbers are not supported")
    return number


def json_object(payload: bytes, *, limit: int) -> dict[str, Any]:
    if len(payload) > limit:
        raise ValueError("JSON resource exceeds its size limit")
    try:
        result = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except RecursionError as exc:
        raise ValueError("JSON nesting exceeds decoder limits") from exc
    if not isinstance(result, dict):
        raise ValueError("JSON resource must contain an object")
    return result
