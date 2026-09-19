"""
Step 0: 加载输入数据 + 过滤待处理论文
"""
from __future__ import annotations

import os
import hashlib
from typing import Optional

from utils import _load_json, _build_title_index


def load_inputs(input_dir: str, output_dir: str, limit: Optional[int] = None) -> tuple[dict, dict, dict, dict, list]:
    """Load selected_paper, paper_info, existing cards; return pending list.

    Returns: (entity, paper_info, title_index, existing_cards, pending_papers)
    where pending_papers = [(paper_id, entity_entry), ...]
    """
    entity = _load_json(os.path.join(input_dir, "selected_paper.json"), {})
    paper_info = _load_json(os.path.join(input_dir, "paper_info.json"), {})
    title_index = _build_title_index(paper_info)
    existing_cards = _load_json(os.path.join(output_dir, "paper_cards.json"), {})
    from paper_materials import card_problem
    from task_contract import atomic_json
    from pathlib import Path
    # Archive stale evidence before a targeted re-extraction; do not attach old
    # sentence maps to a changed input.
    pending_papers = []
    for pid, ent in entity.items():
        problem = card_problem(pid, ent, paper_info.get(pid), existing_cards.get(pid))
        if problem:
            if pid in existing_cards:
                from task_contract import digest
                old = existing_cards.pop(pid)
                atomic_json(Path(output_dir)/'_history'/pid/(digest(old)+'.json'), old)
            pending_papers.append((pid, ent))
    if limit: pending_papers = pending_papers[:limit]

    return entity, paper_info, title_index, existing_cards, pending_papers
