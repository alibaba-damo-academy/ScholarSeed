"""Shared HTTP byte-range parsing for bounded product content."""

from __future__ import annotations

import re

BYTE_RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_byte_range(value: str, size: int) -> tuple[int, int] | None:
    match = BYTE_RANGE_PATTERN.fullmatch(value.strip())
    if match is None or size <= 0:
        return None
    raw_start, raw_end = match.groups()
    if not raw_start and not raw_end:
        return None
    if not raw_start:
        suffix = int(raw_end)
        if suffix <= 0:
            return None
        return max(size - suffix, 0), size - 1
    start = int(raw_start)
    end = int(raw_end) if raw_end else size - 1
    if start >= size or end < start:
        return None
    return start, min(end, size - 1)


__all__ = ["parse_byte_range"]
