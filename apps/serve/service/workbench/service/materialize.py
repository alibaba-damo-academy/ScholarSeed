"""Fast PDF text materialization, deliberately separate from citation indexing."""

from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path, PurePosixPath

from service.platform.citations import CitationDocument, PdfMaterialization
from service.platform.pdf import PdfDocumentError, PdfPasswordError, pdf_document_text
from service.platform.storage import NOFOLLOW, canonical_root, open_directory

MATERIALIZER_VERSION = "pdfium-text-v2"
MAX_DOCUMENT_BYTES = 100_000_000
MAX_DOCUMENT_PAGES = 2_000
MAX_TEXT_BYTES = 16_000_000
MIN_TEXT_CHARACTERS = 32
PAGE_SEPARATOR = "\n\f\n"
TEXT_ENCODING = "utf-8"
TEXT_FILE_MODE = 0o600


def _target_parts(target: str) -> tuple[str, ...]:
    path = PurePosixPath(target)
    if (
        path.is_absolute()
        or not path.parts
        or ".." in path.parts
        or "\\" in target
        or path.suffix.casefold() != ".txt"
    ):
        raise ValueError("pdf_materialize_target_invalid")
    return path.parts


def _extract(document: CitationDocument) -> tuple[bytes, int]:
    if not document.payload:
        raise ValueError("pdf_materialize_source_unavailable")
    if len(document.payload) > MAX_DOCUMENT_BYTES:
        raise ValueError("pdf_materialize_source_too_large")
    try:
        pages = pdf_document_text(document.payload)
        if len(pages) > MAX_DOCUMENT_PAGES:
            raise ValueError("pdf_materialize_too_many_pages")
    except PdfPasswordError as error:
        raise ValueError("pdf_materialize_encrypted") from error
    except PdfDocumentError as error:
        raise ValueError("pdf_materialize_invalid_pdf") from error
    except ValueError:
        raise
    text = PAGE_SEPARATOR.join(page.rstrip("\n") for page in pages).strip()
    if len(text) < MIN_TEXT_CHARACTERS:
        raise ValueError("pdf_materialize_text_layer_missing")
    payload = (text + "\n").encode(TEXT_ENCODING)
    if len(payload) > MAX_TEXT_BYTES:
        raise ValueError("pdf_materialize_text_too_large")
    return payload, len(pages)


def _existing(directory, name: str, limit: int) -> bytes:
    descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW)
    with os.fdopen(descriptor, "rb") as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise ValueError("pdf_materialize_target_conflict")
        payload = handle.read(limit + 1)
    if len(payload) > limit:
        raise ValueError("pdf_materialize_target_conflict")
    return payload


def _write(root: Path, target: str, payload: bytes) -> bool:
    parts = _target_parts(target)
    directory = open_directory(canonical_root(root), parts[:-1], create=True)
    descriptor = None
    created = False
    try:
        try:
            descriptor = directory.open(
                parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, TEXT_FILE_MODE
            )
            created = True
        except FileExistsError:
            if _existing(directory, parts[-1], len(payload)) != payload:
                raise ValueError("pdf_materialize_target_conflict")
            return True
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        directory.sync()
        return False
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        if created:
            try:
                directory.unlink(parts[-1])
            except FileNotFoundError:
                pass
        raise
    finally:
        directory.close()


class PdfMaterializer:
    def prepare(self, document: CitationDocument) -> PdfMaterialization:
        payload, page_count = _extract(document)
        return PdfMaterialization(
            payload=payload,
            revision=document.revision,
            page_count=page_count,
            digest=hashlib.sha256(payload).hexdigest(),
        )

    def publish(self, prepared: PdfMaterialization, root: Path, target: str) -> dict:
        reused = _write(root, target, prepared.payload)
        return {
            "ok": True,
            "state": "ready",
            "target": target,
            "revision": prepared.revision,
            "materializer_version": MATERIALIZER_VERSION,
            "page_count": prepared.page_count,
            "text_bytes": len(prepared.payload),
            "digest": prepared.digest,
            "reused": reused,
        }

    def materialize(self, document: CitationDocument, root: Path, target: str) -> dict:
        return self.publish(self.prepare(document), root, target)
