"""Private files owned by the component registry."""

from __future__ import annotations

import errno
import os
import time
from collections.abc import Callable, Iterator
from contextlib import ExitStack, closing, contextmanager
from hashlib import sha256
from pathlib import Path

from service.paths import component_storage_root
from service.platform.privacy import publish_private
from service.platform.storage import DirectoryHandle, canonical_root, open_private_child

CARDS_DIRECTORY = "cards"
CARDS_FILENAME = "cards.json"
REVISIONS_DIRECTORY = "revisions"
UI_DIRECTORY = "ui"
WINDOWS_PLATFORM = "nt"
WINDOWS_REPLACE_RETRY_ERRORS = (5, 32)
WINDOWS_REPLACE_RETRIES = 4
WINDOWS_REPLACE_RETRY_SECONDS = 0.025


def resource_name(identity: str) -> str:
    return sha256(identity.encode()).hexdigest() + ".json"


def session_directory(session_id: str) -> str:
    return sha256(session_id.encode()).hexdigest()


class ComponentFiles:
    def __init__(self, database: Path) -> None:
        self.root = component_storage_root(database.absolute())

    @contextmanager
    def directory(self, *parts: str, create: bool = False) -> Iterator[DirectoryHandle]:
        with ExitStack() as stack:
            directory = stack.enter_context(
                closing(
                    open_private_child(
                        canonical_root(self.root.parent), self.root.name, create=create
                    )
                )
            )
            for part in parts:
                directory = stack.enter_context(
                    closing(open_private_child(directory.path, part, create=create))
                )
            yield directory

    def read(self, parts: tuple[str, ...], name: str) -> str:
        with self.directory(*parts) as directory:
            descriptor = directory.open_private(name, os.O_RDONLY)
            with os.fdopen(descriptor, encoding="utf-8") as stream:
                return stream.read()

    def write(
        self,
        parts: tuple[str, ...],
        name: str,
        body: str,
        checkpoint: Callable[[], None] | None = None,
    ) -> None:
        with self.directory(*parts, create=True) as directory:
            data = body.encode()
            for attempt in range(WINDOWS_REPLACE_RETRIES + 1):
                try:
                    publish_private(directory.path / name, data, checkpoint=checkpoint)
                    return
                except OSError as error:
                    # The Windows native rename requires readers of the old leaf to close.
                    if (
                        os.name != WINDOWS_PLATFORM
                        or getattr(error, "winerror", None) not in WINDOWS_REPLACE_RETRY_ERRORS
                        or attempt == WINDOWS_REPLACE_RETRIES
                    ):
                        raise
                    if checkpoint is not None:
                        checkpoint()
                    time.sleep(WINDOWS_REPLACE_RETRY_SECONDS)

    def discard(self, parts: tuple[str, ...], name: str) -> None:
        try:
            with self.directory(*parts) as directory:
                directory.remove_private(name)
        except FileNotFoundError:
            return

    def discard_session(self, session_id: str) -> None:
        leaf = session_directory(session_id)
        self.discard((CARDS_DIRECTORY, leaf), CARDS_FILENAME)
        try:
            with self.directory(CARDS_DIRECTORY) as directory:
                directory.rmdir(leaf)
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                raise
