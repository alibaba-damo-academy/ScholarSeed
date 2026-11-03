"""Per-process CI progress evidence; never a source of test verdicts."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

PROGRESS_DIRECTORY = "CI_PROGRESS_DIRECTORY"
PROGRESS_MODULE = "CI_PROGRESS_MODULE"
WRITE_LOCK = threading.Lock()


def emit(kind: str, identity: str, status: str, **details) -> None:
    if kind == "suite" and os.environ.get(PROGRESS_MODULE):
        return
    directory = os.environ.get(PROGRESS_DIRECTORY)
    if not directory:
        return
    target = Path(directory) / f"{os.getpid()}.jsonl"
    event = {
        "kind": kind,
        "id": identity,
        "status": status,
        "pid": os.getpid(),
        "time": time.time(),
        **details,
    }
    # Windows CRT append through separate handles is not an atomic record write.
    # The runner emits suite events from multiple threads sharing this PID file.
    with WRITE_LOCK, target.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, ensure_ascii=False) + "\n")
