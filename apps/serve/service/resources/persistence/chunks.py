"""Versioned FastCDC profile and immutable chunk descriptions."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

from fastcdc import fastcdc  # type: ignore[import-untyped]

CHUNKER_PROFILE = "fastcdc-v1"
CHUNK_MIN_BYTES = 256 * 1024
CHUNK_AVG_BYTES = 1024 * 1024
CHUNK_MAX_BYTES = 4 * 1024 * 1024
DIGEST_PREFIX = "sha256:"


@dataclass(frozen=True)
class ChunkRef:
    """One ordered raw chunk in a CHUNKED object manifest."""

    ordinal: int
    chunk_id: str
    raw_offset: int
    raw_size_bytes: int


def digest(payload: bytes) -> str:
    """Return the canonical raw-byte SHA-256 identifier."""

    return f"{DIGEST_PREFIX}{sha256(payload).hexdigest()}"


def split(raw: bytes) -> tuple[tuple[ChunkRef, bytes], ...]:
    """Split bytes with the immutable FastCDC v1 parameters."""

    chunks: list[tuple[ChunkRef, bytes]] = []
    for ordinal, chunk in enumerate(
        fastcdc(
            raw,
            min_size=CHUNK_MIN_BYTES,
            avg_size=CHUNK_AVG_BYTES,
            max_size=CHUNK_MAX_BYTES,
        )
    ):
        payload = raw[chunk.offset : chunk.offset + chunk.length]
        chunks.append(
            (
                ChunkRef(
                    ordinal=ordinal,
                    chunk_id=digest(payload),
                    raw_offset=chunk.offset,
                    raw_size_bytes=chunk.length,
                ),
                payload,
            )
        )
    return tuple(chunks)


__all__ = [
    "CHUNKER_PROFILE",
    "CHUNK_AVG_BYTES",
    "CHUNK_MAX_BYTES",
    "CHUNK_MIN_BYTES",
    "ChunkRef",
    "digest",
    "split",
]
