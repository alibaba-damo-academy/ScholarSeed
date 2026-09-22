"""S-tier module #7: offline citation reality check.

Compares the cite_keys referenced in `05_generation/full_draft.{tex,md,txt}`
against the local sources of truth (`05_generation/citations.bib`,
`05_generation/_internal/cite_keys.json`, `03_process/paper_cards.json`) and
flags fabricated / corrupted citations — zero network, zero LLM.

Output shape mirrors `verifier_citation_result.json` for drop-in
compatibility with downstream consumers.

This is a compatibility audit helper, not a current publication gate.
"""

from __future__ import annotations

import re
import time
from datetime import date, datetime, timezone

from . import bibtex_local
from .crossfield import normalized_levenshtein_similarity
from .splitter import LATEX_CITE_RE

# cite_keys we consider parseable as the canonical Author{Year}{ShortName}
# shape; everything else falls into `missing_metadata` (SKIPPED) per the plan.
# ShortName tail is optional — `FakeKey2099` (no tail) is still a credible
# generator output, so it should fall into HALLUCINATED rather than SKIPPED
# when neither .bib nor cite_keys_map knows it. Patterns like `[2]` / `smith24`
# (lowercase head or non-alpha) still fail the regex and route to SKIPPED.
_PARSEABLE_CITE_KEY_RE = re.compile(r"^[A-Z][A-Za-z]+\d{4}[A-Za-z0-9]*$")

# Verdict thresholds (mirror crossfield's title gate at 0.92 and
# verifier_citation's SUSPICIOUS floor at 0.5).
_VERIFIED_SIM = 0.92
_HALLUCINATED_SIM = 0.50

# Guard against LLM-fabricated future years (e.g. 9999 / 3024). Anything past
# this is treated as the same class of bib-metadata defect as year=0/None —
# natbib will still render it, but the rendered citation is wrong.
_MAX_PLAUSIBLE_YEAR = date.today().year + 5


def extract_draft_cite_keys(draft_text: str) -> list[str]:
    """Return the deduplicated, order-preserving list of cite_keys referenced
    in the draft. Splits grouped `\\cite{A,B,C}` on `,`.
    """
    seen: set[str] = set()
    out: list[str] = []
    for m in LATEX_CITE_RE.finditer(draft_text):
        for raw in m.group(1).split(","):
            key = raw.strip()
            if key and key not in seen:
                seen.add(key)
                out.append(key)
    from urllib.parse import unquote
    for m in re.finditer(r'\]\((?:references\.md)?#ref-([^\s)]+)\)|\[@([^\]\s]+)\]', draft_text):
        key=unquote(m.group(1) or m.group(2))
        if key not in seen: seen.add(key); out.append(key)
    return out


def _derive_claimed_title(cite_key: str) -> str:
    """Best-effort title hint extracted from the cite_key itself.
    `Han2026SlotVTG` → `Slot VTG`. Used only when no .bib entry is available.
    """
    m = re.match(r"^[A-Z][A-Za-z]+\d{4}(.+)$", cite_key)
    if not m:
        return cite_key
    short = m.group(1)
    parts = re.findall(r"[A-Z][a-z0-9]*|[A-Z]+(?=[A-Z]|$)|\d+", short)
    return " ".join(p for p in parts if p) or short


def _verdict_from_counts(verified: int, suspicious: int,
                        hallucinated: int, skipped: int) -> str:
    if hallucinated > 0:
        return "PARTIAL_HALLUCINATED"
    if suspicious > 0:
        return "PARTIAL_SUSPICIOUS"
    if verified > 0:
        return "PASS"
    return "ALL_SKIPPED"


