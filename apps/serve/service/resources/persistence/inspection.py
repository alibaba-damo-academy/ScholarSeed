"""Bounded read-only inspection of resource CAS storage.

Live bytes use the production codecs. Recovery regenerates staging from verified
CAS objects, and GC discards trash; those residual bytes are inventoried without
interpreting interrupted publication files as completed descriptors. This is
not proof of writer coverage or whole-product update compatibility.
"""

from __future__ import annotations

import os
import sqlite3
import stat
import time
from contextlib import closing
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import BinaryIO, Callable, Iterator, Protocol

from service.platform.domains import DomainChangedError
from service.platform.storage import (
    NOFOLLOW,
    NONBLOCK,
    is_regular,
    open_directory,
    stable_read_matches,
)
from service.resources.persistence.chunks import CHUNK_MAX_BYTES
from service.resources.persistence.objects import (
    CasLayout,
    CasStore,
    ObjectDescriptor,
    decode_object_descriptor,
    verified_chunk,
    verified_chunks,
    verified_whole,
)
from service.resources.persistence.version import VersionStore

MAX_OBJECTS = 4096
MAX_RESIDUAL_ENTRIES = 4096
MAX_RESIDUAL_DEPTH = 8
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_WHOLE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_SECONDS = 30.0
HEX = frozenset("0123456789abcdef")


@dataclass(frozen=True)
class CasStorageInspection:
    present: bool
    objects: int
    chunks: int
    staged_files: int
    trashed_files: int
    read_bytes: int
    digest: str
    publications: tuple[CasPublicationPreview, ...] = ()


@dataclass(frozen=True)
class CasPublicationPreview:
    object_id: str
    files: int
    size: int
    digest: str


class CasPublication:
    """Bounded private publication bytes interpreted by the receiving codec.

    These bytes are never paths to materialize or diagnostic data. Construction
    only collects a candidate image; verify() must succeed before its descriptor
    can satisfy a ledger reference. Each export regenerates its own image under
    the native directory qualification instead of persisting a spool.
    """

    def __init__(self, object_id: str):
        _object_parts(object_id, "objects")
        self.object_id = object_id
        self._files: dict[tuple[str, ...], bytes] = {}
        self._size = 0
        self._deadline = time.monotonic() + MAX_SECONDS
        self._failed = False
        self._sealed = False

    def check(self) -> None:
        if self._failed:
            raise RuntimeError("CAS publication already failed")
        if time.monotonic() > self._deadline:
            raise ValueError("CAS publication exceeded time budget")

    def add(self, kind: str, identifier: str, name: str, payload: bytes) -> None:
        try:
            self.check()
            if (
                self._sealed
                or kind not in ("objects", "chunks")
                or name not in ("meta.json", "manifest.json", "payload")
                or type(payload) is not bytes
            ):
                raise ValueError("invalid CAS publication file")
            if kind == "objects" and identifier != self.object_id:
                raise ValueError("CAS publication object changed")
            if kind == "chunks" and name == "manifest.json":
                raise ValueError("invalid CAS chunk publication")
            parts = (*_object_parts(identifier, kind), name)
            limit = (
                MAX_METADATA_BYTES
                if name != "payload"
                else CHUNK_MAX_BYTES if kind == "chunks" else MAX_WHOLE_BYTES
            )
            if len(payload) > limit:
                raise ValueError("CAS publication file exceeds budget")
            if parts in self._files:
                # Repeated chunk references publish the same immutable bytes.
                if self._files[parts] != payload:
                    raise ValueError("CAS publication duplicate differs")
                return
            if (
                len(self._files) >= 2 * MAX_OBJECTS + 2
                or self._size + len(payload) > MAX_TOTAL_BYTES
            ):
                raise ValueError("CAS publication exceeds budget")
            self._files[parts] = payload
            self._size += len(payload)
        except BaseException:
            self._failed = True
            raise

    def preview(self) -> CasPublicationPreview:
        self.check()
        if not self._sealed:
            raise ValueError("CAS publication has not been verified")
        digest = sha256(b"scholarseed-cas-publication-v1\0")
        for parts, data in sorted(self._files.items()):
            self.check()
            label = "/".join(parts).encode("ascii")
            digest.update(len(label).to_bytes(8, "big") + label)
            digest.update(len(data).to_bytes(8, "big"))
            digest.update(data)
        return CasPublicationPreview(
            self.object_id, len(self._files), self._size, digest.hexdigest()
        )

    def verify(self) -> ObjectDescriptor:
        try:
            self.check()
            reader = _PublicationReader(self)
            used = set()

            def read_chunk(identifier):
                used.add(identifier)
                return _read_chunk(reader, identifier)

            descriptor = _read_object(reader, self.object_id, read_chunk)
            present = {"sha256:" + parts[-2] for parts in self._files if parts[2] == "chunks"}
            if used != present:
                raise ValueError("CAS publication contains unreferenced chunks")
            self._sealed = True
            return descriptor
        except BaseException:
            self._failed = True
            raise

    def files(self) -> Iterator[tuple[str, str, str, bytes]]:
        self.check()
        if not self._sealed:
            raise ValueError("CAS publication has not been verified")
        for parts, data in sorted(self._files.items()):
            self.check()
            yield parts[2], "sha256:" + parts[-2], parts[-1], data


