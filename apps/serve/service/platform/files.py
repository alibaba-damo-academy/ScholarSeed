"""service 通用工具 (utils) — 跨子包共享的小型纯函数。

当前: 文件路径 jail (safe_join / is_within / PathJailError) — viewer/附件等
所有对外暴露文件读取的面都必须经它防穿越。
"""

from __future__ import annotations

import errno
import logging
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, NoReturn

from fastapi import HTTPException
from starlette.status import HTTP_403_FORBIDDEN, HTTP_503_SERVICE_UNAVAILABLE

MAX_DIRECTORY_ITEMS = 500
FILE_READ_MAX_BYTES = 512 * 1024
FILE_RAW_MAX_BYTES = 16 * 1024 * 1024
MEDIA_TYPE_OVERRIDES = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
FILE_ACCESS_DENIED = "file_access_denied"
FILE_ACCESS_FAILED = "file_access_failed"
WINDOWS_ACCESS_DENIED = 5
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ContentFileFormat:
    """Registered signature hints and canonical export suffixes, not file validation."""

    media_type: str
    suffixes: tuple[str, ...]
    signatures: tuple[bytes, ...]


CONTENT_FILE_FORMATS = (ContentFileFormat("application/pdf", (".pdf",), (b"%PDF-",)),)
CONTENT_SNIFF_BYTES = max(
    len(signature) for registration in CONTENT_FILE_FORMATS for signature in registration.signatures
)


def content_file_format(prefix: bytes) -> ContentFileFormat | None:
    """Identify only explicitly registered binary signatures."""

    return next(
        (
            registration
            for registration in CONTENT_FILE_FORMATS
            if any(prefix.startswith(signature) for signature in registration.signatures)
        ),
        None,
    )


def export_file_name(name: str, media_type: str | None, payload: bytes) -> str:
    """Normalize one export basename without changing source or unknown file types."""

    if not name.strip() or name.strip() in {".", ".."} or "/" in name or "\\" in name:
        return name
    detected = content_file_format(payload[:CONTENT_SNIFF_BYTES])
    normalized_type = (media_type or "").split(";", 1)[0].strip().lower()
    registration = detected or next(
        (entry for entry in CONTENT_FILE_FORMATS if entry.media_type == normalized_type), None
    )
    if registration is None:
        return name
    suffix = Path(name).suffix
    if suffix.lower() in registration.suffixes:
        return name
    stem = name[: -len(suffix)] if suffix and guess_media_type(name) else name
    return stem + registration.suffixes[0]


class PathJailError(ValueError):
    """请求路径越出允许的根目录。"""


def file_access_code(error: OSError) -> str:
    """Classify one host filesystem failure without exposing platform details."""

    if (
        isinstance(error, PermissionError)
        or error.errno in {errno.EACCES, errno.EPERM}
        or getattr(error, "winerror", None) == WINDOWS_ACCESS_DENIED
    ):
        return FILE_ACCESS_DENIED
    return FILE_ACCESS_FAILED


def _raise_file_access_error(operation: str, path: str, error: OSError) -> NoReturn:
    code = file_access_code(error)
    diagnostic_path = Path(path).name if Path(path).is_absolute() else path
    LOGGER.warning(
        "file_access_failed operation=%s path=%s code=%s errno=%s winerror=%s",
        operation,
        diagnostic_path,
        code,
        error.errno,
        getattr(error, "winerror", None),
    )
    status = HTTP_403_FORBIDDEN if code == FILE_ACCESS_DENIED else HTTP_503_SERVICE_UNAVAILABLE
    raise HTTPException(status_code=status, detail=code) from error


def guess_media_type(path: str | Path, prefix: bytes = b"") -> str | None:
    """Prefer registered content signatures, then product suffixes and the host registry."""

    detected = content_file_format(prefix[:CONTENT_SNIFF_BYTES])
    if detected is not None:
        return detected.media_type
    suffix = Path(path).suffix.lower()
    return MEDIA_TYPE_OVERRIDES.get(suffix) or mimetypes.guess_type(str(path))[0]


