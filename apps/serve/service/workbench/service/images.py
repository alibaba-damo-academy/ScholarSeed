"""Durable Markdown sidecars through the content boundary."""

from __future__ import annotations

import mimetypes
from pathlib import PurePosixPath
from uuid import uuid4

from service.content.domain.model import ContentError
from service.content.service.port import ContentService
from service.workbench.domain.model import ViewerKind, viewer_for

ASSET_DIRECTORY = ".assert"
IMAGE_DIRECTORY = "img"
IMAGE_MEDIA_PREFIX = "image/"
EMPTY_IMAGE = b""


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