class _ObjectReader(Protocol):
    total: int

    def check(self) -> None: ...

    def names(self, parts: tuple[str, ...], limit: int) -> tuple[str, ...] | None: ...

    def read(self, parts: tuple[str, ...], name: str, limit: int) -> bytes: ...


class CasPublicationSet:
    """A recovery's aggregate bound, including objects left without references."""

    def __init__(self):
        self._images: dict[tuple[str, str], CasPublication] = {}
        self._size = 0
        self._deadline = time.monotonic() + MAX_SECONDS
        self._failed = False
        self._sealed = False

    def _check(self):
        if self._failed:
            raise RuntimeError("CAS recovery publications already failed")
        if time.monotonic() > self._deadline:
            raise ValueError("CAS recovery publications exceeded time budget")

    def add(
        self, database: str, object_id: str, kind: str, identifier: str, name: str, data: bytes
    ) -> None:
        try:
            self._check()
            if (
                self._sealed
                or not isinstance(database, str)
                or not database.startswith("project.")
                or not 8 < len(database) <= 64
                or not all(
                    value.isascii() and (value.isalnum() or value in "-_") for value in database[8:]
                )
            ):
                raise ValueError("invalid CAS recovery database")
            key = (database, object_id)
            image = self._images.get(key)
            if image is None:
                if len(self._images) >= MAX_OBJECTS:
                    raise ValueError("CAS recovery publications exceeded object budget")
                image = CasPublication(object_id)
                self._images[key] = image
            previous = image._size
            image.add(kind, identifier, name, data)
            self._size += image._size - previous
            if self._size > MAX_TOTAL_BYTES:
                raise ValueError("CAS recovery publications exceeded byte budget")
        except BaseException:
            self._failed = True
            raise

    def finish(self) -> None:
        try:
            self._check()
            decoded = 0
            for image in self._images.values():
                self._check()
                decoded += image.verify().raw_size_bytes
                if decoded > MAX_TOTAL_BYTES:
                    raise ValueError("CAS recovery publications exceeded decoded budget")
            self._sealed = True
        except BaseException:
            self._failed = True
            raise

    def for_database(self, database: str) -> tuple[CasPublication, ...]:
        self._check()
        if not self._sealed:
            raise ValueError("CAS recovery publications are incomplete")
        return tuple(
            image
            for (owner, _identifier), image in sorted(self._images.items())
            if owner == database
        )


class _PublicationReader:
    """Use the physical inspector's exact object and chunk decoding path."""

    def __init__(self, publication: CasPublication):
        self.publication = publication
        self.total = 0

    def check(self):
        self.publication.check()

    def names(self, parts: tuple[str, ...], limit: int) -> tuple[str, ...] | None:
        self.check()
        names = tuple(
            sorted(
                {
                    path[len(parts)]
                    for path in self.publication._files
                    if path[: len(parts)] == parts and len(path) > len(parts)
                }
            )
        )
        if len(names) > limit:
            raise ValueError("CAS publication exceeded entry budget")
        return names or None

    def read(self, parts: tuple[str, ...], name: str, limit: int) -> bytes:
        self.check()
        data = self.publication._files.get((*parts, name))
        if data is None or len(data) > limit or self.total + len(data) > MAX_TOTAL_BYTES:
            raise ValueError("CAS publication file unavailable or exceeds budget")
        self.total += len(data)
        return data


