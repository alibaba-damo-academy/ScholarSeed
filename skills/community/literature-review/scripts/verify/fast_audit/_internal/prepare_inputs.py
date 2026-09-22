"""Derive `07_verifier/input/*.json` sub-inputs from upstream survey artifacts.

This module is the implementation side of the public
`scripts/verifier_prepare_inputs.py` helper. It is also imported directly by
`runtime/cli.py:cmd_run` so that the fast-audit "run all" path can
auto-materialise the sub-inputs without forcing the user to remember the
helper script.

Builders consume:
    02_retrieval/selected_paper.json     (authors, year, title — for db_metadata)
    03_process/paper_cards.json          (titles, abstracts — for coverage/relevance)
    05_generation/_internal/cite_keys.json
    05_generation/section_drafts/*.json  (per-section bodies + claims)

`auto_prepare()` is the new entry point for in-process callers. The legacy
script delegates to the same builders so the two stay in sync.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def _safe_load(path: Path):
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _active_draft_files(workspace: Path):
    files = sorted((workspace / "05_generation/section_drafts").glob("*.json"))
    if not (workspace / "01_input/writing_request.json").exists():
        return files
    import sys
    root = next(p for p in Path(__file__).resolve().parents if (p / ".slr-home").exists())
    sys.path.insert(0, str(root / "lib"))
    from writing_contract import load_outline
    ids = {str(s["section_id"]) for s in load_outline(workspace)["outline_tree"]}
    return [p for p in files if p.stem in ids]


# ── 4 builders — pure functions over the workspace path ─────────────────
def _build_db_metadata(workspace: Path) -> dict | None:
    """{cite_key: {title, first_author, year}} from selected_paper + cite_keys."""
    sel = _safe_load(workspace / "02_retrieval" / "selected_paper.json")
    ck_map = _safe_load(workspace / "05_generation" / "_internal" / "cite_keys.json")
    if not sel or not ck_map:
        return None

    paper_meta: dict[str, dict] = {}
    papers = sel if isinstance(sel, list) else list(sel.values())
    for p in papers:
        if not isinstance(p, dict):
            continue
        pid = p.get("paperId", "")
        if not pid:
            continue
        authors = p.get("authors") or []
        first_author = ""
        if authors and isinstance(authors[0], dict):
            first_author = (authors[0].get("name", "")
                            or authors[0].get("normalized_name", ""))
        paper_meta[pid] = {
            "title": p.get("title", ""),
            "first_author": first_author,
            "year": p.get("year"),
        }

    result: dict[str, dict] = {}
    for pid, ck in ck_map.items():
        if pid in paper_meta:
            result[ck] = paper_meta[pid]
    return result if result else None


def _build_experiment_data(workspace: Path) -> dict | None:
    """{cite_key: {metrics: [...], claims: [...]}} from paper_cards.

    NOTE: in a survey workspace this whitelist is built from cited papers'
    key_results, not from any "own experiment" of the survey itself. cmd_run
    therefore skips this builder by default (see auto_prepare(skip_files=...)).
    Kept here for non-survey callers who still want the integrity gate.
    """
    cards = _safe_load(workspace / "03_process" / "paper_cards.json")
    ck_map = _safe_load(workspace / "05_generation" / "_internal" / "cite_keys.json")
    if not cards or not ck_map:
        return None

    ck_to_pid = {ck: pid for pid, ck in ck_map.items()}
    num_re = re.compile(
        r"(\d+\.?\d*)\s*(%|percent|accuracy|recall|precision|F1|mAP|IoU|R@\d+)",
        re.I,
    )

    result: dict[str, dict] = {}
    for ck, pid in ck_to_pid.items():
        card = cards.get(pid)
        if not isinstance(card, dict):
            continue
        inner = card.get("card") if isinstance(card.get("card"), dict) else {}
        common = (card.get("common_fields")
                  if isinstance(card.get("common_fields"), dict) else {})
        experiments = (inner.get("experiments")
                       if isinstance(inner.get("experiments"), dict) else {})
        text_parts: list[str] = []
        kr = common.get("key_results", "")
        if kr:
            text_parts.append(str(kr))
        kf = experiments.get("key_findings", "")
        if kf:
            text_parts.append(str(kf))
        metrics = []
        for text in text_parts:
            for m in num_re.finditer(text):
                metrics.append({
                    "value":   float(m.group(1)),
                    "unit":    m.group(2),
                    "context": text[max(0, m.start() - 30):m.end() + 30],
                })
        claims_list = common.get("claims") or []
        claims_text = ([str(c) for c in claims_list if c]
                       if isinstance(claims_list, list) else [])
        if metrics or claims_text:
            result[ck] = {"metrics": metrics, "claims": claims_text}
    return result if result else None


def _build_coverage_input(workspace: Path) -> dict | None:
    """{sections: [...], retrieved_papers: [...]} from section_drafts + cards."""
    cards = _safe_load(workspace / "03_process" / "paper_cards.json")
    drafts_dir = workspace / "05_generation" / "section_drafts"
    if not cards or not drafts_dir.is_dir():
        return None

    cite_re = re.compile(r"\\cite[tp]?\*?\{([^}]+)\}")
    sections = []
    for f in _active_draft_files(workspace):
        draft = _safe_load(f)
        if not isinstance(draft, dict):
            continue
        body = draft.get("body_md", "") or draft.get("body_tex", "") or ""
        cite_keys: list[str] = []
        for m in cite_re.finditer(body):
            for k in m.group(1).split(","):
                k = k.strip()
                if k and k not in cite_keys:
                    cite_keys.append(k)
        sections.append({
            "id":        draft.get("section_id", f.stem),
            "title":     draft.get("title", ""),
            "content":   body,
            "cite_keys": cite_keys,
        })

    retrieved = []
    for pid, card in cards.items():
        if not isinstance(card, dict):
            continue
        retrieved.append({
            "paper_id": pid,
            "title":    card.get("title", ""),
            "abstract": (card.get("abstract", "") or "")[:500],
            "year":     card.get("year"),
        })

    return ({"sections": sections, "retrieved_papers": retrieved}
            if sections else None)


_CJK_RE = re.compile(r"[一-鿿]")


def _has_cjk(s: str) -> bool:
    return bool(s and _CJK_RE.search(s))


def _build_relevance_pairs(workspace: Path) -> list | None:
    """[{claim_text, paper_abstract, cite_key, paper_id}] from section_drafts.

    Cross-lingual pairs (e.g. Chinese claim ↔ English abstract) are dropped at
    derivation time: the TF-IDF cosine downstream cannot bridge languages and
    would spuriously fail every such pair. The relevance module also has a
    defensive check; this is the first line of defense.
    """
    cards = _safe_load(workspace / "03_process" / "paper_cards.json")
    ck_map = _safe_load(workspace / "05_generation" / "_internal" / "cite_keys.json")
    drafts_dir = workspace / "05_generation" / "section_drafts"
    if not cards or not ck_map or not drafts_dir.is_dir():
        return None

    ck_to_pid = {ck: pid for pid, ck in ck_map.items()}
    pairs = []
    for f in _active_draft_files(workspace):
        draft = _safe_load(f)
        if not isinstance(draft, dict):
            continue
        claims = draft.get("claims") or []
        if not isinstance(claims, list):
            continue
        for claim in claims:
            if not isinstance(claim, dict):
                continue
            claim_text = claim.get("text", "") or claim.get("claim_text", "")
            cite_keys = claim.get("cite_keys") or []
            if not claim_text or not cite_keys:
                continue
            for ck in cite_keys:
                pid = ck_to_pid.get(ck, "")
                card = cards.get(pid, {})
                abstract = (card.get("abstract", "")
                            if isinstance(card, dict) else "")
                if not abstract:
                    continue
                # Skip cross-lingual pairs at source.
                if _has_cjk(claim_text) != _has_cjk(abstract):
                    continue
                pairs.append({
                    "claim_text":     claim_text[:500],
                    "paper_abstract": abstract[:500],
                    "cite_key":       ck,
                    "paper_id":       pid,
                })
    return pairs if pairs else None


BUILDERS = {
    "db_metadata.json":      _build_db_metadata,
    "experiment_data.json":  _build_experiment_data,
    "coverage_input.json":   _build_coverage_input,
    "relevance_pairs.json":  _build_relevance_pairs,
}


def auto_prepare(
    workspace: Path,
    skip_files: tuple[str, ...] = (),
    force: bool = False,
) -> dict[str, str]:
    """Derive sub-inputs under `<workspace>/07_verifier/input/`.

    - `skip_files`: filenames in BUILDERS not to materialise (e.g. survey
      callers pass `("experiment_data.json",)` because that whitelist has no
      meaningful source-of-truth in a literature-review workspace).
    - `force`: if False (default), files that already exist are left alone.

    Returns a `{filename: status}` map where status ∈ {"OK", "SKIPPED_*",
    "ERROR: <msg>"}. Status strings start with "SKIPPED" for any non-error
    path so callers can quickly distinguish failure modes.
    """
    out_dir = workspace / "07_verifier" / "input"
    out_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, str] = {}
    for fname, builder in BUILDERS.items():
        if fname in skip_files:
            results[fname] = "SKIPPED_BY_CALLER"
            continue
        out_path = out_dir / fname
        if out_path.exists() and not force:
            results[fname] = "SKIPPED_EXISTS"
            continue
        try:
            data = builder(workspace)
        except Exception as exc:  # noqa: BLE001
            results[fname] = f"ERROR: {exc}"
            continue
        if data is None:
            results[fname] = "SKIPPED_NO_UPSTREAM"
            continue
        out_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        results[fname] = "OK"
    return results


# ── diagnostic — used by relevance SKIPPED messaging ────────────────────
def diagnose_relevance_pairs(workspace: Path) -> str:
    """Return a precise SKIPPED reason for the relevance module.

    The bare 'input/relevance_pairs.json missing' message conflates three
    very different states. This walks the same upstream paths
    `_build_relevance_pairs` consumes and reports which one fired:
      1. upstream artifacts genuinely absent
      2. upstream OK but no claims-with-cite_keys exist in section_drafts
      3. upstream OK but every (claim, abstract) candidate is cross-lingual
         (zh claim ↔ en abstract — TF-IDF cannot bridge; the real fix is
         upstream, not here)
    """
    cards = _safe_load(workspace / "03_process" / "paper_cards.json")
    ck_map = _safe_load(workspace / "05_generation" / "_internal" / "cite_keys.json")
    drafts_dir = workspace / "05_generation" / "section_drafts"
    missing = []
    if not cards:
        missing.append("03_process/paper_cards.json")
    if not ck_map:
        missing.append("05_generation/_internal/cite_keys.json")
    if not drafts_dir.is_dir():
        missing.append("05_generation/section_drafts/")
    if missing:
        return ("input/relevance_pairs.json missing — upstream artifacts "
                "absent: " + ", ".join(missing))

    ck_to_pid = {ck: pid for pid, ck in ck_map.items()}
    candidates = 0
    same_lang = 0
    cross_lingual = 0
    for f in _active_draft_files(workspace):
        draft = _safe_load(f)
        if not isinstance(draft, dict):
            continue
        claims = draft.get("claims") or []
        if not isinstance(claims, list):
            continue
        for claim in claims:
            if not isinstance(claim, dict):
                continue
            claim_text = claim.get("text", "") or claim.get("claim_text", "")
            cite_keys = claim.get("cite_keys") or []
            if not claim_text or not cite_keys:
                continue
            for ck in cite_keys:
                pid = ck_to_pid.get(ck, "")
                card = cards.get(pid, {})
                abstract = (card.get("abstract", "")
                            if isinstance(card, dict) else "")
                if not abstract:
                    continue
                candidates += 1
                if _has_cjk(claim_text) == _has_cjk(abstract):
                    same_lang += 1
                else:
                    cross_lingual += 1

    if candidates == 0:
        return ("input/relevance_pairs.json missing — no (claim, abstract) "
                "candidates: section_drafts have no claims with cite_keys "
                "pointing to a paper_card carrying an abstract")
    if same_lang == 0 and cross_lingual > 0:
        return (f"all {cross_lingual} candidate (claim, abstract) pairs are "
                "cross-lingual; TF-IDF cannot bridge zh ↔ en — fix upstream "
                "by emitting same-language abstracts in 03_process")
    # Fallback (shouldn't normally happen — same-language candidates exist
    # but `_build_relevance_pairs` still returned None / empty).
    return (f"input/relevance_pairs.json missing — {candidates} candidates "
            f"({same_lang} same-language, {cross_lingual} cross-lingual) "
            "but builder produced no pairs")


# ── survey-scope detection — used by integrity SKIPPED messaging ────────
def is_survey_workspace(workspace: Path) -> bool:
    """Heuristic: this workspace is a literature-review run if it carries the
    two artifacts that only the survey pipeline produces.
    Used by `_run_integrity` to swap the SKIPPED reason from
    «缺 input/experiment_data.json» to «综述场景不适用 (无原创实验数据)».
    """
    query = workspace / "01_input" / "query.json"
    outline = workspace / "04_outline" / "outline.json"
    return query.is_file() and outline.is_file()
