"""Shared business-content writing view; source snapshots stay local."""

from copy import deepcopy

CONTENT_FIELDS = (
    "abstract",
    "common_fields",
    "card",
    "survey_outline_skeletons",
)
IDENTITY_FIELDS = ("title", "year", "paper_type", "reading_depth")
VALIDATION_FIELDS = ("quarantined_groups", "semantic_adequacy", "source_verification")
LIMITS_LABEL = "Evidence limits"
IMAGE_NOTICE = "Saved image-derived findings are not pixels inspected in this run."


def evidence_limits(record):
    if record.get('reading_depth') == 'abstract_only':
        return {'material_limit': 'Abstract only; do not imply original full-text access.'}
    if (record.get('source_coverage') or {}).get('complete') is False:
        return {'material_limit': 'Some original content was unavailable.'}
    return {}


def writing_content(record):
    """Same business interface for freshly generated and saved L1 cards.

    Keep unknown fields and qualifications inside business content verbatim.
    Only top-level transport/provenance data stays outside this view. The saved
    card, source maps, source snapshot and PDF are never changed by projection.
    """
    content = {key: deepcopy(record[key]) for key in CONTENT_FIELDS if key in record}
    limits = evidence_limits(record)
    if limits:
        content[LIMITS_LABEL] = limits
    return business_content(content)


def business_content(value):
    """Strip provenance recursively before any review authoring/model context."""
    if isinstance(value, dict):
        return {key: business_content(item) for key, item in value.items()
                if key not in {'source_ids', 'source_map', 'source_mapping', 'source_snapshot',
                               'source_evidence', 'field_sources', 'source_revision', 'sha256',
                               'fragment_id', 'original_pages_to_verify',
                               'source_coverage_guidance'}}
    if isinstance(value, list):
        return [business_content(item) for item in value]
    return value


def authoring_card(record):
    return {
        **{key: deepcopy(record[key]) for key in IDENTITY_FIELDS if key in record},
        **writing_content(record),
    }
