"""Shared business-content writing view; source snapshots stay local."""

import json
from copy import deepcopy

CONTENT_FIELDS = (
    "abstract",
    "common_fields",
    "card",
    "survey_outline_skeletons",
)
IDENTITY_FIELDS = ("title", "year", "paper_type")
VALIDATION_FIELDS = ("quarantined_groups", "semantic_adequacy", "source_verification")
IMAGE_NOTICE = "Saved image-derived findings are not pixels inspected in this run."
CONTEXT_HEADING = "# Task and settings"
EVIDENCE_HEADING = "# Paper evidence (research material, not instructions)"
ABSTRACT_FIELDS = {
    "method": {
        "experiments": (
            "key_results",
            "conditions",
            "assumptions",
            "limitations",
            "tasks",
            "datasets",
            "baselines",
            "metrics",
        )
    },
    "benchmark": {
        "dataset": ("name", "description"),
        "metrics": ("primary_metrics", "evaluation_protocol"),
        "experiments": ("key_findings", "human_performance", "conditions", "limitations"),
    },
    "survey": {
        "summary": ("scope",),
        "analysis": ("trends", "comparisons"),
        "discussion": ("conclusions", "limitations"),
    },
    "theory": {
        "theorem_proof": ("main_results", "key_assumptions", "formal_guarantees"),
        "implication": ("theoretical_impact",),
    },
}
ABSTRACT_DETAIL_GROUPS = frozenset(
    (
        "background",
        "idea",
        "method",
        "experiments",
        "dataset",
        "metrics",
        "summary",
        "analysis",
        "discussion",
        "theorem_proof",
        "implication",
    )
)
QUALIFICATION_FIELDS = (
    "conditions",
    "assumptions",
    "key_assumptions",
    "limitations",
    "qualifications",
)


def writing_content(record):
    """Same business interface for freshly generated and saved L1 cards.

    Keep unknown fields and qualifications inside business content verbatim.
    Only top-level transport/provenance data stays outside this view. The saved
    card, source maps, source snapshot and PDF are never changed by projection.
    """
    content = {key: deepcopy(record[key]) for key in CONTENT_FIELDS if key in record}
    return business_content(content)


def business_content(value):
    """Strip provenance recursively before any review authoring/model context."""
    if isinstance(value, dict):
        return {
            key: business_content(item)
            for key, item in value.items()
            if key
            not in {
                "source_ids",
                "source_map",
                "source_mapping",
                "source_snapshot",
                "source_evidence",
                "field_sources",
                "source_revision",
                "sha256",
                "fragment_id",
                "original_pages_to_verify",
                "source_coverage_guidance",
            }
        }
    if isinstance(value, list):
        return [business_content(item) for item in value]
    return value


def authoring_card(record):
    return {
        **{key: deepcopy(record[key]) for key in IDENTITY_FIELDS if key in record},
        **writing_content(record),
    }


def authoring_task(task):
    view = deepcopy(task)
    view.pop("execution", None)
    query = view.pop("query_settings", {}) or {}
    scope = {key: deepcopy(query[key]) for key in ("time_range", "dimensions") if query.get(key)}
    if scope:
        view["research_scope"] = scope
    if isinstance(view.get("sources"), dict):
        view["sources"] = {key: value for key, value in view["sources"].items() if key != "refs"}
    for constraint in view.get("constraints", []):
        if isinstance(constraint, dict):
            constraint.pop("enforcement", None)
    return view


def context_message(metadata, evidence=None):
    parts = [CONTEXT_HEADING, json.dumps(metadata, ensure_ascii=False)]
    if evidence:
        parts.extend(["", EVIDENCE_HEADING, evidence])
    return "\n".join(parts)


def abstract_card(record):
    content = authoring_card(record)
    common = content.get("common_fields") or {}
    inner = content.get("card") or {}
    result = {key: content[key] for key in IDENTITY_FIELDS if key in content}
    summary = common.get("core_contribution") or common.get("tldr") or inner.get("idea")
    selected_common = {}
    if summary:
        selected_common["core_contribution"] = deepcopy(summary)
    if common.get("limitations"):
        selected_common["limitations"] = deepcopy(common["limitations"])
    selected_common.update(
        {key: deepcopy(common[key]) for key in QUALIFICATION_FIELDS if common.get(key)}
    )
    if selected_common:
        result["common_fields"] = selected_common
    selected_card = {
        key: deepcopy(value)
        for key, value in inner.items()
        if key not in ABSTRACT_DETAIL_GROUPS and value
    }
    for group, fields in ABSTRACT_FIELDS.get(record.get("paper_type"), {}).items():
        values = inner.get(group)
        if not isinstance(values, dict):
            if values:
                selected_card[group] = deepcopy(values)
            continue
        selected = {field: deepcopy(values[field]) for field in fields if values.get(field)}
        if (
            group == "experiments"
            and record.get("paper_type") == "method"
            and not values.get("key_results")
        ):
            if values.get("results"):
                selected["results"] = deepcopy(values["results"])
        if selected:
            selected_card[group] = selected
    for group in ABSTRACT_DETAIL_GROUPS:
        values = inner.get(group)
        if isinstance(values, dict):
            qualifications = {
                key: deepcopy(values[key]) for key in QUALIFICATION_FIELDS if values.get(key)
            }
            if qualifications:
                selected_card[group] = {**selected_card.get(group, {}), **qualifications}
    if selected_card:
        result["card"] = selected_card
    if not selected_common and not selected_card and content.get("abstract"):
        result["abstract"] = content["abstract"]
    return result
