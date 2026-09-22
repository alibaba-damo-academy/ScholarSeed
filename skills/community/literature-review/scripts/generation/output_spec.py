"""Resolve the output dialect from the canonical writing task."""
from __future__ import annotations

import json
from pathlib import Path
from citation_styles import style_ids, CITATION_STYLES

__all__ = ["read_output_spec", "DEFAULT_SPEC"]

# The shape a caller can rely on, whatever is (or is not) on disk. Mirrors
# schema/output_spec.json's required fields plus the two optional ones the
# generation stage actually reads.
DEFAULT_SPEC: dict = {
    "format": "latex_pdf",
    "template": "neurips",
    "citation_style": "numeric",
    "bibliography_style": "unsrtnat_scholarseed",
    "natbib_options": "numbers,sort&compress",
    "page_budget": None,
    "word_budget": None,
}

_VALID_FORMATS = ("latex_pdf", "markdown")
_VALID_CITATION_STYLES = style_ids()


def read_output_spec(workspace_root: Path) -> dict:
    """Resolve publication choices from the task; output_spec is only a projection."""
    from task_contract import read_request, publication_view
    loaded = publication_view(read_request(workspace_root))
    spec = {**DEFAULT_SPEC, **loaded}
    resolved = CITATION_STYLES[spec['citation_style']]
    spec.update(bibliography_style=resolved['bst'], natbib_options=resolved['natbib_options'],
                spec_source='01_input/writing_request.json#publication', spec_error=None)
    return spec
