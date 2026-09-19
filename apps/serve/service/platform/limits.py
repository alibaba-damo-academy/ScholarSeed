"""Shared service-edge request and attachment limits."""

ATTACHMENT_MAX_BYTES: int = 20 * 1024 * 1024
UPLOAD_CHUNK_BYTES: int = 64 * 1024

__all__ = ["ATTACHMENT_MAX_BYTES", "UPLOAD_CHUNK_BYTES"]
