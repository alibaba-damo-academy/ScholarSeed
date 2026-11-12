"""Normalize the inherited proxy bypass list before any HTTP client is built."""

from __future__ import annotations

import ipaddress
import logging
import os

_LOGGER = logging.getLogger(__name__)

_VARIABLES = ("NO_PROXY", "no_proxy")


def normalize(value: str) -> tuple[str, tuple[str, ...]]:
    """Return the bypass list without IPv6 brackets, plus any loss warnings.

    httpx recognizes a bare IPv6 literal and brackets it again itself, while a
    bracketed entry falls through to a wildcard host pattern and raises
    InvalidURL. An IPv6 address with a port has no faithful spelling in that
    pattern language, so the port is dropped rather than silently reinterpreted
    as part of the address.
    """

    entries: list[str] = []
    warnings: list[str] = []
    for raw in value.split(","):
        entry = raw.strip()
        closing = entry.find("]") if entry.startswith("[") else -1
        if closing < 0:
            entries.append(entry)
            continue
        host, suffix = entry[1:closing], entry[closing + 1 :]
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            entries.append(entry)
            continue
        if suffix.startswith(":"):
            warnings.append(
                f"proxy bypass entry {entry!r} cannot express an IPv6 port; "
                f"bypassing {host} on every port"
            )
            entries.append(host)
        else:
            entries.append(host + suffix)
    return ",".join(entries), tuple(warnings)


def apply() -> None:
    """Rewrite both spellings in place so every child process inherits them."""

    warnings: list[str] = []
    for name in _VARIABLES:
        value = os.environ.get(name)
        if not value:
            continue
        normalized, messages = normalize(value)
        warnings.extend(messages)
        if normalized != value:
            os.environ[name] = normalized
    for message in dict.fromkeys(warnings):
        _LOGGER.warning(message)
