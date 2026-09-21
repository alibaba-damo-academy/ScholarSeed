#!/usr/bin/env scholarseed-skill-python
"""Privacy-safe JSON persistence for academic-search artifacts.

Paper abstracts may be used while a retrieval process is running, but must not
be written by this skill. Keep this policy at the serialization boundary so
ranking code can continue to use the in-memory response unchanged.
"""

import json
import os
import tempfile


_ABSTRACT_KEYS = {"abstract", "abstract_text", "paper_abstract"}


def without_abstracts(value):
    """Return a JSON-compatible copy with abstract-bearing fields removed."""
    if isinstance(value, dict):
        return {
            key: without_abstracts(item)
            for key, item in value.items()
            if str(key).casefold() not in _ABSTRACT_KEYS
        }
    if isinstance(value, list):
        return [without_abstracts(item) for item in value]
    if isinstance(value, tuple):
        return [without_abstracts(item) for item in value]
    return value


def atomic_json_write(path, value, *, indent=2):
    """Atomically write sanitized JSON without mutating the in-memory value."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=directory, delete=False,
        ) as handle:
            temp_path = handle.name
            json.dump(
                without_abstracts(value), handle,
                ensure_ascii=False, indent=indent,
            )
            handle.write("\n")
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
