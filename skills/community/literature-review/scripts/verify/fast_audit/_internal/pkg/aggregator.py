"""Phase 2: aggregate the 6 module artefacts into Chinese reports.

Reads (all relative to <workspace>/07_verifier/):
    tmp/citation_placeholder.json
    output/content_quality_result.json
    output/integrity_result.json
    tmp/citation_crossfield.json
    output/coverage_result.json
    output/relevance_result.json
    output/fast_audit_report.json   # used for verdict + module_summary transfer

Writes:
    output/aggregated_issues.json   # machine-readable, full (no truncation)
    output/final_report.md          # human-readable, Chinese, capped to MD_ISSUE_CAP

Issue extraction rules follow agents/fast-audit.md §3.2.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

MD_ISSUE_CAP = 50

# Severity ordering for sorting (smaller = more severe)
_SEVERITY_RANK = {"critical": 0, "REJECT": 0,
                  "high": 1, "WARN": 1, "high_arxiv": 1,
                  "low": 2, "PASS": 3}

# Pattern → human-friendly category + cause for content_quality
_CONTENT_QUALITY_META: dict[str, tuple[str, str]] = {
    "placeholder_todo":   ("模板套话/占位符",
                           "原文中保留了模板生成阶段的 TODO 占位符，未替换为正式内容。"),
    "placeholder_insert": ("模板套话/占位符",
                           "原文中保留了 [insert ...] 形式的填充占位符。"),
    "placeholder_xxx":    ("模板套话/占位符",
                           "原文中保留了 XXX / XXXX 形式的占位文本。"),
    "placeholder_tbd":    ("模板套话/占位符",
                           "原文中保留了 TBD / TBC 占位符，相应章节内容未补全。"),
    "lorem_ipsum":        ("模板套话/占位符",
                           "原文残留了 lorem ipsum 占位英文，未替换为正式内容。"),
    "ai_certainly":       ("AI 套话",
                           "出现 'certainly ... delve/explore' 风格的 LLM 套话。"),
    "ai_delve":           ("AI 套话",
                           "出现 'delve' 这一典型 LLM 风格词汇，建议改写为更具体的动词。"),
    "ai_tapestry":        ("AI 套话",
                           "出现 'tapestry' 这一典型 LLM 隐喻，建议改写为更具体表述。"),
    "ai_landscape":       ("AI 套话",
                           "出现 'landscape of ... reasoning' 这一 LLM 套语模式。"),
    "repeated_phrase":    ("重复短语",
                           "同一短语在小范围内重复 3 次以上，疑似模板复读或粘贴错误。"),
    "debug_print":        ("调试痕迹",
                           "原文残留 print(...) 或 console.log(...) 调试语句。"),
    "debug_fixme":        ("调试痕迹",
                           "原文残留 FIXME / HACK 标记，相关问题未解决。"),
}


# ── tiny helpers ──────────────────────────────────────────────────────────
def _short_hash(*parts) -> str:
    payload = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:8]


def _read_json_optional(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _find_draft_path(workspace: Path) -> tuple[str, list[str]]:
    """Return (relpath, lines) for the first draft found, else ('', []).

    Lookup order:
      1. 06_output/survey.tex  (published deliverable, preferred)
      2. 05_generation/full_draft.{tex,md,txt}  (upstream draft, fallback)
    """
    candidates: list[tuple[Path, str]] = [
        (workspace / "06_output" / "survey.tex", "06_output/survey.tex"),
    ]
    gen = workspace / "05_generation"
    if gen.is_dir():
        for name in ("full_draft.tex", "full_draft.md", "full_draft.txt"):
            candidates.append((gen / name, f"05_generation/{name}"))
    for p, relpath in candidates:
        if p.exists():
            try:
                lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                lines = []
            return relpath, lines
    return "", []


def _grep_first_line(lines: list[str], needle: str) -> int | None:
    """Return 1-indexed line number of the first occurrence; None if not found."""
    if not needle:
        return None
    needle = needle.strip()
    if not needle:
        return None
    for i, line in enumerate(lines, 1):
        if needle in line:
            return i
    return None


# ── per-module extractors ─────────────────────────────────────────────────
def _extract_placeholder(payload: dict, draft_file: str,
                         draft_lines: list[str]) -> list[dict]:
    issues: list[dict] = []
    for r in payload.get("results", []) or []:
        if not r.get("is_placeholder"):
            continue
        cite_key = r.get("cite_key", "") or ""
        match_names = [m.get("pattern_name", "") for m in r.get("matches", [])]
        snippet = cite_key[:120]
        line = _grep_first_line(draft_lines, cite_key) if draft_lines else None
        issues.append({
            "id": f"placeholder-{_short_hash(cite_key, ','.join(match_names))}",
            "module": "placeholder",
            "tier": "S",
            "severity": "critical",
            "category": "占位引用",
            "cause": ("引用站点匹配占位符模式（"
                      + ", ".join(match_names) + "），疑似 LLM 起草残留。"),
            "location": {
                "file": draft_file or None,
                "line": line,
                "snippet": snippet,
            },
            "module_origin": ("placeholder (S-tier 硬闸门, patterns="
                              + ",".join(match_names) + ")"),
            "recommendation": "把该引用替换为真实文献条目，或如确属设计意图请在引用前后加注释。",
        })
    return issues


_LATEX_SAFETY_META: dict[str, tuple[str, str, str]] = {
    "image_placeholder_text": (
        "图片占位符未去除",
        "图片生成失败时回退的占位文字仍然出现在最终稿中"
        "（最常见原因：generate_images 阶段失败但占位 figure 子文件仍被 \\input）。",
        "确认对应图是否需要：若需要，重跑 generate_images 阶段补齐图片；"
        "若不需要，从主稿中删除该图片对应的 \\input{...figures/<id>.tex}、"
        "\\ref{fig:<id>} 与 figure 段落，或把 figure 子文件清空为可编译的最小占位。",
    ),
    "image_generation_failed_referenced": (
        "失败图引用未清除",
        "上游 _status/generate_images.json 已把该 figure_id 标为 failed，"
        "但主稿仍在 \\input / \\ref 它，PDF 会编译进占位框。",
        "重跑该 figure 的 generate_images 阶段；或从主稿中清除对应的 "
        "\\input{...figures/<id>.tex} 与 \\ref{fig:<id>} 引用。",
    ),
    "unescaped_percent": (
        "LaTeX 未转义百分号",
        "正文中出现裸 % 字符；LaTeX 把它当作行内注释起始符，"
        "该字符之后到行末的内容会被静默丢弃，导致 PDF 中该段落被截断。",
        "把该处 % 改为 \\%（或将整行用 \\verb|...| 包裹，如确为代码片段）。",
    ),
    "table_overflow_long_token": (
        "表格内容超出列宽",
        "p/m/b/X 列存在不可断长 token（无空白与连字符），估算物理宽度已超过列宽，"
        "PDF 中该单元格会越出列边界、与右侧列重叠。",
        "把该 token 改为可换行写法（中间加空格、用 \\seqsplit{...}、或拆成多个单词）；"
        "或缩小整表字号（\\small/\\footnotesize）、加大列宽、改用 \\resizebox{\\linewidth}{!}{...} 包裹整张表。",
    ),
    "table_column_count_mismatch": (
        "表格行的列数与列规格不一致",
        "该行用 & 分隔出的列数（已计入 \\multicolumn 跨列）与表头 \\begin{tabular*} 声明的列数不符，"
        "LaTeX 会把多余 / 缺失的单元格静默错位，常表现为内容溢出表格边界。",
        "核对该行的 & 数量；如确需跨列请使用 \\multicolumn{n}{spec}{content}。",
    ),
    "table_fixed_width_overflow_page": (
        "表格固定列宽之和超过页面宽度",
        "tabular 的 p/m/b 列宽总和已超过 A4 默认 \\textwidth（约 16cm），"
        "PDF 中整张表会越出右边距、与页码或右侧空白重叠。",
        "改用 tabularx 并用 X 列均摊宽度；或加 \\resizebox{\\linewidth}{!}{...} 包裹；"
        "或减少列数 / 缩小固定列宽。",
    ),
    "table_wide_no_width_control": (
        "宽表缺少宽度控制",
        "≥ 4 列的 l/c/r 自然宽度表存在偏长单元格（拉丁字符 ≥30 或 CJK ≥15），"
        "且未被 \\resizebox / \\scalebox / \\adjustbox 包裹、也未缩字号，"
        "PDF 中很可能整体越出页面右边界。",
        "至少做以下之一：把若干列改为 p{<width>}、整张表改用 tabularx、外层加 \\resizebox{\\linewidth}{!}{...}、"
        "或加 \\small / \\footnotesize 缩小字号。",
    ),
}


def _extract_latex_safety(payload: dict) -> list[dict]:
    issues: list[dict] = []
    for m in payload.get("matches", []) or []:
        kind = m.get("kind", "") or ""
        category, cause, recommendation = _LATEX_SAFETY_META.get(
            kind,
            ("LaTeX 编译安全", f"匹配到 latex_safety 模式 {kind}。",
             "人工核对该处后修复。"),
        )
        file = m.get("file") or None
        line = m.get("line")
        snippet = (m.get("snippet") or "")[:160]
        figure_id = m.get("figure_id")
        cause_full = cause
        if figure_id:
            cause_full = f"{cause}（figure_id={figure_id}）"
        issues.append({
            "id": f"latex_safety-{_short_hash(kind, file, line, snippet)}",
            "module": "latex_safety",
            "tier": "S",
            "severity": "critical",
            "category": category,
            "cause": cause_full,
            "location": {
                "file": file,
                "line": line,
                "snippet": snippet,
            },
            "module_origin": f"latex_safety (S-tier 硬闸门, kind={kind})",
            "recommendation": recommendation,
        })
    return issues


def _extract_content_quality(payload: dict, draft_file: str) -> list[dict]:
    issues: list[dict] = []
    for m in payload.get("template_matches", []) or []:
        pattern = m.get("pattern", "") or ""
        text = m.get("text", "") or ""
        line = m.get("line")
        sev = (m.get("severity") or "low").lower()
        category, cause = _CONTENT_QUALITY_META.get(
            pattern,
            ("内容质量", f"匹配到内容质量模式 {pattern}。"),
        )
        issues.append({
            "id": f"content_quality-{_short_hash(pattern, text, line)}",
            "module": "content_quality",
            "tier": "S",
            "severity": sev,
            "category": category,
            "cause": cause,
            "location": {
                "file": draft_file or None,
                "line": line,
                "snippet": text[:120],
            },
            "module_origin": f"content_quality (S-tier 硬闸门, pattern={pattern})",
            "recommendation": ("删除或改写该片段后重跑 fast-audit。critical 级别"
                               "（TODO/XXX/TBD/lorem ipsum/FIXME）必须修复。"),
        })
    return issues


def _extract_integrity(payload: dict, draft_file: str,
                       draft_lines: list[str]) -> list[dict]:
    issues: list[dict] = []
    for u in payload.get("unverified_numbers", []) or []:
        value = u.get("value")
        is_strict = bool(u.get("is_strict"))
        section = u.get("section") or ""
        context = u.get("context") or ""
        sev = "critical" if is_strict else "high"
        line = _grep_first_line(draft_lines, str(value)) if draft_lines else None
        issues.append({
            "id": f"integrity-{_short_hash(value, section, context)}",
            "module": "integrity",
            "tier": "S",
            "severity": sev,
            "category": "数值未在白名单（疑似编造）",
            "cause": (f"数值 {value} 出现在"
                      f"{'严格区段' if is_strict else '宽松区段'}"
                      f" '{section}'，但 experiment_data.json 中未提供对应来源。"),
            "location": {
                "file": draft_file or None,
                "line": line,
                "snippet": context[:160],
            },
            "module_origin": ("integrity (S-tier 硬闸门, "
                              f"section_type={'strict' if is_strict else 'lenient'})"),
            "recommendation": ("把该数值补入 07_verifier/input/experiment_data.json，"
                               "或在 draft 中改成有出处的数值后重跑。"),
        })
    for fc in payload.get("fabricated_conditions", []) or []:
        name = fc.get("name") or ""
        ctx = fc.get("context") or ""
        line = _grep_first_line(draft_lines, name) if draft_lines else None
        issues.append({
            "id": f"integrity-{_short_hash('cond', name, ctx)}",
            "module": "integrity",
            "tier": "S",
            "severity": "critical",
            "category": "未知条件名（疑似编造）",
            "cause": (f"表格条件名 '{name}' 在 experiment_data.json 的 conditions 字典中"
                      "找不到对应键。"),
            "location": {
                "file": draft_file or None,
                "line": line,
                "snippet": ctx[:160],
            },
            "module_origin": "integrity (S-tier 硬闸门, fabricated_condition)",
            "recommendation": "核对实验条件名拼写，或把缺失的条件补入实验数据后重跑。",
        })
    return issues


def _extract_crossfield(payload: dict, draft_file: str,
                        draft_lines: list[str]) -> list[dict]:
    issues: list[dict] = []
    for r in payload.get("results", []) or []:
        if r.get("consistent"):
            continue
        raw = r.get("citation_raw") or ""
        mode = r.get("failure_mode") or "inconsistent"
        checks = r.get("checks") or {}
        sev = "critical" if mode == "identifier_hijacking" else "high"
        line = _grep_first_line(draft_lines, raw) if draft_lines else None
        category = ("DOI 劫持" if mode == "identifier_hijacking"
                    else "属性错配" if mode == "partial_attr_corruption"
                    else "元数据不一致")
        cause_parts = []
        if checks.get("title_pass") is False:
            cause_parts.append(f"title 相似度 {checks.get('title_similarity', 0):.2f} 低于 0.92")
        if checks.get("author_match") is False:
            cause_parts.append("第一作者姓氏不匹配")
        if checks.get("year_match") is False:
            cause_parts.append("年份相差 > 1")
        cause = "；".join(cause_parts) if cause_parts else "claimed 元数据与 DB 元数据不一致"
        issues.append({
            "id": f"crossfield-{_short_hash(raw, mode)}",
            "module": "crossfield",
            "tier": "S",
            "severity": sev,
            "category": category,
            "cause": cause + "。",
            "location": {
                "file": draft_file or None,
                "line": line,
                "snippet": raw[:160],
            },
            "module_origin": f"crossfield (S-tier 硬闸门, failure_mode={mode})",
            "recommendation": ("人工核查 DB 元数据与 inline 标注；若属 identifier_hijacking "
                               "应替换 DOI/cite_key 为正确条目。"),
        })
    return issues


def _extract_coverage(payload: dict, module_status: str = "PASS") -> list[dict]:
    issues: list[dict] = []
    # cross-lingual skip — no usable bucket; not an issue worth surfacing
    # as a defect (handled in skipped_modules instead).
    if payload.get("cross_lingual_skipped") or payload.get("coverage_f1") is None:
        return issues
    missing = payload.get("missing_topics", []) or []
    # Per-topic surfacing is noisy when the module didn't actually FAIL —
    # an IDF-weighted corpus easily yields a handful of "uncovered" tokens
    # (e.g. 'jats', 'untrimm') that aren't real defects. Fold to a single
    # low-severity summary in that case; only fan out when module FAIL.
    if missing:
        if module_status == "FAIL":
            for topic in missing:
                issues.append({
                    "id": f"coverage-{_short_hash('topic', topic)}",
                    "module": "coverage",
                    "tier": "A",
                    "severity": "high",
                    "category": "主题缺口",
                    "cause": (f"被检索论文集中 ≥3 篇共享的话题词 '{topic}' "
                              "未在综述章节中提及。"),
                    "location": {"file": None, "line": None,
                                 "snippet": str(topic)[:120]},
                    "module_origin": "coverage (A-tier 软闸门, missing_topic)",
                    "recommendation": (f"在相关章节中补充对 '{topic}' 的讨论，"
                                       "或调整检索集合排除非主题论文后重跑。"),
                })
        else:
            sample = ", ".join(str(t) for t in missing[:10])
            issues.append({
                "id": f"coverage-{_short_hash('topic_summary', sample)}",
                "module": "coverage",
                "tier": "A",
                "severity": "low",
                "category": "主题缺口（启发式提示，已通过模块阈值）",
                "cause": (f"共 {len(missing)} 个 IDF 加权话题词未在综述中出现"
                          f"（模块 coverage_f1 仍达标）。前 10 个示例："
                          f"{sample}。"),
                "location": {"file": None, "line": None, "snippet": sample[:120]},
                "module_origin": "coverage (A-tier 软闸门, missing_topic_summary)",
                "recommendation": ("如个别词确实是综述应覆盖的核心主题，可在相关"
                                   "章节中补充；若是检索结果噪声词可忽略。"),
            })
    for op in payload.get("orphan_papers", []) or []:
        title = (op.get("title") or "")[:120]
        pid = op.get("paper_id") or ""
        sim = op.get("max_similarity")
        issues.append({
            "id": f"coverage-{_short_hash('orphan', pid, title)}",
            "module": "coverage",
            "tier": "A",
            "severity": "high",
            "category": "孤儿论文（未被章节覆盖）",
            "cause": (f"检索到的论文 '{title}' 与所有章节的 TF-IDF 余弦最大相似度"
                      f" {sim} 低于阈值 0.15，没有任何章节讨论了它。"),
            "location": {"file": None, "line": None, "snippet": pid or title},
            "module_origin": "coverage (A-tier 软闸门, orphan_paper)",
            "recommendation": "为该论文补充一段讨论，或从检索集合中移除（若主题不相关）。",
        })
    return issues


def _extract_citation_reality(payload: dict, draft_file: str,
                              draft_lines: list[str]) -> list[dict]:
    issues: list[dict] = []
    for r in payload.get("results", []) or []:
        status = r.get("status") or ""
        if status not in ("HALLUCINATED", "SUSPICIOUS"):
            continue
        cite_key = r.get("cite_key", "") or ""
        method = r.get("method") or ""
        details = r.get("details") or ""
        failure_mode = r.get("failure_mode") or ""
        bib_title = (r.get("claimed_title") or "")[:120]
        card_title = (r.get("matched_title") or "")[:120]
        sev = "critical" if status == "HALLUCINATED" else "high"
        if failure_mode == "invalid_bib_year":
            category = "引用元数据 — bib year 缺失 / 为 0"
        else:
            category = ("引用真实性 — 硬幻觉" if status == "HALLUCINATED"
                        else "引用真实性 — 疑似")
        # Find the cite_key (or \cite{cite_key}) in the draft for location info.
        line = None
        if draft_lines:
            line = (_grep_first_line(draft_lines, f"{{{cite_key}}}")
                    or _grep_first_line(draft_lines, cite_key))
        if failure_mode == "invalid_bib_year":
            recommendation = (
                "在 citations.bib 中把该条目的 year 字段补全为正确年份，"
                "再重新运行 pdflatex+bibtex+pdflatex 二轮编译；否则 PDF 中该"
                "引用会渲染为 '[Author, 0]'。"
            )
        else:
            recommendation = (
                "把该引用从 draft 与 citations.bib 中删除或替换为真实条目；"
                "也可重跑 generation 的 merger 步骤恢复 cite_keys 映射。"
                if status == "HALLUCINATED"
                else "人工复核引用：核对 paper_cards 与 citations.bib 中的标题，"
                     "确认是否为版本差异；若确有错位请替换 cite_key。"
            )
        issues.append({
            "id": f"citation_reality-{_short_hash(cite_key, method, status)}",
            "module": "citation_reality_offline",
            "tier": "S",
            "severity": sev,
            "category": category,
            "cause": (f"{details}（method={method}；bib.title={bib_title!r}；"
                      f"card.title={card_title!r}）。"),
            "location": {
                "file": draft_file or None,
                "line": line,
                "snippet": f"\\cite{{{cite_key}}}",
            },
            "module_origin": f"citation_reality_offline (S-tier 硬闸门, status={status})",
            "recommendation": recommendation,
        })
    return issues


def _extract_relevance(payload: dict, module_status: str = "PASS") -> list[dict]:
    issues: list[dict] = []
    flagged = [r for r in (payload.get("results", []) or [])
               if r.get("verdict") in ("fail", "weak")]
    if not flagged:
        return issues
    if module_status != "FAIL":
        # Module passed (or skipped). The TF-IDF bag-of-words baseline
        # routinely flags lexically-distant-but-semantically-related pairs
        # — surfacing each as a separate high-sev issue contradicts the
        # module verdict and overwhelms the report. Collapse to one
        # low-sev advisory with a few examples.
        fails = [r for r in flagged if r.get("verdict") == "fail"]
        weaks = [r for r in flagged if r.get("verdict") == "weak"]
        examples = sorted(flagged, key=lambda r: r.get("cosine_similarity", 0))[:5]
        sample = "; ".join(f"cos={r.get('cosine_similarity')}({r.get('verdict')})"
                           for r in examples)
        issues.append({
            "id": f"relevance-summary-{_short_hash(len(fails), len(weaks), sample)}",
            "module": "relevance",
            "tier": "A",
            "severity": "low",
            "category": "claim 与摘要弱相关（启发式提示，已通过模块阈值）",
            "cause": (f"共 {len(fails)} 条 fail + {len(weaks)} 条 weak "
                      "已通过 relevance 模块阈值（fail 比例 ≤ 50%）。"
                      "TF-IDF 词袋无法识别同义词 / 缩写 / 学术压缩，因此即使"
                      "该模块整体 PASS，每对都可能在词面上对不齐。"
                      f"低相似度示例（前 5）: {sample}。"),
            "location": {"file": None, "line": None,
                         "snippet": f"fail={len(fails)} weak={len(weaks)}"},
            "module_origin": "relevance (A-tier 软闸门, per_pair_summary)",
            "recommendation": ("如担心个别引用是 LLM 误关联，可升级到 "
                               "verifier_claim 做语义级核查；否则可忽略。"),
        })
        return issues
    # module_status == "FAIL": fan out per-pair so the operator can review.
    for r in flagged:
        verdict = r.get("verdict") or ""
        sev = "high" if verdict == "fail" else "low"
        sim = r.get("cosine_similarity")
        drift = bool(r.get("semantic_drift"))
        category = ("引用语义漂移 (TF-IDF 启发式)" if drift else
                    ("claim 与摘要词汇相似度低 (启发式)" if verdict == "fail"
                     else "claim 与摘要弱相关 (启发式)"))
        issues.append({
            "id": f"relevance-{_short_hash(r)}",
            "module": "relevance",
            "tier": "A",
            "severity": sev,
            "category": category,
            "cause": (f"claim 与被引摘要的 TF-IDF 余弦相似度 {sim} "
                      f"判定为 {verdict}（pass≥0.3, weak∈[0.15,0.3), "
                      "fail<0.15）。TF-IDF 词袋无法识别同义词 / 缩写 / "
                      "跨语言匹配，低相似度未必意味着引用错误。"),
            "location": {"file": None, "line": None,
                         "snippet": (r.get("failure_mode") or verdict)[:120]},
            "module_origin": f"relevance (A-tier 软闸门, verdict={verdict})",
            "recommendation": ("人工核对 claim 与所引论文的主题相关性；如不确定，"
                               "建议升级到 verifier_claim 做语义级核查。"),
        })
    return issues


# ── markdown rendering ────────────────────────────────────────────────────
def _md_module_table(module_results: dict) -> str:
    rows = ["| 模块 | 层级 | 状态 | key_signal |", "|---|---|---|---|"]
    for name in ["placeholder", "content_quality", "latex_safety",
                 "integrity", "crossfield", "citation_reality_offline",
                 "coverage", "relevance"]:
        m = module_results.get(name) or {}
        signal = m.get("key_signal") or {}
        kv = ", ".join(f"{k}={v}" for k, v in list(signal.items())[:3])
        rows.append(
            f"| {name} | {m.get('tier', '?')} | "
            f"{m.get('status', 'MISSING')} | {kv or '—'} |"
        )
    return "\n".join(rows)


def _render_markdown(report: dict) -> str:
    lines: list[str] = []
    lines.append(f"# Fast-Audit 报告 — {report['workspace']}")
    lines.append("")
    lines.append(f"- **审计时间**: {report['audit_timestamp']}")
    lines.append(f"- **工作目录**: `{report['results_dir']}`")
    lines.append(f"- **最终判定**: {report['verdict']}")
    lines.append(f"- **总 issue 数**: {len(report['issues'])}"
                 + (f"（仅前 {MD_ISSUE_CAP} 条详列）"
                    if len(report["issues"]) > MD_ISSUE_CAP else ""))
    lines.append("")
    lines.append("## 一、问题汇总")
    lines.append("")
    lines.append("按 severity 排序（critical/REJECT → high/WARN → low），按模块分组。")
    lines.append("")

    if not report["issues"]:
        lines.append("> 本次审计未产生 issue。")
        lines.append("")
    else:
        # Group + render
        by_module: dict[str, list[dict]] = {}
        for issue in report["issues"][:MD_ISSUE_CAP]:
            by_module.setdefault(issue["module"], []).append(issue)
        for mod_name in ["placeholder", "content_quality", "latex_safety",
                         "integrity", "crossfield", "citation_reality_offline",
                         "coverage", "relevance"]:
            mod_issues = by_module.get(mod_name) or []
            if not mod_issues:
                continue
            tier = mod_issues[0].get("tier", "?")
            lines.append(f"### {mod_name} ({tier}-tier)")
            lines.append("")
            for idx, it in enumerate(mod_issues, 1):
                loc = it["location"]
                loc_str = "—"
                if loc.get("file"):
                    if loc.get("line"):
                        loc_str = (f"`{loc['file']}:{loc['line']}` — "
                                   f"`{loc.get('snippet', '')[:80]}`")
                    else:
                        loc_str = (f"`{loc['file']}` — "
                                   f"`{loc.get('snippet', '')[:80]}`")
                elif loc.get("snippet"):
                    loc_str = f"全文级 — `{loc['snippet'][:80]}`"
                lines.append(f"#### Issue #{idx} [{it['severity']}]")
                lines.append(f"- **原因**: {it['cause']}")
                lines.append(f"- **位置**: {loc_str}")
                lines.append(f"- **排查模块**: {it['module_origin']}")
                lines.append(f"- **修复建议**: {it['recommendation']}")
                lines.append("")
        if len(report["issues"]) > MD_ISSUE_CAP:
            tail = len(report["issues"]) - MD_ISSUE_CAP
            lines.append(f"> +{tail} 条已省略，详见 `aggregated_issues.json`。")
            lines.append("")

    lines.append("## 二、模块执行情况")
    lines.append("")
    lines.append(_md_module_table(report.get("module_summary") or {}))
    lines.append("")
    if report.get("skipped_modules"):
        lines.append("**SKIPPED 模块**：")
        for s in report["skipped_modules"]:
            lines.append(f"- `{s['module']}` — {s.get('reason', '原因未知')}")
        lines.append("")
    lines.append("## 三、下游建议")
    lines.append("")
    rec = report.get("recommendation") or "（无）"
    lines.append(f"> {rec}")
    lines.append("")
    lines.append("重跑命令（cd 到 workspace 后执行）：")
    lines.append("")
    lines.append("```")
    lines.append("slr run verify_audit")
    lines.append("```")
    return "\n".join(lines) + "\n"


# ── public entry ──────────────────────────────────────────────────────────
def aggregate(io) -> dict:
    """io is a fast-audit WorkspaceIO. Reads 6 module artefacts + main report,
    builds Chinese aggregated_issues.json + final_report.md, writes both,
    returns the structured payload.
    """
    workspace = io.workspace                          # absolute Path
    fa_root = io.fa_root
    main_report = _read_json_optional(io.output_dir / "fast_audit_report.json") or {}
    module_results = main_report.get("module_results") or {}

    draft_file, draft_lines = _find_draft_path(workspace)

    issues: list[dict] = []
    skipped_modules: list[dict] = []

    # placeholder
    p = _read_json_optional(io.tmp_dir / "citation_placeholder.json")
    if p is None:
        skipped_modules.append({"module": "placeholder",
                                "reason": "缺 citation_placeholder.json"})
    else:
        issues.extend(_extract_placeholder(p, draft_file, draft_lines))

    # content_quality
    p = _read_json_optional(io.output_dir / "content_quality_result.json")
    if p is None:
        skipped_modules.append({"module": "content_quality",
                                "reason": "缺 content_quality_result.json"})
    else:
        issues.extend(_extract_content_quality(p, draft_file))

    # latex_safety
    p = _read_json_optional(io.output_dir / "latex_safety_result.json")
    if p is None:
        skipped_modules.append({"module": "latex_safety",
                                "reason": "缺 latex_safety_result.json"})
    else:
        issues.extend(_extract_latex_safety(p))

    # integrity
    p = _read_json_optional(io.output_dir / "integrity_result.json")
    if p is None:
        mr = module_results.get("integrity") or {}
        if mr.get("status") == "SKIPPED":
            # Distinguish survey-scope N/A from generic "missing input" so
            # the operator does not chase a file that should not exist in
            # a literature-review workspace.
            status_path = io.status_dir / "integrity.status.json"
            survey_na = False
            try:
                s = json.loads(status_path.read_text(encoding="utf-8"))
                survey_na = "survey scope" in (s.get("reason") or "").lower()
            except (OSError, json.JSONDecodeError):
                pass
            reason = ("综述场景不适用 (无原创实验数据)" if survey_na
                      else "缺 input/experiment_data.json")
            skipped_modules.append({"module": "integrity", "reason": reason})
        else:
            skipped_modules.append({"module": "integrity",
                                    "reason": "缺 integrity_result.json"})
    else:
        issues.extend(_extract_integrity(p, draft_file, draft_lines))

    # crossfield
    p = _read_json_optional(io.tmp_dir / "citation_crossfield.json")
    if p is None:
        mr = module_results.get("crossfield") or {}
        if mr.get("status") == "SKIPPED":
            skipped_modules.append({"module": "crossfield",
                                    "reason": "缺 input/db_metadata.json"})
        else:
            skipped_modules.append({"module": "crossfield",
                                    "reason": "缺 citation_crossfield.json"})
    else:
        issues.extend(_extract_crossfield(p, draft_file, draft_lines))

    # coverage
    p = _read_json_optional(io.output_dir / "coverage_result.json")
    if p is None:
        mr = module_results.get("coverage") or {}
        if mr.get("status") == "SKIPPED":
            skipped_modules.append({"module": "coverage",
                                    "reason": "缺 input/coverage_input.json"})
        else:
            skipped_modules.append({"module": "coverage",
                                    "reason": "缺 coverage_result.json"})
    elif p.get("cross_lingual_skipped") or p.get("coverage_f1") is None:
        # Module ran but couldn't score: sections & papers in different
        # language buckets (e.g. zh survey ↔ en abstracts). Upstream lacks
        # an abstract-translation step, so this SKIPPED is structural.
        skipped_modules.append({"module": "coverage",
                                "reason": "跨语言无可比配对 (中文章节 ↔ 英文 abstract) — 结构性 SKIPPED，非缺陷"})
    else:
        cov_status = (module_results.get("coverage") or {}).get("status", "PASS")
        issues.extend(_extract_coverage(p, module_status=cov_status))

    # citation_reality_offline
    p = _read_json_optional(io.output_dir / "citation_reality_result.json")
    if p is None:
        mr = module_results.get("citation_reality_offline") or {}
        if mr.get("status") == "SKIPPED":
            skipped_modules.append({"module": "citation_reality_offline",
                                    "reason": "缺 05_generation/citations.bib"})
        else:
            skipped_modules.append({"module": "citation_reality_offline",
                                    "reason": "缺 citation_reality_result.json"})
    else:
        issues.extend(_extract_citation_reality(p, draft_file, draft_lines))

    # relevance
    p = _read_json_optional(io.output_dir / "relevance_result.json")
    if p is None:
        mr = module_results.get("relevance") or {}
        if mr.get("status") == "SKIPPED":
            # Pull the precise reason from relevance.status.json if available
            # so cross-lingual skips (the only structural case) surface clearly
            # instead of being conflated with a generic "missing input".
            status_path = io.status_dir / "relevance.status.json"
            raw_reason = "缺 input/relevance_pairs.json"
            try:
                s = json.loads(status_path.read_text(encoding="utf-8"))
                raw_reason = s.get("reason") or raw_reason
            except (OSError, json.JSONDecodeError):
                pass
            if "cross-lingual" in raw_reason.lower():
                reason = f"{raw_reason} — 结构性 SKIPPED，非缺陷"
            else:
                reason = raw_reason
            skipped_modules.append({"module": "relevance", "reason": reason})
        else:
            skipped_modules.append({"module": "relevance",
                                    "reason": "缺 relevance_result.json"})
    else:
        rel_status = (module_results.get("relevance") or {}).get("status", "PASS")
        issues.extend(_extract_relevance(p, module_status=rel_status))

    # Sort: severity, then module, then id
    issues.sort(key=lambda x: (
        _SEVERITY_RANK.get(x["severity"], 99),
        x["module"],
        x["id"],
    ))

    payload = {
        "workspace": workspace.name,
        "results_dir": str(fa_root),
        "audit_timestamp": datetime.now(timezone.utc).isoformat(),
        "verdict": main_report.get("verdict", "UNKNOWN"),
        "source_report_path": str(io.output_dir / "fast_audit_report.json"),
        "module_summary": module_results,
        "issues": issues,
        "failed_modules": main_report.get("failed_modules", []),
        "skipped_modules": skipped_modules,
        "recommendation": main_report.get("recommendation", ""),
        "elapsed_ms": main_report.get("elapsed_ms"),
        "modules_evaluated": main_report.get("modules_evaluated"),
        "modules_passed": main_report.get("modules_passed"),
        "modules_failed": main_report.get("modules_failed"),
        "modules_skipped": main_report.get("modules_skipped"),
    }

    # Write files
    io.write_json("output", "aggregated_issues.json", payload)
    md_path = io.output_dir / "final_report.md"
    md_path.write_text(_render_markdown(payload), encoding="utf-8")

    return payload
