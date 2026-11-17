"""
Step 0: 加载输入数据 + 过滤待处理论文
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from reading import PROCESSING, RETRIEVAL, import_assets, validation_context
from paper_materials import card_problem

from utils import _load_json, _build_title_index


def load_inputs(input_dir: str, output_dir: str, limit: Optional[int] = None) -> tuple[dict, dict, dict, dict, list]:
    """Load selected_paper, paper_info, existing cards; return pending list.

    Returns: (entity, paper_info, title_index, existing_cards, pending_papers)
    where pending_papers = [(paper_id, entity_entry), ...]
    """
    input_path = Path(input_dir).resolve()
    workspace = input_path.parent
    # Reuse is bound to the review's standard stores; standalone/custom input
    # and output directories retain their existing processing contract.
    if input_path.name == RETRIEVAL and Path(output_dir).resolve() == workspace / PROCESSING:
        import_assets(workspace)
    entity = _load_json(os.path.join(input_dir, "selected_paper.json"), {})
    paper_info = _load_json(os.path.join(input_dir, "paper_info.json"), {})
    title_index = _build_title_index(paper_info)
    existing_cards = _load_json(os.path.join(output_dir, "paper_cards.json"), {})
    # Archive stale evidence before a targeted re-extraction; do not attach old
    # sentence maps to a changed input.
    reading_context = validation_context(workspace)
    pending_papers = []
    for pid, ent in entity.items():
        problem = card_problem(pid, ent, paper_info.get(pid), existing_cards.get(pid), workspace, reading_context)
        if problem:
            pending_papers.append((pid, ent))
    if limit:
        pending_papers = pending_papers[:limit]

    return entity, paper_info, title_index, existing_cards, pending_papers
