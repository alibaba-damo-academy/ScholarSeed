#!/usr/bin/env scholarseed-skill-python
"""Small, dependency-free I/O helpers shared by bundled modules."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise ValueError(f"input file does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def safe_filename(value: str) -> str:
    cleaned = "".join(char if char.isalnum() else "-" for char in value)
    return "-".join(part for part in cleaned.split("-") if part) or "paper"


def safe_title_stem(value: str, max_bytes: int = 220) -> str:
    """Return a readable, portable filename stem derived from a paper title."""
    normalized = " ".join(str(value).split()) or "Untitled"
    forbidden = {'<', '>', ':', '"', '/', '\\', '|', '?', '*'}
    cleaned = "".join(
        "-" if char in forbidden or ord(char) < 32 else char
        for char in normalized
    ).strip(" .")
    cleaned = cleaned or "Untitled"
    encoded = cleaned.encode("utf-8")
    if len(encoded) > max_bytes:
        encoded = encoded[:max_bytes]
        while True:
            try:
                cleaned = encoded.decode("utf-8").rstrip(" .")
                break
            except UnicodeDecodeError:
                encoded = encoded[:-1]
    cleaned = cleaned or "Untitled"
    # Windows device names remain reserved even before a file extension.
    head = cleaned.split(".", 1)[0].rstrip(" .").upper()
    if head in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} or (
        len(head) == 4 and head[:3] in {"COM", "LPT"} and head[3] in "123456789¹²³"
    ):
        cleaned = "_" + cleaned
    return cleaned


def title_pdf_relative_path(
    title: str,
    paper_id: str,
    occupied: set[str] | None = None,
    preferred: str | None = None,
) -> Path:
    """Choose a title-based path, adding a stable suffix only for collisions."""
    taken = {path.casefold() for path in (occupied or set())}
    papers_dir = Path("downloads/papers")
    if preferred:
        preferred_path = Path(preferred)
        if (
            preferred_path.parent == papers_dir
            and preferred_path.suffix.casefold() == ".pdf"
            and preferred_path.as_posix().casefold() not in taken
        ):
            return preferred_path

    stem = safe_title_stem(title)
    candidate = papers_dir / f"{stem}.pdf"
    if candidate.as_posix().casefold() not in taken:
        return candidate

    digest = hashlib.sha256(str(paper_id).encode("utf-8")).hexdigest()[:8]
    suffix = f" ({digest})"
    stem = safe_title_stem(title, max_bytes=220 - len(suffix.encode("utf-8")))
    candidate = papers_dir / f"{stem}{suffix}.pdf"
    counter = 2
    while candidate.as_posix().casefold() in taken:
        numbered_suffix = f" ({digest}-{counter})"
        numbered_stem = safe_title_stem(
            title, max_bytes=220 - len(numbered_suffix.encode("utf-8"))
        )
        candidate = papers_dir / f"{numbered_stem}{numbered_suffix}.pdf"
        counter += 1
    return candidate


def write_placeholder_pdf(path: Path, paper_id: str, title: str) -> None:
    """Write a tiny valid one-page PDF containing explicit placeholder text."""
    lines = [
        "PLACEHOLDER DOCUMENT - NOT A REAL PAPER FULL TEXT",
        f"Paper ID: {paper_id}",
        f"Title: {title}",
    ]

    def escape(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    stream_lines = ["BT", "/F1 10 Tf", "72 740 Td"]
    for index, line in enumerate(lines):
        if index:
            stream_lines.append("0 -18 Td")
        stream_lines.append(f"({escape(line)}) Tj")
    stream_lines.append("ET")
    stream = "\n".join(stream_lines).encode("ascii", errors="replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    payload = bytearray(b"%PDF-1.4\n% placeholder\n")
    offsets = [0]
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(payload))
        payload.extend(f"{number} 0 obj\n".encode("ascii"))
        payload.extend(obj)
        payload.extend(b"\nendobj\n")
    xref_offset = len(payload)
    payload.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    payload.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        payload.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    payload.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode(
            "ascii"
        )
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