class _Reader:
    def __init__(self, root: Path):
        self.root = root
        self.total = 0
        self.deadline = time.monotonic() + MAX_SECONDS
        self.hash = sha256(b"scholarseed-cas-storage-v1\0")

    def check(self):
        if time.monotonic() > self.deadline:
            raise ValueError("CAS inspection exceeded time budget")

    def names(self, parts: tuple[str, ...], limit: int) -> tuple[str, ...] | None:
        self.check()
        try:
            directory = open_directory(self.root, parts)
        except FileNotFoundError:
            return None
        with closing(directory):
            location = directory.fileno() if directory.descriptor is not None else directory.path
            names: list[str] = []
            with os.scandir(location) as entries:
                for entry in entries:
                    self.check()
                    if len(names) >= limit:
                        raise ValueError("CAS inspection exceeded entry budget")
                    names.append(entry.name)
            return tuple(sorted(names))

    def read(self, parts: tuple[str, ...], name: str, limit: int, *, retain: bool = True) -> bytes:
        self.check()
        with closing(open_directory(self.root, parts)) as directory:
            descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
            with os.fdopen(descriptor, "rb") as source:
                before = os.fstat(source.fileno())
                remaining = min(limit, MAX_TOTAL_BYTES - self.total)
                if not is_regular(before) or not 0 <= before.st_size <= remaining:
                    raise ValueError("CAS source exceeds read budget or is not a file")
                label = "/".join((*parts, name)).encode("utf-8")
                self.hash.update(b"file\0" + len(label).to_bytes(8, "big") + label)
                self.hash.update(before.st_size.to_bytes(8, "big"))
                data = bytearray()
                count = 0
                while count <= remaining:
                    self.check()
                    chunk = source.read(min(1024 * 1024, remaining + 1 - count))
                    if not chunk:
                        break
                    count += len(chunk)
                    self.hash.update(chunk)
                    if retain:
                        data.extend(chunk)
                if (
                    not stable_read_matches(
                        before, os.fstat(source.fileno()), directory.stat(name), count
                    )
                    or count > remaining
                ):
                    raise DomainChangedError("CAS source changed during inspection")
        self.total += count
        return bytes(data)


def _residual(reader: _Reader, root: str) -> int:
    entries = 0
    files = 0

    def visit(parts: tuple[str, ...]) -> None:
        nonlocal entries, files
        if len(parts) > MAX_RESIDUAL_DEPTH:
            raise ValueError("CAS residual depth exceeds budget")
        names = reader.names(parts, MAX_RESIDUAL_ENTRIES - entries)
        label = "/".join(parts).encode("utf-8")
        reader.hash.update(b"directory\0" + len(label).to_bytes(8, "big") + label)
        reader.hash.update(b"absent\0" if names is None else b"present\0")
        if names is None:
            if len(parts) != 1:
                raise DomainChangedError("CAS residual directory disappeared")
            return
        entries += len(names)
        with closing(open_directory(reader.root, parts)) as directory:
            for name in names:
                reader.check()
                identity = directory.stat(name)
                if stat.S_ISDIR(identity.st_mode):
                    visit((*parts, name))
                elif is_regular(identity):
                    reader.read(parts, name, MAX_TOTAL_BYTES, retain=False)
                    files += 1
                else:
                    raise ValueError("unsupported CAS residual entry")
        if reader.names(parts, MAX_RESIDUAL_ENTRIES) != names:
            raise DomainChangedError("CAS residual inventory changed")

    visit((root,))
    return files


def _inventory(reader: _Reader, base: tuple[str, ...]) -> tuple[str, ...] | None:
    buckets = reader.names(base, 256)
    if buckets is None:
        return None
    identifiers: list[str] = []
    for bucket in buckets:
        if len(bucket) != 2 or not set(bucket) <= HEX:
            raise ValueError("unsupported CAS bucket")
        names = reader.names((*base, bucket), MAX_OBJECTS - len(identifiers))
        if names is None:
            raise DomainChangedError("CAS bucket disappeared")
        for name in names:
            if len(name) != 64 or not set(name) <= HEX or not name.startswith(bucket):
                raise ValueError("unsupported CAS identity")
            identifiers.append(name)
    return tuple(identifiers)


def _object_parts(identifier: str, kind: str) -> tuple[str, ...]:
    if (
        not isinstance(identifier, str)
        or len(identifier) != 71
        or not identifier.startswith("sha256:")
        or not set(identifier[7:]) <= HEX
    ):
        raise ValueError("invalid CAS object identity")
    value = identifier[7:]
    return ("cas", "v1", kind, "sha256", value[:2], value)


def _read_chunk(
    reader: _ObjectReader, identifier: str, *, known: frozenset[str] | None = None
) -> bytes:
    parts = _object_parts(identifier, "chunks")
    if known is not None and identifier[7:] not in known:
        raise ValueError("CAS object references an absent chunk")
    if reader.names(parts, 3) != ("meta.json", "payload"):
        raise ValueError("unsupported CAS chunk contents")
    return verified_chunk(
        identifier,
        reader.read(parts, "meta.json", MAX_METADATA_BYTES),
        reader.read(parts, "payload", CHUNK_MAX_BYTES),
    )


