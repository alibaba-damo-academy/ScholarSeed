from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

from .pdf import PDFDocument, render_page as render_pdf_page
from PIL import Image


COORDINATE_SPACE = "paddle_page_pixels_top_left"


def source_lines(text):
    """Split frozen source on LF only; PDF control glyphs are not new lines."""
    if not text:return []
    return text.removesuffix('\n').split('\n')


class ConverterError(RuntimeError):
    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_pdf(value: str, cwd: Path) -> Path:
    raw = Path(value).expanduser()
    path = (raw if raw.is_absolute() else cwd / raw).resolve()
    if not path.is_file():
        raise ConverterError("input_not_found", "PDF input does not exist.", path=str(path))
    try:
        with PDFDocument(path) as document:
            if len(document) < 1:
                raise ConverterError("invalid_pdf", "PDF has no pages.")
    except ConverterError:
        raise
    except Exception as exc:
        raise ConverterError("invalid_pdf", f"Cannot decode PDF: {exc}") from exc
    return path


def bbox(value: Sequence[float]) -> list[float]:
    if len(value) != 4:
        raise ConverterError("invalid_bbox", "Expected four bbox coordinates.")
    result = [float(item) for item in value]
    if not all(math.isfinite(item) for item in result) or result[2] <= result[0] or result[3] <= result[1]:
        raise ConverterError("invalid_bbox", "BBox is empty or non-finite.", bbox=result)
    return result


def normalized_bbox(box: Sequence[float], width: int, height: int) -> list[float]:
    return [box[0] / width, box[1] / height, box[2] / width, box[3] / height]


def render_page(pdf: Path, page_number: int, width: int, height: int) -> Image.Image:
    with PDFDocument(pdf) as document:
        page=document[page_number-1]
        image=render_pdf_page(pdf,page_number-1,scale=max(width/page.rect.width,height/page.rect.height))
    if image.size != (width, height):
        if abs(image.width - width) > 1 or abs(image.height - height) > 1:
            raise ConverterError("render_mismatch", "Rendered page dimensions differ from Paddle layout.", expected=[width, height], actual=list(image.size))
        canvas = Image.new("RGB", (width, height), "white")
        canvas.paste(image.crop((0, 0, min(width, image.width), min(height, image.height))), (0, 0))
        image = canvas
    return image


def crop_box(box: Sequence[float], width: int, height: int) -> tuple[int, int, int, int]:
    return max(0, math.floor(box[0])), max(0, math.floor(box[1])), min(width, math.ceil(box[2])), min(height, math.ceil(box[3]))


def compile_latex(document: str, output_dir: Path, basename: str) -> dict[str, Any]:
    source = output_dir / f"{basename}.tex"
    source.write_text(document, encoding="utf-8")
    command = ["lualatex", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", source.name]
    try:
        result = subprocess.run(command, cwd=output_dir, text=True, capture_output=True, timeout=60, check=False)
    except FileNotFoundError:
        return {"status": "unavailable", "reason": "lualatex_not_found", "command": command}
    except subprocess.TimeoutExpired:
        return {"status": "failed", "reason": "timeout", "command": command}
    log = output_dir / "compile.log"
    log.write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
    pdf = output_dir / f"{basename}.pdf"
    for suffix in (".aux", ".log"):
        intermediate = output_dir / f"{basename}{suffix}"
        if intermediate.is_file():
            intermediate.unlink()
    return {
        "status": "passed" if result.returncode == 0 and pdf.is_file() else "failed",
        "exit_code": result.returncode,
        "command": command,
        "shell_escape": False,
        "log": log.name,
        "pdf": pdf.name if pdf.is_file() else None,
    }


def strip_math_markers(value: str) -> str:
    value = value.strip()
    pairs = (("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"), ("$", "$"))
    for left, right in pairs:
        if value.startswith(left) and value.endswith(right) and len(value) >= len(left) + len(right):
            return value[len(left):-len(right)].strip()
    return value


def safe_key(value: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-")


def artifact(path: Path, root: Path) -> dict[str, Any]:
    return {"path": path.relative_to(root).as_posix(), "sha256": sha256_file(path), "bytes": path.stat().st_size}