def safe_join(root: Path, rel: str) -> Path:
    """把用户给的相对路径 rel 安全拼到 root 下; 越界抛 PathJailError。

    - 解析 symlink + .. 后必须仍在 root 真实路径之内。
    - 拒绝绝对路径参数 (必须相对 root)。
    """
    root_real = Path(root).resolve()
    rel = (rel or "").strip()
    if rel.startswith("/") or rel.startswith("\\"):
        raise PathJailError(f"absolute path not allowed: {rel!r}")
    candidate = (root_real / rel).resolve()
    try:
        candidate.relative_to(root_real)
    except ValueError:
        raise PathJailError(f"path escapes root: {rel!r}")
    return candidate


def is_within(root: Path, target: Path) -> bool:
    try:
        Path(target).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def resolve_child(root: Path, path: str) -> Path:
    """Resolve one public relative path under its canonical authorization root."""

    try:
        return safe_join(root, path or ".")
    except PathJailError as error:
        raise HTTPException(status_code=400, detail="path escapes root") from error
    except OSError as error:
        _raise_file_access_error("resolve", path, error)


def list_directory(
    root: Path,
    path: str = "",
    *,
    hide_dotfiles: bool,
    hidden_names: Iterable[str] = (),
    offset: int = 0,
) -> dict[str, Any]:
    """List a bounded directory page without following a path outside ``root``."""

    canonical_root = root.expanduser().resolve()
    target = resolve_child(canonical_root, path or ".")
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="not a directory")
    hidden = set(hidden_names)
    items: list[dict[str, Any]] = []
    try:
        for child in sorted(
            target.iterdir(), key=lambda value: (not value.is_dir(), value.name.lower())
        ):
            if (hide_dotfiles and child.name.startswith(".")) or child.name in hidden:
                continue
            try:
                metadata = child.stat()
                size = 0 if child.is_dir() else metadata.st_size
                updated_at = metadata.st_mtime
            except OSError:
                size = 0
                updated_at = None
            items.append(
                {"name": child.name, "dir": child.is_dir(), "size": size, "updated_at": updated_at}
            )
    except OSError as error:
        raise HTTPException(status_code=403, detail="unreadable") from error
    relative = target.relative_to(canonical_root).as_posix() if target != canonical_root else ""
    crumbs = [part for part in relative.split("/") if part and part != "."]
    return {
        "root": str(canonical_root),
        "path": relative if relative != "." else "",
        "crumbs": crumbs,
        "items": items[offset : offset + MAX_DIRECTORY_ITEMS],
        "offset": offset,
        "total": len(items),
    }


def read_file(root: Path, path: str) -> dict[str, Any]:
    """Read bounded UTF-8-compatible content below one canonical root."""

    target = resolve_child(root, path)
    try:
        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail="not a file")
        size = target.stat().st_size
        if size > FILE_READ_MAX_BYTES:
            return {
                "path": path,
                "size": size,
                "binary": False,
                "truncated": True,
                "content": "",
            }
        raw = target.read_bytes()
    except HTTPException:
        raise
    except OSError as error:
        _raise_file_access_error("read", path, error)
    if b"\x00" in raw[:4096]:
        return {"path": path, "size": size, "binary": True, "truncated": False, "content": ""}
    return {
        "path": path,
        "size": size,
        "binary": False,
        "truncated": False,
        "content": raw.decode("utf-8", errors="replace"),
    }


def read_file_raw(root: Path, path: str) -> tuple[bytes, str]:
    """Read bounded raw bytes below one canonical root for in-product preview."""

    target = resolve_child(root, path)
    try:
        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail="not a file")
        if target.stat().st_size > FILE_RAW_MAX_BYTES:
            raise HTTPException(status_code=413, detail="file too large for preview")
        media_type = guess_media_type(target.name)
        return target.read_bytes(), media_type or "application/octet-stream"
    except HTTPException:
        raise
    except OSError as error:
        _raise_file_access_error("read_raw", path, error)


__all__ = [
    "CONTENT_SNIFF_BYTES",
    "FILE_RAW_MAX_BYTES",
    "FILE_READ_MAX_BYTES",
    "FILE_ACCESS_DENIED",
    "FILE_ACCESS_FAILED",
    "MEDIA_TYPE_OVERRIDES",
    "MAX_DIRECTORY_ITEMS",
    "PathJailError",
    "guess_media_type",
    "export_file_name",
    "file_access_code",
    "is_within",
    "list_directory",
    "read_file",
    "read_file_raw",
    "resolve_child",
    "safe_join",
]