def check_citation_reality(
    draft_text: str,
    bib: dict | None,
    cite_keys_map: dict | None,
    paper_cards: dict | None,
) -> dict:
    """Apply the 7-rule decision table to every cite_key in the draft.

    Returns a dict shaped like `verifier_citation_result.json`:
      generated_at / elapsed_ms / metadata_source / total / verified /
      suspicious / hallucinated / skipped / verdict / results[] /
      to_remove / missing_metadata / recommendation.
    Caller is responsible for writing the JSON.
    """
    started = time.perf_counter()

    bib_map = bib or {}                                 # cite_key → bib entry
    ck_pid_to_key = cite_keys_map or {}                 # paper_id → cite_key
    ck_key_to_pid = {v: k for k, v in ck_pid_to_key.items()}  # reverse
    valid_ck_values = set(ck_pid_to_key.values())
    pc_map = paper_cards or {}                          # paper_id → card

    draft_keys = extract_draft_cite_keys(draft_text)

    results: list[dict] = []
    to_remove: list[str] = []
    missing_metadata: list[str] = []
    verified = suspicious = hallucinated = skipped = 0

    for key in draft_keys:
        in_bib = key in bib_map
        bib_entry = bib_map.get(key) or {}
        bib_title = bib_entry.get("title", "")
        pid = ck_key_to_pid.get(key)
        card = pc_map.get(pid) if pid else None
        card_title = (card or {}).get("title", "") if card else ""
        is_parseable = bool(_PARSEABLE_CITE_KEY_RE.match(key))

        # ── Rule order matches the decision table in §3.2 of the plan. ──
        if in_bib and card_title:
            sim = normalized_levenshtein_similarity(bib_title, card_title)
            if sim >= _VERIFIED_SIM:
                status, method = "VERIFIED", "local_paper_card_title"
                details = f"bib.title matches paper_card.title (sim={sim:.2f})"
                verified += 1
            elif sim >= _HALLUCINATED_SIM:
                status, method = "SUSPICIOUS", "local_paper_card_title"
                details = ("bib.title partially diverges from paper_card.title "
                           f"(sim={sim:.2f})")
                suspicious += 1
            else:
                status, method = "HALLUCINATED", "local_paper_card_title"
                details = ("bib.title contradicts paper_card.title — "
                           f"identifier hijacking (sim={sim:.2f})")
                hallucinated += 1
                to_remove.append(key)
            confidence = round(sim, 4)
            results.append({
                "cite_key":      key,
                "status":        status,
                "confidence":    confidence,
                "method":        method,
                "claimed_title": bib_title,
                "matched_title": card_title,
                "details":       details,
            })
            continue

        if in_bib and pid is None:
            # In .bib but cite_keys.json has no paper_id pointing here →
            # synthetic / orphan bib entry. Not a hard hallucination but worth
            # surfacing.
            status, method = "SUSPICIOUS", "local_reverse_map"
            details = ("cite_key present in citations.bib but no paper_id in "
                       "_internal/cite_keys.json maps to it (synthetic entry?)")
            suspicious += 1
            results.append({
                "cite_key":      key,
                "status":        status,
                "confidence":    0.5,
                "method":        method,
                "claimed_title": bib_title,
                "matched_title": "",
                "details":       details,
            })
            continue

        if in_bib:
            # In .bib, reverse map says paper_id exists but paper_cards lacks
            # it (only possible when paper_cards is missing or stale). Treat
            # as PASS at low confidence — we can verify presence but not title.
            status, method = "VERIFIED", "local_bib"
            details = ("cite_key present in citations.bib; no paper_card "
                       "available for cross-check (paper_cards.json missing?)")
            verified += 1
            results.append({
                "cite_key":      key,
                "status":        status,
                "confidence":    0.75,
                "method":        method,
                "claimed_title": bib_title,
                "matched_title": "",
                "details":       details,
            })
            continue

        # cite_key NOT in .bib
        if key in valid_ck_values:
            # Known to the bootstrap map but lost during the merge step →
            # serious but not "fabricated". Mark SUSPICIOUS so the operator
            # can rerun the merger.
            status, method = "SUSPICIOUS", "local_reverse_map"
            details = ("cite_key registered in _internal/cite_keys.json but "
                       "no entry in citations.bib (lost during merge?)")
            suspicious += 1
            results.append({
                "cite_key":      key,
                "status":        status,
                "confidence":    0.4,
                "method":        method,
                "claimed_title": _derive_claimed_title(key),
                "matched_title": "",
                "details":       details,
            })
            continue

        if not is_parseable:
            # Unparseable AND not in .bib → cannot meaningfully adjudicate.
            skipped += 1
            missing_metadata.append(key)
            results.append({
                "cite_key":      key,
                "status":        "SKIPPED",
                "confidence":    0.0,
                "method":        "skipped",
                "claimed_title": key,
                "matched_title": "",
                "details":       ("cite_key not parseable as Author{Year}"
                                  "{ShortName} and absent from citations.bib"),
            })
            continue

        # Hard hallucination: parseable cite_key absent from both .bib and
        # cite_keys.json — the drafting LLM invented it.
        hallucinated += 1
        to_remove.append(key)
        results.append({
            "cite_key":      key,
            "status":        "HALLUCINATED",
            "confidence":    1.0,
            "method":        "local_bib",
            "claimed_title": _derive_claimed_title(key),
            "matched_title": "",
            "details":       ("cite_key not present in citations.bib nor in "
                              "_internal/cite_keys.json values"),
        })

    # Bib-metadata pass: any draft-referenced .bib entry whose `year` is
    # missing / 0 / wildly future will be rendered by natbib as "[Author, 0]"
    # in the PDF — a visible publish-blocking defect even though the cite_key
    # itself is real. Flag each as SUSPICIOUS / failure_mode=invalid_bib_year
    # so the PARTIAL_SUSPICIOUS → PARTIAL_SUCCESS gate (cli.py runner +
    # merger._eval_citation_reality WARN) surfaces it for human review.
    referenced = set(draft_keys) & set(bib_map.keys())
    for key in sorted(referenced):
        y = bib_map[key].get("year")
        if y in (None, 0) or (isinstance(y, int) and y > _MAX_PLAUSIBLE_YEAR):
            suspicious += 1
            results.append({
                "cite_key":      key,
                "status":        "SUSPICIOUS",
                "confidence":    0.95,
                "method":        "local_bib_metadata",
                "claimed_title": bib_map[key].get("title", ""),
                "matched_title": "",
                "details":       (f"citations.bib 中 year 字段为 {y!r}，"
                                  "natbib 将在 PDF 中把该引用渲染为 "
                                  "'[Author, 0]'（或异常年份）。"),
                "failure_mode":  "invalid_bib_year",
            })

    bad_year_count = sum(
        1 for r in results if r.get("failure_mode") == "invalid_bib_year"
    )

    verdict = _verdict_from_counts(verified, suspicious, hallucinated, skipped)
    if hallucinated:
        rec = (f"{hallucinated} HALLUCINATED 引用，详见 to_remove。"
               "请在 citations.bib 与 draft 中核对后删除或替换。")
    elif suspicious:
        rec = (f"{suspicious} SUSPICIOUS 引用，建议人工复核或重跑 generation 的"
               " merger 步骤。")
    elif verified:
        rec = "全部引用本地金标 (bib + paper_cards) 校验通过。"
    else:
        rec = "未找到可校验的引用 — 检查 draft 是否真的使用了 \\cite{} 命令。"
    if bad_year_count:
        rec += (f" 其中 {bad_year_count} 条 SUSPICIOUS 为 bib year 缺失/为 0/"
                "未来年份，需补全 citations.bib 中对应条目的 year 字段后重跑 "
                "pdflatex+bibtex+pdflatex 二轮编译。")

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return {
        "generated_at":     datetime.now(timezone.utc).isoformat(),
        "elapsed_ms":       round(elapsed_ms, 4),
        "metadata_source":  "local_bib+cite_keys+paper_cards",
        "total":            len(draft_keys),
        "verified":         verified,
        "suspicious":       suspicious,
        "hallucinated":     hallucinated,
        "skipped":          skipped,
        "verdict":          verdict,
        "results":          results,
        "to_remove":        to_remove,
        "missing_metadata": missing_metadata,
        "recommendation":   rec,
    }
