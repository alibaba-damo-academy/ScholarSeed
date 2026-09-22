#!/usr/bin/env scholarseed-skill-python
"""Lock the original Claude Code BibTeX entry-type behavior."""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "generation" / "_fast"))

from _utils import render_bibtex_entry  # noqa: E402


def _base() -> dict:
    return {
        "title": "Deterministic Entry Types",
        "authors": [{"name": "Ada Lovelace"}],
        "year": 2025,
        "venue": {"name": "ExampleConf", "type": "conference"},
        "publication_types": ["Conference"],
    }


def main() -> int:
    conference = _base()
    conference["citationStyles"] = {
        "bibtex": "@Conference{OriginalKey,\n  title={Deterministic Entry Types},\n  year={2025}\n}"
    }
    rendered = render_bibtex_entry("Lovelace2025Deterministic", conference)
    assert rendered.startswith("@Conference{Lovelace2025Deterministic,")

    article = _base()
    article["citationStyles"] = {
        "bibtex": "@Article{OriginalKey,\n  title={Deterministic Entry Types}\n}"
    }
    assert render_bibtex_entry("Lovelace2025Article", article).startswith(
        "@Article{Lovelace2025Article,"
    )

    # Even explicit conference-like metadata must not change the historical
    # fallback. Venue-only records also must not gain fabricated vol/issue/pages.
    fallback = render_bibtex_entry("Lovelace2025Fallback", _base())
    assert fallback.startswith("@Article{Lovelace2025Fallback,")
    assert "journal= {ExampleConf}" in fallback
    assert "volume" not in fallback and "number" not in fallback and "pages" not in fallback

    print("Claude Code BibTeX entry-type contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
