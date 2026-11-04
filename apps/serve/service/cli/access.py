"""Policy for routine Uvicorn access records, without affecting requests."""

from __future__ import annotations

import logging
from http import HTTPMethod, HTTPStatus
from urllib.parse import parse_qsl

HEALTH_PATHS = frozenset({"/api/healthz", "/api/healthz/backend"})
DESKTOP_POLL_TARGETS: dict[str, tuple[tuple[str, str], ...]] = {
    "/api/serve/attention": (),
    "/api/serve/sessions": (("limit", "60"), ("scope", "all")),
    "/api/content/projects": (),
}
ACCESS_ARGUMENT_COUNT = 5


class AccessFilter(logging.Filter):
    def __init__(self, *, quiet_desktop_polls: bool) -> None:
        super().__init__()
        self._quiet_desktop_polls = quiet_desktop_polls

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if (
            record.levelno != logging.INFO
            or not isinstance(args, tuple)
            or len(args) != ACCESS_ARGUMENT_COUNT
        ):
            return True
        _, method, target, _, status = args
        if method != HTTPMethod.GET or status != HTTPStatus.OK or not isinstance(target, str):
            return True
        path, _, query = target.partition("?")
        if path in HEALTH_PATHS and not query:
            return False
        if not self._quiet_desktop_polls:
            return True
        expected = DESKTOP_POLL_TARGETS.get(path)
        if expected is None:
            return True
        if not expected:
            return bool(query)
        return tuple(sorted(parse_qsl(query, keep_blank_values=True))) != expected
