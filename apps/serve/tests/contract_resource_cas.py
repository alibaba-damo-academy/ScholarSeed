"""Resource version CAS contracts for adaptive WHOLE and CHUNKED objects."""

from __future__ import annotations

import os
import random
import shutil
import stat
import tempfile
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from service.content.domain.model import PROJECT_STATE_DIRNAME
from service.paths import (
    PROJECT_RESOURCES_DIRNAME,
    PROJECT_SERVICE_DIRNAME,
    PROJECT_VERSIONS_DIRNAME,
    PROJECT_VERSIONS_RELATIVE,
)
from service.resources.persistence.objects import CasCorruptError, CasLayout, CasStore

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def _object_id(payload: bytes) -> str:
    return f"sha256:{sha256(payload).hexdigest()}"


class BoundedReadStream:
    """Fail if a streaming CAS path requests the whole object in one read."""

    def __init__(self, path: Path) -> None:
        self._stream = path.open("rb")

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            raise AssertionError("streaming CAS must use bounded reads")
        return self._stream.read(size)

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        return self._stream.seek(offset, whence)

    def fileno(self) -> int:
        return self._stream.fileno()

    def close(self) -> None:
        self._stream.close()


def test_whole_roundtrip_and_canonical_identity() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-cas-whole-"))
    try:
        store = CasStore(root)
        check(
            "project CAS path is declared by the service path source of truth",
            PROJECT_VERSIONS_RELATIVE
            == (
                f"{PROJECT_STATE_DIRNAME}/{PROJECT_SERVICE_DIRNAME}/"
                f"{PROJECT_RESOURCES_DIRNAME}/{PROJECT_VERSIONS_DIRNAME}"
            ),
            PROJECT_VERSIONS_RELATIVE,
        )
        raw = b"hello adaptive cas\n"
        object_id = store.put(raw, "text/plain")
        descriptor = store.verify(object_id)
        check("small object uses WHOLE", descriptor.layout is CasLayout.WHOLE)
        check("object id hashes original bytes", object_id == _object_id(raw), object_id)
        with store.open(object_id) as stream:
            opened = stream.read()
        check("WHOLE open returns exact bytes", opened == raw, repr(opened))

        repeated = store.put(raw, "application/pdf")
        repeated_descriptor = store.verify(repeated)
        check("same bytes retain one canonical object id", repeated == object_id)
        check(
            "later media hints do not re-layout an existing object",
            repeated_descriptor.layout is descriptor.layout,
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_regular_files_remain_writable_through_durability_sync() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-cas-writable-sync-"))
    real_fsync = os.fsync

    def reject_read_only_regular_file(descriptor: int) -> None:
        if stat.S_ISREG(os.fstat(descriptor).st_mode):
            try:
                os.write(descriptor, b"")
            except OSError as exc:
                raise AssertionError("regular file was reopened read-only before fsync") from exc
        real_fsync(descriptor)

    try:
        store = CasStore(root)
        with patch(
            "service.resources.persistence.objects.os.fsync",
            side_effect=reject_read_only_regular_file,
        ):
            object_id = store.put(b"windows writable fsync regression\n", "text/markdown")
        with store.open(object_id) as stream:
            check(
                "CAS durability sync keeps regular file handles writable",
                stream.read() == b"windows writable fsync regression\n",
            )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_whole_zstandard_and_materialize() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-cas-zstd-"))
    try:
        store = CasStore(root)
        raw = (b"compressible markdown paragraph\n" * 8192)[:196_608]
        object_id = store.put(raw, "text/markdown")
        descriptor = store.verify(object_id)
        target = root / "restored" / "notes.md"
        store.materialize(object_id, target)
        check("compressible WHOLE uses ZSTD", descriptor.codec.value == "ZSTD")
        check("materialize creates exact original bytes", target.read_bytes() == raw)
        check("stored form is smaller", descriptor.stored_size_bytes < descriptor.raw_size_bytes)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_chunked_roundtrip_reuse_and_corruption() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-cas-chunked-"))
    try:
        store = CasStore(root)
        rng = random.Random(51)
        raw = rng.randbytes(9 * 1024 * 1024)
        first_id = store.put(raw, "application/pdf")
        first = store.verify(first_id)
        check("large PDF uses CHUNKED", first.layout is CasLayout.CHUNKED)
        check("CHUNKED manifest has ordered chunks", len(first.chunks) > 1)

        modified = bytearray(raw)
        modified[len(modified) // 2 : len(modified) // 2 + 4096] = b"x" * 4096
        second_id = store.put(bytes(modified), "application/pdf")
        second = store.verify(second_id)
        reused = {item.chunk_id for item in first.chunks} & {
            item.chunk_id for item in second.chunks
        }
        check("localized edit reuses at least one content-defined chunk", bool(reused))
        with store.open(second_id) as stream:
            check("CHUNKED open reconstructs exact bytes", stream.read() == bytes(modified))

        victim = store.chunk_payload_path(second.chunks[0].chunk_id)
        victim.write_bytes(b"corrupt")
        rejected = False
        try:
            store.verify(second_id)
        except CasCorruptError:
            rejected = True
        check("chunk corruption fails closed", rejected)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_chunked_stream_roundtrip_uses_bounded_reads() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-cas-stream-"))
    try:
        store = CasStore(root)
        raw = random.Random(90).randbytes(9 * 1024 * 1024)
        source_path = root / "source.pdf"
        source_path.write_bytes(raw)
        source = BoundedReadStream(source_path)
        try:
            object_id = store.put_stream(
                source,
                raw_size_bytes=len(raw),
                expected_object_id=_object_id(raw),
                media_hint="application/pdf",
            )
        finally:
            source.close()
        descriptor = store.verify(object_id)
        target = root / "restored" / "stream.pdf"
        store.materialize(object_id, target)
        check("streaming large object uses CHUNKED", descriptor.layout is CasLayout.CHUNKED)
        check("streaming object keeps canonical identity", object_id == _object_id(raw), object_id)
        check("streaming materialize restores exact bytes", target.read_bytes() == raw)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_project_fence_rejects_an_offline_root() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-cas-offline-"))
    try:
        project = root / "project"
        project.mkdir()
        store = CasStore(project / PROJECT_VERSIONS_RELATIVE, project_root=project)
        project.rename(root / "project-offline")
        rejected = False
        try:
            store.put(b"must not recreate the project")
        except FileNotFoundError:
            rejected = True
        check(
            "stale CAS path cannot recreate an offline project root",
            rejected and not project.exists(),
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    test_whole_roundtrip_and_canonical_identity()
    test_regular_files_remain_writable_through_durability_sync()
    test_whole_zstandard_and_materialize()
    test_chunked_roundtrip_reuse_and_corruption()
    test_chunked_stream_roundtrip_uses_bounded_reads()
    test_project_fence_rejects_an_offline_root()
    print(f"\ncontract_resource_cas: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
