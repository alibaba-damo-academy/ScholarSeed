#!/usr/bin/env scholarseed-skill-python
"""JSON status operations shared by generation shell stages."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def document(filename: str):
    try:
        return json.loads(Path(filename).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def output(value) -> None:
    print(json.dumps(value, ensure_ascii=False))


def main(arguments: list[str]) -> int:
    operation, *values = arguments
    if operation == "status":
        stage, status, reason, *pairs = values
        result = {"stage": stage, "status": status, "status_reason": reason}
        for pair in pairs:
            key, _, raw = pair.partition("=")
            try:
                result[key] = json.loads(raw)
            except ValueError:
                result[key] = raw
        output(result)
        return 0
    filename, *keys = values
    data = document(filename)
    if operation == "len":
        value = data.get(keys[0]) if isinstance(data, dict) else None
        print(len(value) if isinstance(value, (list, dict, str)) else 0)
    elif operation == "get":
        value = data
        for part in keys[0].split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if value is None:
            print("")
        elif isinstance(value, str):
            print(value)
        else:
            output(value)
    elif operation == "ids":
        items = data.get(keys[0]) if isinstance(data, dict) else None
        field = keys[1] if len(keys) > 1 else ""
        selected = []
        for item in items if isinstance(items, list) else ():
            value = (item.get(field) if field else None) if isinstance(item, dict) else item
            if value is not None:
                selected.append(value)
        output(selected)
    elif operation == "pick":
        output({key: data.get(key) if isinstance(data, dict) else None for key in keys})
    elif operation == "dump":
        try:
            value = json.loads(Path(filename).read_text(encoding="utf-8"))
            print(json.dumps(value, indent=2, ensure_ascii=False))
        except (OSError, ValueError) as error:
            print(f"<unreadable {filename}: {error}>")
    else:
        raise ValueError(f"unknown JSON status operation: {operation}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
