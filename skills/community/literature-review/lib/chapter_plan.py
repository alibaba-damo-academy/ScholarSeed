"""Independent analytical chapter jobs with direct evidence assignments."""

from __future__ import annotations

import copy
import json

from authoring import abstract_card, authoring_card

ROLES = {
    "foundation",
    "background",
    "introduction",
    "analysis",
    "synthesis",
    "conclusion",
    "abstract",
    "component",
}
GLOBAL_EVIDENCE_ROLES = frozenset(("synthesis", "conclusion", "abstract"))
RETIRED_FIELDS = frozenset(
    ("prerequisites", "requires", "depends_on", "owner_section_id", "dependencies")
)
KINDS = {"explain", "compare", "formalize", "assess", "synthesize"}


def compile_plan(outline, available):
    chapters = outline.get("outline_tree", [])
    nodes = [("outline", outline)]
    for index, node in enumerate(chapters):
        nodes.append((str(index), node))
        nodes.extend(
            (str(index) + "." + str(child_index), child)
            for child_index, child in enumerate(node.get("subsections", []))
        )
    for location, node in nodes:
        retired = set(node) & RETIRED_FIELDS
        if retired:
            raise ValueError(
                location
                + ": retired outline fields: "
                + ", ".join(sorted(retired))
                + "; use descriptions, analysis_tasks and direct paper_ids"
            )
    if not chapters:
        chapters = [
            {
                "section_id": "component",
                "title": outline.get("survey_title", ""),
                "description": outline.get("description", ""),
                "role": "component",
                "paper_ids": sorted(available),
                "analysis_tasks": [],
            }
        ]
    errors = []
    if outline.get("outline_tree"):
        for key in ("review_thesis", "organizing_axis"):
            if not isinstance(outline.get(key), str) or not outline[key].strip():
                errors.append(key + ": nonempty planning statement required")
    tasks = set()
    jobs = []
    for node in chapters:
        sid = node["section_id"]
        role = node.get("role")
        if not isinstance(role, str) or role not in ROLES:
            errors.append(sid + ": role must be one of " + ", ".join(sorted(ROLES)))
        analyses = node.get("analysis_tasks", [])
        if not isinstance(analyses, list):
            errors.append(sid + ": analysis_tasks must be an array")
            analyses = []
        if role == "analysis" and not analyses:
            errors.append(sid + ": analysis chapter needs a concrete analysis_task")
        for task in analyses:
            if not isinstance(task, dict):
                errors.append(sid + ": analytical task must be an object")
                continue
            task_id = task.get("task_id")
            if not isinstance(task_id, str) or not task_id or task_id in tasks:
                errors.append(sid + ": analytical task IDs must be unique")
            else:
                tasks.add(task_id)
            if task.get("kind") not in KINDS:
                errors.append(str(task_id) + ": unknown analytical operation")
            for key in ("question", "completion"):
                if not isinstance(task.get(key), str) or not task[key].strip():
                    errors.append(str(task_id) + ": " + key + " must be nonempty")
            if "axes" in task and (
                not isinstance(task["axes"], list)
                or any(not isinstance(axis, str) or not axis for axis in task["axes"])
            ):
                errors.append(str(task_id) + ": axes must be strings")
        papers = []
        for local in [node, *node.get("subsections", [])]:
            assigned = local.get("paper_ids", [])
            if not isinstance(assigned, list) or any(
                not isinstance(identity, str) or identity not in available for identity in assigned
            ):
                errors.append(sid + ": invalid assigned paper_ids")
                assigned = []
            papers.extend(assigned)
            for kind in ("figures", "tables"):
                for asset in local.get(kind, []):
                    papers.extend(asset.get("paper_ids") or sorted(available))
        if role in {"analysis", "foundation", "background"} and not papers:
            errors.append(sid + ": substantive chapter needs assigned papers")
        jobs.append(
            {
                "section_id": sid,
                "role": role,
                "plan": copy.deepcopy(node),
                "paper_ids": list(dict.fromkeys(papers)),
            }
        )
    if errors:
        raise ValueError("; ".join(errors))
    return {
        "version": 2,
        "jobs": jobs,
        "navigation": [
            {
                "section_id": node["section_id"],
                "title": node.get("title", ""),
                "role": node.get("role"),
            }
            for node in chapters
        ],
        "review_thesis": outline.get("review_thesis") or outline.get("topic", ""),
        "organizing_axis": outline.get("organizing_axis", ""),
    }


def cards_plain(paper_ids, cards, keys, abstract=False):
    lines = []

    def append(value, prefix=""):
        if isinstance(value, dict):
            for k, v in value.items():
                lines.append(prefix + str(k) + ":")
                append(v, prefix + "  ")
        elif isinstance(value, list):
            for i, v in enumerate(value):
                lines.append(prefix + f"[{i}]")
                append(v, prefix + "  ")
        elif isinstance(value, str):
            lines.extend(prefix + line for line in value.split("\n"))
        else:
            lines.append(prefix + json.dumps(value, ensure_ascii=False))

    for pid in paper_ids:
        lines.append(f"## Paper {keys[pid]}")
        append(abstract_card(cards[pid]) if abstract else authoring_card(cards[pid]))
        lines.append("")
    return "\n".join(lines)
