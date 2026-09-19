"""Shared, model-independent writing scope and input identity.

The original outline is never overwritten when publishing selected chapters.
Every generation stage uses the same effective view through load_outline().
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path


def digest(value) -> str:
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def section_label(section_id: str) -> str:
    """One label spelling shared by prompts, normalization and publication."""
    return 'sec:s' + section_id.replace('.', '_')


from task_contract import validate_request, read_request, structural_contract, publication_view


def select_outline(outline: dict, request: dict) -> dict:
    result = copy.deepcopy(outline)
    tree = result.get("outline_tree") or []
    seen = set()
    assets = set()
    for section in tree:
        for node in [section, *(section.get("subsections") or [])]:
            sid = node.get("section_id")
            if not isinstance(sid, str) or not re.fullmatch(r"\d+(?:\.\d+)*", sid) or sid in seen:
                raise ValueError("outline section IDs must be unique numeric paths")
            seen.add(sid)
            for kind, prefix in (("figures", "F"), ("tables", "T")):
                field = "figure_id" if kind == "figures" else "table_id"
                for asset in node.get(kind, []):
                    aid = asset.get(field)
                    if not isinstance(aid, str) or not re.fullmatch(prefix + r"\d+", aid) or aid in assets:
                        raise ValueError("asset IDs must be unique F1/T1-style identifiers")
                    assets.add(aid)
    known = {str(s["section_id"]) for s in tree}
    ids = request["selected_section_ids"]
    if set(ids) - known:
        raise ValueError(f"unknown top-level section IDs: {sorted(set(ids) - known)}")
    if set(request["section_instructions"]) - known:
        raise ValueError("section_instructions contains unknown top-level section IDs")
    if ids:
        result["outline_tree"] = [s for s in tree if str(s["section_id"]) in ids]
    return result


def load_outline(workspace: Path) -> dict:
    workspace = Path(workspace)
    outline = json.loads((workspace / "04_outline/outline.json").read_text())
    selected = select_outline(outline, read_request(workspace))
    derived = workspace / "05_generation/_internal/manuscript_outline.json"
    if derived.exists():
        view = json.loads(derived.read_text())
        if view.get("outline") != selected:
            raise ValueError("manuscript plan is stale; rerun manuscript prepare")
        return select_outline(view["outline"], read_request(workspace))
    return selected


def approval_snapshot(workspace):
    request=read_request(workspace)
    original=json.loads((Path(workspace)/'04_outline/outline.json').read_text())
    return {'outline':select_outline(original,request),
            'request':{k:v for k,v in request.items() if k not in ('stage_instructions','publication')},
            'publication':publication_view(request)}


def preparation_identity(workspace: Path) -> str:
    """Detect stale packets after evidence, instructions, or dialect changes."""
    files = ["01_input/writing_request.json",
             "02_retrieval/selected_paper.json", "02_retrieval/paper_info.json",
             "03_process/source_maps.json", "03_process/paper_cards.json",
             "03_process/cite_keys.json"]
    from task_contract import CONTRACT_VERSION
    return digest({"contract_version":CONTRACT_VERSION, "plan": digest(approval_snapshot(workspace)), "sources": {
        rel: digest((Path(workspace) / rel).read_text())
        if (Path(workspace) / rel).exists() else None for rel in files}})


def require_approval(workspace: Path) -> None:
    if read_request(workspace)["outline_review"] != "required":
        return
    p = Path(workspace) / "04_outline/approval.json"
    if not p.exists() or not json.loads(p.read_text()).get("user_response") or json.loads(p.read_text()).get("snapshot") != approval_snapshot(workspace):
        raise ValueError("outline review required: show the current outline to the user, then record their approval with slr writing approve")


def explicit_length_budget(workspace: Path, language: str = "english") -> dict:
    """Only user-specified bounds; never infer words from corpus size or a band."""
    ws = Path(workspace)
    request = read_request(ws)
    out = {}
    supplied = {k: request["length_" + k] for k in ("target", "min", "max") if "length_" + k in request}
    if supplied:
        if out.get("unit") and out["unit"] != ("cjk_chars" if language == "chinese" else "words"):
            out = {}
        out.update(supplied)
        out.update(unit=request.get("length_unit", "cjk_chars" if language == "chinese" else "words"), source="user")
    if out.get("min", 0) > out.get("max", float("inf")):
        raise ValueError("explicit minimum length exceeds maximum")
    return out
