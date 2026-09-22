"""service 通用工具 (utils) — 跨子包共享的小型纯函数。

当前: 文件路径 jail (safe_join / is_within / PathJailError) — viewer/附件等
所有对外暴露文件读取的面都必须经它防穿越。
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Iterable

from fastapi import HTTPException

MAX_DIRECTORY_ITEMS = 500
FILE_READ_MAX_BYTES = 512 * 1024
FILE_RAW_MAX_BYTES = 16 * 1024 * 1024
MEDIA_TYPE_OVERRIDES = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
}


class PathJailError(ValueError):
    """请求路径越出允许的根目录。"""


def guess_media_type(path: str | Path) -> str | None:
    """Return a stable product MIME before consulting the host registry."""

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


def list_directory(
    root: Path,
    path: str = "",
    *,
    hide_dotfiles: bool,
    hidden_names: Iterable[str] = (),
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
                size = 0 if child.is_dir() else child.stat().st_size
            except OSError:
                size = 0
            items.append({"name": child.name, "dir": child.is_dir(), "size": size})
    except OSError as error:
        raise HTTPException(status_code=403, detail="unreadable") from error
    relative = str(target.relative_to(canonical_root)) if target != canonical_root else ""
    crumbs = [part for part in relative.split("/") if part and part != "."]
    return {
        "root": str(canonical_root),
        "path": relative if relative != "." else "",
        "crumbs": crumbs,
        "items": items[:MAX_DIRECTORY_ITEMS],
    }


def read_file(root: Path, path: str) -> dict[str, Any]:
    """Read bounded UTF-8-compatible content below one canonical root."""

    target = resolve_child(root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    size = target.stat().st_size
    if size > FILE_READ_MAX_BYTES:
        return {"path": path, "size": size, "binary": False, "truncated": True, "content": ""}
    raw = target.read_bytes()
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
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    if target.stat().st_size > FILE_RAW_MAX_BYTES:
        raise HTTPException(status_code=413, detail="file too large for preview")
    media_type = guess_media_type(target.name)
    return target.read_bytes(), media_type or "application/octet-stream"


__all__ = [
    "FILE_RAW_MAX_BYTES",
    "FILE_READ_MAX_BYTES",
    "MEDIA_TYPE_OVERRIDES",
    "MAX_DIRECTORY_ITEMS",
    "PathJailError",
    "guess_media_type",
    "is_within",
    "list_directory",
    "read_file",
    "read_file_raw",
    "resolve_child",
    "safe_join",
]
