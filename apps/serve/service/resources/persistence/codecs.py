"""WHOLE object codecs for the resource version CAS."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import zstandard

ZSTD_LEVEL = 3
ZSTD_MIN_INPUT_BYTES = 64 * 1024
ZSTD_MIN_SAVING_RATIO = 0.08


class WholeCodec(str, Enum):
    """Published WHOLE payload encodings."""

    IDENTITY = "IDENTITY"
    ZSTD = "ZSTD"


@dataclass(frozen=True)
class EncodedPayload:
    """One evaluated WHOLE representation."""

    codec: WholeCodec
    payload: bytes


def encode_whole(raw: bytes) -> EncodedPayload:
    """Choose identity or Zstandard from measured encoded size."""

    if len(raw) < ZSTD_MIN_INPUT_BYTES:
        return EncodedPayload(WholeCodec.IDENTITY, raw)
    compressed = zstandard.ZstdCompressor(level=ZSTD_LEVEL).compress(raw)
    saving_ratio = 1.0 - (len(compressed) / len(raw)) if raw else 0.0
    if saving_ratio < ZSTD_MIN_SAVING_RATIO:
        return EncodedPayload(WholeCodec.IDENTITY, raw)
    return EncodedPayload(WholeCodec.ZSTD, compressed)


def decode_whole(payload: bytes, codec: WholeCodec, raw_size: int) -> bytes:
    """Decode a WHOLE payload with a strict output-size bound."""

    if codec is WholeCodec.IDENTITY:
        return payload
    return zstandard.ZstdDecompressor().decompress(payload, max_output_size=raw_size)


__all__ = [
    "EncodedPayload",
    "WholeCodec",
    "ZSTD_LEVEL",
    "ZSTD_MIN_INPUT_BYTES",
    "ZSTD_MIN_SAVING_RATIO",
    "decode_whole",
    "encode_whole",
]