def _read_object(
    reader: _ObjectReader, identifier: str, read_chunk: Callable[[str], bytes]
) -> ObjectDescriptor:
    reader.check()
    parts = _object_parts(identifier, "objects")
    descriptor = decode_object_descriptor(
        identifier,
        reader.read(parts, "meta.json", MAX_METADATA_BYTES),
        lambda: reader.read(parts, "manifest.json", MAX_METADATA_BYTES),
    )
    expected = (
        ("meta.json", "payload")
        if descriptor.layout is CasLayout.WHOLE
        else ("manifest.json", "meta.json")
    )
    if reader.names(parts, 3) != expected:
        raise ValueError("unsupported CAS object contents")
    if descriptor.raw_size_bytes > MAX_TOTAL_BYTES - reader.total:
        raise ValueError("CAS decoded content exceeds budget")
    if descriptor.layout is CasLayout.WHOLE:
        if descriptor.raw_size_bytes > MAX_WHOLE_BYTES:
            raise ValueError("CAS WHOLE content exceeds budget")
        verified_whole(descriptor, reader.read(parts, "payload", MAX_WHOLE_BYTES))
    else:
        for _payload in verified_chunks(descriptor, read_chunk):
            reader.check()
    return descriptor


class CasProjection:
    """One private recovery's verified existing/new object namespace.

    The caller retains native source qualification and supplies stable captures.
    This object neither owns a writer nor creates a filesystem location. Repeated
    row export creates a new projection and rereads all source evidence.
    """

    def __init__(self, root: Path | None):
        self._reader = _Reader(root) if root is not None else None
        self._deadline = time.monotonic() + MAX_SECONDS
        self._captured_bytes = 0
        self._objects: dict[str, ObjectDescriptor] = {}
        self._failed = False

    def _check(self) -> None:
        if self._failed:
            raise RuntimeError("CAS projection already failed")
        if time.monotonic() > self._deadline:
            raise ValueError("CAS projection exceeded time budget")
        if (
            self._captured_bytes + (self._reader.total if self._reader is not None else 0)
            > MAX_TOTAL_BYTES
        ):
            raise ValueError("CAS projection exceeded read budget")

    def project_stream(
        self,
        raw: BinaryIO,
        *,
        raw_size_bytes: int,
        expected_object_id: str,
        emit_file: Callable[[str, str, str, bytes], None] | None = None,
    ) -> ObjectDescriptor:
        try:
            self._check()
            parts = _object_parts(expected_object_id, "objects")
            if type(raw_size_bytes) is not int or raw_size_bytes < 0:
                raise ValueError("invalid CAS capture size")
            self._captured_bytes += raw_size_bytes
            self._check()
            existing = self._objects.get(expected_object_id)
            if existing is not None:
                if existing.raw_size_bytes != raw_size_bytes:
                    raise ValueError("CAS capture size changed")
                return existing
            if len(self._objects) >= MAX_OBJECTS:
                raise ValueError("CAS projection exceeded object budget")
            reader = self._reader
            if reader is not None and reader.names(parts, 3) is not None:

                def read_chunk(identifier: str) -> bytes:
                    self._check()
                    value = _read_chunk(reader, identifier)
                    self._check()
                    return value

                descriptor = _read_object(reader, expected_object_id, read_chunk)
                if descriptor.raw_size_bytes != raw_size_bytes:
                    raise ValueError("CAS capture size changed")
            else:
                descriptor = CasStore.preview_new_stream(
                    raw,
                    raw_size_bytes=raw_size_bytes,
                    expected_object_id=expected_object_id,
                    max_raw_bytes=MAX_TOTAL_BYTES,
                    max_chunks=MAX_OBJECTS,
                    check=self._check,
                    emit_file=emit_file,
                )
            self._check()
            self._objects[expected_object_id] = descriptor
            return descriptor
        except BaseException:
            self._failed = True
            raise

    def descriptors(self) -> tuple[ObjectDescriptor, ...]:
        self._check()
        return tuple(self._objects[key] for key in sorted(self._objects))

    @property
    def source_read_bytes(self) -> int:
        return self._reader.total if self._reader is not None else 0

    @property
    def object_count(self) -> int:
        return len(self._objects)


