"""Pure literature naming rules shared by delivery and its consumers."""

from __future__ import annotations

import re

FILENAME_CHARS = 100
SAFE_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
SAFE_ID = re.compile(r"[^\w.-]")
PDF_SUFFIX = ".pdf"


def paper_filename(paper: dict) -> str:
    title = SAFE_FILENAME.sub("_", paper["title"]).strip(" .")[:FILENAME_CHARS]
    identity = SAFE_ID.sub("_", paper["paper_id"])[:FILENAME_CHARS]
    return f"{title or identity} [{identity}]{PDF_SUFFIX}"
