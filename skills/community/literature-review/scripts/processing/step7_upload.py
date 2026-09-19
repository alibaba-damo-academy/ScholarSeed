"""
Step 7: 上传结果到 ES Server
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import asyncio
import json
import logging
import os
import subprocess
from typing import Optional


UPLOAD_BASE_URL = _slr_paths.endpoints()["upload_base"]


def _patch_paper_id(entry: Optional[dict], arxiv_id: str) -> Optional[dict]:
    """Shallow-copy entry and replace paperId with arxiv_id for upload."""
    if entry is None:
        return None
    patched = dict(entry)
    patched["paperId"] = arxiv_id
    return patched


async def _upload_paper_info(
    arxiv_id: str,
    card_entry: Optional[dict],
    delta_entry: Optional[dict],
    source_map_entry: Optional[dict],
    ideation_entry: Optional[dict],
) -> None:
    """Upload paper info to the explicitly configured service."""

    if not UPLOAD_BASE_URL:
        raise ValueError("Paper-card upload requires an explicit UPLOAD_BASE_URL")

    url = f"{UPLOAD_BASE_URL}/es/{arxiv_id}/upload_info"
    payload = {
        "paper_card": _patch_paper_id(card_entry, arxiv_id),
        "delta": _patch_paper_id(delta_entry, arxiv_id),
        "source_mapping": _patch_paper_id(source_map_entry, arxiv_id),
        "ideation": _patch_paper_id(ideation_entry, arxiv_id),
    }
    payload_json = json.dumps(payload, ensure_ascii=False)
    try:
        proc = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: subprocess.run(
                ["curl", "-s", "-X", "POST", url,
                 "-H", "Content-Type: application/json",
                 "-d", payload_json],
                capture_output=True, text=True, timeout=60,
            ),
        )
        if proc.returncode == 0 and proc.stdout:
            resp_data = json.loads(proc.stdout)
            if resp_data.get("code") == 0:
                saved = resp_data.get("data", {}).get("saved", [])
                logging.info(f"[UPLOAD] {arxiv_id}: saved={saved}")
            else:
                logging.warning(f"[UPLOAD_FAIL] {arxiv_id}: {proc.stdout[:200]}")
        else:
            detail = proc.stderr[:200] if proc.stderr else f"exit_code={proc.returncode}"
            logging.warning(f"[UPLOAD_FAIL] {arxiv_id}: {detail}")
    except Exception as exc:
        logging.warning(f"[UPLOAD_FAIL] {arxiv_id}: {type(exc).__name__}: {exc}")
