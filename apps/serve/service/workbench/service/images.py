"""Durable Markdown sidecars and leased Office images through the content boundary."""

from __future__ import annotations

import mimetypes
from hashlib import sha256
from io import BytesIO
from pathlib import PurePosixPath
from uuid import UUID, uuid4

from PIL import Image, UnidentifiedImageError

from service.content.domain.model import ContentError
from service.content.service.port import ContentService
from service.workbench.domain.model import ViewerKind, viewer_for

ASSET_DIRECTORY = ".assert"
IMAGE_DIRECTORY = "img"
IMAGE_MEDIA_PREFIX = "image/"
EMPTY_IMAGE = b""
TEMP_IMAGE_DIRECTORY = "tmp-img"
OFFICE_IMAGE_SUFFIX = ".png"
OFFICE_IMAGE_MEDIA = "image/png"
OFFICE_IMAGE_SIGNATURE = b"\x89PNG\r\n\x1a\n"
OFFICE_IMAGE_MAX_BYTES = 32 * 1024 * 1024
OFFICE_IMAGE_MAX_PIXELS = 40_000_000
OFFICE_IMAGE_FORMAT = "PNG"
OFFICE_DOCUMENT_SUFFIX = ".docx"
INVALID_IMAGE = "invalid_image"
INVALID_DOCUMENT = "invalid_document"


def _office_image_path(path: str, lease: str) -> PurePosixPath:
    document = PurePosixPath(path)
    if document.suffix.lower() != OFFICE_DOCUMENT_SUFFIX:
        raise ContentError(INVALID_DOCUMENT)
    try:
        if UUID(lease).hex != lease:
            raise ValueError(lease)
    except ValueError as exc:
        raise ContentError(INVALID_IMAGE) from exc
    document_key = sha256(document.name.encode()).hexdigest()
    return (
        document.parent
        / ASSET_DIRECTORY
        / TEMP_IMAGE_DIRECTORY
        / document_key
        / f"{lease}{OFFICE_IMAGE_SUFFIX}"
    )


def stage_office_image(
    content: ContentService, project: str, path: str, payload: bytes, media_type: str
) -> dict[str, str]:
    """Stage one normalized PNG; the receipt only authorizes its exact CAS cleanup."""
    content.snapshot(project, path)
    if len(payload) > OFFICE_IMAGE_MAX_BYTES:
        raise ContentError("file_too_large")
    if media_type != OFFICE_IMAGE_MEDIA or not payload.startswith(OFFICE_IMAGE_SIGNATURE):
        raise ContentError(INVALID_IMAGE)
    try:
        with Image.open(BytesIO(payload)) as image:
            if (
                image.format != OFFICE_IMAGE_FORMAT
                or image.width * image.height > OFFICE_IMAGE_MAX_PIXELS
            ):
                raise ContentError(INVALID_IMAGE)
            image.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ContentError(INVALID_IMAGE) from exc
    lease = uuid4().hex
    target = str(_office_image_path(path, lease))
    content.commit_optional_bytes(
        project, target, payload, content.revision(EMPTY_IMAGE), EMPTY_IMAGE
    )
    return {"lease": lease, "path": target, "revision": content.revision(payload)}


def release_office_image(
    content: ContentService, project: str, path: str, lease: str, revision: str
) -> None:
    """Never accept a deletion path from a renderer or remove a directory."""
    content.delete_bytes(project, str(_office_image_path(path, lease)), revision)


def persist_image(
    content: ContentService, project: str, path: str, payload: bytes, media_type: str
) -> str:
    """Return a document-relative path only after atomic persistence succeeds."""
    content.snapshot(project, path)
    if viewer_for(path) != ViewerKind.MARKDOWN:
        raise ContentError("invalid_document")
    extension = mimetypes.guess_extension(media_type)
    if not media_type.startswith(IMAGE_MEDIA_PREFIX) or not extension or not payload:
        raise ContentError("invalid_image")
    document = PurePosixPath(path)
    relative = PurePosixPath(
        ASSET_DIRECTORY, document.name, IMAGE_DIRECTORY, f"{uuid4().hex}{extension}"
    )
    content.commit_optional_bytes(
        project,
        str(document.parent / relative),
        payload,
        content.revision(EMPTY_IMAGE),
        EMPTY_IMAGE,
    )
    return str(relative)
