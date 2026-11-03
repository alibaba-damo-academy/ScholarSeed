"""Record provider discovery reads while preserving the host's qualifications."""

from __future__ import annotations

import hashlib

from scholarseed_runtime.contract.storage import StorageInspection, StorageSource


class StorageObservation:
    """A synchronous view which expires when its catalog call returns."""

    def __init__(self, inspection: StorageInspection) -> None:
        self._inspection: StorageInspection | None = inspection
        self._sources: dict[tuple[str, str], StorageSource] = {}

    def _active(self) -> StorageInspection:
        if self._inspection is None:
            raise RuntimeError("storage discovery view expired")
        return self._inspection

    def selected(self, root: str) -> bool:
        return self._active().selected(root)

    def read(self, root: str, name: str, max_bytes: int) -> bytes | None:
        inspection = self._active()
        if type(max_bytes) is not int or max_bytes <= 0 or not inspection.selected(root):
            raise ValueError("storage discovery requires a qualified bounded read")
        data = inspection.read(root, name, max_bytes)
        if data is not None and (not isinstance(data, bytes) or len(data) > max_bytes):
            raise ValueError("storage discovery read exceeded its contract")
        source = StorageSource(
            root,
            name,
            None if data is None else hashlib.sha256(data).hexdigest(),
            0 if data is None else len(data),
        )
        key = root, name
        previous = self._sources.get(key)
        if previous is not None and previous != source:
            raise ValueError("storage discovery source changed during inspection")
        self._sources[key] = source
        return data

    def sources(self) -> tuple[StorageSource, ...]:
        self._active()
        return tuple(self._sources[key] for key in sorted(self._sources))

    def close(self) -> None:
        # The host owns the underlying qualification and its release. Expiring
        # this view cannot close the host or grant a longer provider lifetime.
        self._inspection = None
