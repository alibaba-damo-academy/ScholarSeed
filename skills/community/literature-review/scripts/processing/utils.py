"""
通用工具 — JSON IO、路径解析、title 索引
"""
from __future__ import annotations

import json
import os
import tempfile

from config import PROJECT_ROOT


def _load_json(path: str, default=None):
    if not os.path.exists(path):
        return default if default is not None else {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default if default is not None else {}


def _atomic_write_json(path: str, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=".tmp_", suffix=".json", dir=os.path.dirname(path) or "."
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def _resolve_folder(folder_name: str) -> str:
    """Resolve folder argument to absolute path.

    Accepts:
      - Absolute path to existing directory
      - Relative path from PROJECT_ROOT (e.g. 'LLM_Autoresearch')
    """
    if os.path.isabs(folder_name) and os.path.isdir(folder_name):
        return folder_name
    candidate = os.path.join(str(PROJECT_ROOT), folder_name)
    if os.path.isdir(candidate):
        return candidate
    raise FileNotFoundError(
        f"Folder not found: tried '{folder_name}' and '{candidate}'"
    )


def _resolve_input_dir(folder_path: str) -> str:
    """Resolve input directory: ./folder/02_retrieval/"""
    input_dir = os.path.join(folder_path, "02_retrieval")
    if not os.path.isdir(input_dir):
        raise FileNotFoundError(
            f"Input dir not found: {input_dir}\n"
            f"Expected structure: {folder_path}/02_retrieval/selected_paper.json"
        )
    return input_dir


def _resolve_output_dir(args, folder_path: str) -> str:
    """Resolve output directory: --output-dir if specified, else ./folder/03_process/"""
    output_dir = getattr(args, "output_dir", None)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        return os.path.abspath(output_dir)
    default_output = os.path.join(folder_path, "03_process")
    os.makedirs(default_output, exist_ok=True)
    return default_output


def _build_title_index(paper_info: dict) -> dict:
    """Build normalized_title -> paper_info_key index for title fallback."""
    title_to_key = {}
    for key, value in paper_info.items():
        if not isinstance(value, dict):
            continue
        title = value.get("title", "").strip().lower()
        if title:
            title_to_key[title] = key
    return title_to_key


def _lookup_paper_info(paper_info: dict, title_index: dict, paper_id: str, title: str = "") -> dict:
    """Lookup paper in paper_info by ID, fallback by title."""
    info = paper_info.get(paper_id)
    if info is not None:
        return info
    if title:
        normalized_title = title.strip().lower()
        matched_key = title_index.get(normalized_title)
        if matched_key:
            return paper_info[matched_key]
    return {}
