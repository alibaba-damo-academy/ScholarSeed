"""Content filtering independent of the embedding application's authentication system."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

REDACTED = "[REDACTED]"
REDACTION_VERSION = 1
SECRET_KEYS = re.compile(
    r"(?i)(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)"
)
MIN_SECRET_LENGTH = 4
SECRET_ASSIGNMENT = re.compile(
    r"""(?i)["']?(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)["']?\s*[=:]\s*(?:"(?P<double>[^"]*)(?:"|$)|'(?P<single>[^']*)(?:'|$)|(?P<bare>[^\s,;，；。"']+))"""
)
TEXT_RULES = (
    re.compile(r"(?i)\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+"),
    re.compile(r"\b(?:sk|ssk)-[A-Za-z0-9_-]+"),
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
    re.compile(
        r"""(?i)["']?(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)["']?\s*[=:]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)"""
    ),
    re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)"),
)


@dataclass
class Redactor:
    secrets: tuple[str, ...] = field(default=(), repr=False)
    _observed: set[str] = field(default_factory=set, repr=False)

    def observe(self, value: Any) -> None:
        """Remember labelled secrets only in this recorder's memory, including echoes."""
        if isinstance(value, dict):
            for key, item in value.items():
                if SECRET_KEYS.search(str(key)) and isinstance(item, str):
                    if len(item) >= MIN_SECRET_LENGTH and item != REDACTED:
                        self._observed.add(item)
                self.observe(item)
        elif isinstance(value, (tuple, list)):
            for item in value:
                self.observe(item)
        elif isinstance(value, str):
            for match in SECRET_ASSIGNMENT.finditer(value):
                secret = next(part for part in match.groups() if part is not None)
                if len(secret) >= MIN_SECRET_LENGTH and secret != REDACTED:
                    self._observed.add(secret)

    def text(self, value: str) -> str:
        self.observe(value)
        if value.lstrip().startswith(("{", "[")):
            try:
                structured = json.loads(value)
            except ValueError:
                pass
            else:
                safe = self.value(structured)
                return json.dumps(safe, ensure_ascii=False) if safe != structured else value
        for secret in sorted(
            (s for s in (*self.secrets, *self._observed) if s), key=len, reverse=True
        ):
            value = value.replace(secret, REDACTED)
        for rule in TEXT_RULES:
            value = rule.sub(REDACTED, value)
        return value

    def value(self, value: Any) -> Any:
        self.observe(value)
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {
                str(key): REDACTED if SECRET_KEYS.search(str(key)) else self.value(item)
                for key, item in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [self.value(item) for item in value]
        if value is None or isinstance(value, (bool, int, float)):
            return value
        raise ValueError("unsupported diagnostic content type")