def _verified_publications(
    publications: tuple[CasPublication, ...],
) -> tuple[dict[str, ObjectDescriptor], tuple[CasPublicationPreview, ...]]:
    if len(publications) > MAX_OBJECTS:
        raise ValueError("CAS recovery exceeds object budget")
    descriptors = {}
    previews = []
    encoded = decoded = 0
    deadline = time.monotonic() + MAX_SECONDS
    for publication in publications:
        if time.monotonic() > deadline:
            raise ValueError("CAS recovery exceeds time budget")
        descriptor = publication.verify()
        preview = publication.preview()
        if descriptor.object_id in descriptors:
            raise ValueError("duplicate CAS recovery object")
        encoded += preview.size
        decoded += descriptor.raw_size_bytes
        if max(encoded, decoded) > MAX_TOTAL_BYTES:
            raise ValueError("CAS recovery exceeds byte budget")
        descriptors[descriptor.object_id] = descriptor
        previews.append(preview)
    return descriptors, tuple(sorted(previews, key=lambda preview: preview.object_id))


def inspect_cas_storage(
    root: Path | None,
    *,
    ledger: sqlite3.Connection | None = None,
    publications: tuple[CasPublication, ...] = (),
) -> CasStorageInspection:
    """Read live formats and opaque recovery residues under project qualification."""
    prepared, publication_previews = _verified_publications(publications)
    if root is None:
        if ledger is not None:
            VersionStore.inspect_cas_references(ledger, prepared)
        return CasStorageInspection(
            False,
            0,
            0,
            0,
            0,
            0,
            sha256(b"scholarseed-cas-storage-absent-v1\0").hexdigest(),
            publication_previews,
        )
    reader = _Reader(root)
    root_names = reader.names((), 5)
    if root_names is not None and not set(root_names) <= {"cas", "staging", "trash", "writer.lock"}:
        raise ValueError("unsupported CAS storage entry")
    versions = reader.names(("cas",), 16)
    if versions is not None and any(version != "v1" for version in versions):
        raise ValueError("unsupported CAS storage version")
    kinds = reader.names(("cas", "v1"), 3)
    if kinds is not None and not set(kinds) <= {"objects", "chunks"}:
        raise ValueError("unsupported CAS entry kind")
    for kind in kinds or ():
        if reader.names(("cas", "v1", kind), 2) != ("sha256",):
            raise ValueError("unsupported CAS digest algorithm")
    base = ("cas", "v1", "objects", "sha256")
    chunk_base = ("cas", "v1", "chunks", "sha256")
    objects = _inventory(reader, base)
    chunks = _inventory(reader, chunk_base)
    if len(objects or ()) + len(prepared) > MAX_OBJECTS:
        raise ValueError("CAS storage and recovery exceed object budget")
    chunk_names = frozenset(chunks or ())
    descriptors = {}

    def read_chunk(identifier: str) -> bytes:
        return _read_chunk(reader, identifier, known=chunk_names)

    # Include orphan chunks: a prior interrupted publication can leave them
    # outside every manifest, but the next runtime may still reuse or collect them.
    for value in chunks or ():
        read_chunk("sha256:" + value)
    for name in objects or ():
        descriptor = _read_object(reader, "sha256:" + name, read_chunk)
        if descriptor.object_id in prepared:
            raise ValueError("CAS recovery would replace an existing object")
        if ledger is not None:
            descriptors[descriptor.object_id] = descriptor
    if ledger is not None:
        descriptors.update(prepared)
        VersionStore.inspect_cas_references(ledger, descriptors)
        reader.check()
    if _inventory(reader, base) != objects or _inventory(reader, chunk_base) != chunks:
        raise DomainChangedError("CAS inventory changed")
    if reader.names(("cas",), 16) != versions:
        raise DomainChangedError("CAS format inventory changed")
    if reader.names(("cas", "v1"), 3) != kinds:
        raise DomainChangedError("CAS kind inventory changed")
    staged = _residual(reader, "staging")
    trashed = _residual(reader, "trash")
    if root_names is not None and "writer.lock" in root_names:
        reader.read((), "writer.lock", MAX_METADATA_BYTES, retain=False)
    if reader.names((), 5) != root_names:
        raise DomainChangedError("CAS storage inventory changed")
    if reader.total + sum(preview.size for preview in publication_previews) > MAX_TOTAL_BYTES:
        raise ValueError("CAS storage and recovery exceed read budget")
    return CasStorageInspection(
        root_names is not None,
        len(objects or ()),
        len(chunks or ()),
        staged,
        trashed,
        reader.total,
        reader.hash.hexdigest(),
        publication_previews,
    )
