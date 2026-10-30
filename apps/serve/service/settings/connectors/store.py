"""Pinned private records with cross-process arbitration and atomic publication.

Records are permission-protected, not encrypted. No secret record is an API view.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
from contextlib import closing
from pathlib import Path
from typing import Callable, TypeVar

from service.paths import CONNECTOR_STATE_ROOT
from service.platform.storage import canonical_root, open_private_directory, stable_read_matches

STATE_FILENAME = "state.json"
STATE_LOCK = "state.lock"
STATE_LIMIT = 8 * 1024 * 1024
STATE_STAGE_PREFIX = ".state-"
TOKEN_BYTES = 32
Result = TypeVar("Result")


class ConnectorStore:
    def __init__(self, root: Path = CONNECTOR_STATE_ROOT) -> None:
        self.root = root
        self.lock = threading.Lock()

    def transaction(self, change: Callable[[dict], Result]) -> Result:
        with self.lock:
            return self._transaction(change)

    def _transaction(self, change: Callable[[dict], Result]) -> Result:
        with closing(
            open_private_directory(canonical_root(self.root.parent), (self.root.name,))
        ) as directory:
            with directory.arbitration(STATE_LOCK):
                try:
                    descriptor = directory.open_private(STATE_FILENAME, os.O_RDONLY)
                except FileNotFoundError:
                    state = {"entries": {}, "clients": {}}
                else:
                    with os.fdopen(descriptor, "rb") as stream:
                        before = os.fstat(stream.fileno())
                        payload = stream.read(STATE_LIMIT + 1)
                        if len(payload) > STATE_LIMIT or not stable_read_matches(
                            before,
                            os.fstat(stream.fileno()),
                            directory.stat(STATE_FILENAME),
                            len(payload),
                        ):
                            raise ValueError("connector_storage_invalid")
                        state = json.loads(payload)
                    if (
                        not isinstance(state, dict)
                        or set(state) != {"entries", "clients"}
                        or not all(isinstance(state[key], dict) for key in ("entries", "clients"))
                    ):
                        raise ValueError("connector_storage_invalid")
                original = json.dumps(state, ensure_ascii=True).encode()
                result = change(state)
                payload = json.dumps(state, ensure_ascii=True).encode()
                if payload == original:
                    return result
                if len(payload) > STATE_LIMIT:
                    raise ValueError("connector_storage_full")
                temporary = STATE_STAGE_PREFIX + secrets.token_hex(TOKEN_BYTES)
                try:
                    descriptor = directory.open_private(
                        temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                    )
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(payload)
                        stream.flush()
                        os.fsync(stream.fileno())
                    directory.replace_private(temporary, STATE_FILENAME)
                finally:
                    try:
                        directory.remove_private(temporary)
                    except FileNotFoundError:
                        pass
                return result
