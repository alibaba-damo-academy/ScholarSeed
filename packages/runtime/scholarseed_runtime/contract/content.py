"""Optional content availability metadata; no recording policy or storage dependency."""

from __future__ import annotations

from typing import Mapping

from scholarseed_runtime.contract.event import RuntimeValue

CONTENT_OBSERVATIONS = "content_observations"
CONTENT_FIELDS = frozenset({"text", "input", "output", "details"})
CONTENT_SOURCE = "runtime_observation"
CONTENT_SCHEMA_VERSION = 1


def validate_content(payload: RuntimeValue) -> None:
    if not isinstance(payload, Mapping) or CONTENT_OBSERVATIONS not in payload:
        return
    observations = payload[CONTENT_OBSERVATIONS]
    if not isinstance(observations, list):
        raise ValueError("content observations must be an array")
    for observation in observations:
        if not isinstance(observation, dict):
            raise ValueError("content observation must be an object")
        length = observation.get("original_bytes")
        if (
            observation.get("version") != CONTENT_SCHEMA_VERSION
            or observation.get("field") not in CONTENT_FIELDS
            or observation.get("source") != CONTENT_SOURCE
            or not isinstance(observation.get("truncated"), bool)
            or (length is not None and (type(length) is not int or length < 0))
        ):
            raise ValueError("invalid content availability metadata")
