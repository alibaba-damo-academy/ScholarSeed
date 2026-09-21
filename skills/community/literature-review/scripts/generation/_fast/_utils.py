"""Shared *mechanical* utilities for the Generation pipeline.

Only handles I/O, paths, cite_key construction, outline traversal, and JSON
extraction — no LLM calls. Codex subagents are responsible for all reasoning;
helper scripts use these
utilities to load and persist work.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

# ----------------------------------------------------------------------------
# Workspace I/O
# ----------------------------------------------------------------------------


class Workspace:
    """Standard MVP workspace layout (per 接口契约).

    Resolution order: an explicit `root`, then `SLR_WORKSPACE`, then the cwd.
    The middle step matters because the cwd is only trustworthy for the stage
    scripts, which `slr` launches with `cwd=workspace`. A subagent running one
    of these scripts from its own Bash tool inherits the *launch* directory
    instead, and the workspace lives one level below it — so cwd alone silently
    addresses the wrong tree. `scripts/slr` exports `SLR_WORKSPACE` on every
    invocation and `lib/slr_paths.workspace()` has always honoured it; this
    class used to be the one place that did not.
    """

    def __init__(self, root: str | Path | None = None):
        if root is None:
            root = os.environ.get("SLR_WORKSPACE", "").strip() or Path.cwd()
        self.root = Path(root).expanduser().resolve()
        self.input = self.root / "01_input"
        self.retrieval = self.root / "02_retrieval"
        self.process = self.root / "03_process"
        self.outline = self.root / "04_outline"
        self.gen = self.root / "05_generation"
        self.output = self.root / "06_output"

    @property
    def query_path(self) -> Path:
        """Canonical framework-resolved one-sentence intent."""
        return self.input / "query.json"
    @property
    def selected_papers_path(self) -> Path:
        return self.retrieval / "selected_paper.json"
    @property
    def paper_cards_path(self) -> Path: return self.process / "paper_cards.json"
    @property
    def outline_path(self) -> Path: return self.outline / "outline.json"

    @property
    def section_drafts_dir(self) -> Path: return self.gen / "section_drafts"
    @property
    def figures_dir(self) -> Path: return self.gen / "figures"
    @property
    def tables_dir(self) -> Path: return self.gen / "tables"
    @property
    def status_dir(self) -> Path: return self.gen / "_status"
    @property
    def internal_dir(self) -> Path: return self.gen / "_internal"

    @property
    def full_draft_path(self) -> Path: return self.gen / "full_draft.tex"
    # Versioned merge artefacts (post 2026-05 refactor):
    #   v1 = sections merged, no figure/table \input lines (phase05_merge_full_draft.py)
    #   v2 = v1 polished by the agent at the document level (phase05a_refine_full_draft, agent-side)
    #   v3 = v2 + figure/table \input lines (phase05b_insert_assets.py)
    @property
    def full_draft_v1_path(self) -> Path: return self.gen / "full_draft_v1.tex"
    @property
    def full_draft_v2_path(self) -> Path: return self.gen / "full_draft_v2.tex"
    @property
    def full_draft_v3_path(self) -> Path: return self.gen / "full_draft_v3.tex"
    @property
    def citations_bib_path(self) -> Path: return self.gen / "citations.bib"
    @property
    def quality_report_path(self) -> Path: return self.gen / "quality_report.json"
    @property
    def generation_report_path(self) -> Path: return self.gen / "generation_report.json"
    @property
    def survey_pdf_path(self) -> Path: return self.output / "survey.pdf"
    @property
    def survey_md_fallback_path(self) -> Path:
        # Markdown fallback emitted by phase 7 only when pdflatex is
        # unavailable on this machine or compilation fails fatally. The
        # primary deliverable is always `survey.pdf` in both scopes.
        return self.output / "survey_fallback.md"
    @property
    def disclaimer_path(self) -> Path: return self.output / "disclaimer.md"
    # Self-contained LaTeX bundle mirrored into 06_output/ by phase 7 so the
    # user can take the deliverable away without dragging 05_generation/.
    # `\input{05_generation/...}` paths in `survey.tex` are rewritten to be
    # relative to 06_output/.
    @property
    def survey_tex_path(self) -> Path: return self.output / "survey.tex"
    @property
    def survey_citations_bib_path(self) -> Path: return self.output / "citations.bib"
    @property
    def survey_figures_dir(self) -> Path: return self.output / "figures"
    @property
    def survey_tables_dir(self) -> Path: return self.output / "tables"
    @property
    def survey_neurips_sty_path(self) -> Path: return self.output / "neurips_2026.sty"
    @property
    def survey_aux_path(self) -> Path: return self.output / "survey.aux"

    def ensure_output_dirs(self, include_output: bool = True) -> None:
        dirs = [
            self.gen,
            self.section_drafts_dir,
            self.figures_dir,
            self.tables_dir,
            self.status_dir,
            self.internal_dir,
        ]
        # 06_output/ is created only when a deliverable is actually published
        # (clean PDF compile, or Markdown fallback after the agent's compile
        # fix loop is exhausted). Callers that may run before any deliverable
        # exists pass include_output=False to avoid materialising an empty
        # 06_output/ on a deferred-fallback compile failure.
        if include_output:
            dirs.append(self.output)
        for d in dirs:
            d.mkdir(parents=True, exist_ok=True)

    def cite_keys_path(self) -> Path:
        return self.internal_dir / "cite_keys.json"

    def query_meta_path(self) -> Path:
        return self.internal_dir / "query_meta.json"

    def drafting_worklist_path(self) -> Path:
        return self.internal_dir / "drafting_worklist.json"

    def refinement_worklist_path(self) -> Path:
        return self.internal_dir / "refinement_worklist.json"

    def tables_worklist_path(self) -> Path:
        return self.internal_dir / "tables_worklist.json"

    def figures_worklist_path(self) -> Path:
        return self.internal_dir / "figures_worklist.json"


def load_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ----------------------------------------------------------------------------
# Query metadata extraction (resilient to upstream schema variations)
# ----------------------------------------------------------------------------


_VALID_LANGUAGES = {"english", "chinese"}


def _normalise_language(raw: str) -> str:
    s = (raw or "").strip().lower()
    if s in ("english", "en", "en-us", "en_us"):
        return "english"
    if s in ("chinese", "zh", "zh-cn", "zh_cn", "cn", "中文"):
        return "chinese"
    return ""


def read_query_meta(query: dict | None, outline: dict | None = None) -> dict:
    """Resolve generation metadata from the canonical Codex query contract."""
    q = query or {}
    o = outline or {}

    raw_lang = q.get("language", "")
    language = _normalise_language(raw_lang if isinstance(raw_lang, str) else "")
    if language not in _VALID_LANGUAGES:
        language = "english"

    topic = str(q.get("query") or "").strip()
    if not topic:
        topic = "Untitled Survey"
    topic_precise = topic

    survey_title = str(o.get("survey_title") or "").strip()
    if not survey_title:
        survey_title = topic

    task_id = str(o.get("task_id") or q.get("task_id") or "").strip()
    if not task_id:
        task_id = "survey_" + datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d_%H%M%S")

    return {
        "scope": "speed",
        "language": language,
        "topic": topic,
        "topic_precise": topic_precise,
        "survey_title": survey_title,
        "task_id": task_id,
    }


def write_json(path: Path, data: Any, *, indent: int | None = 2) -> None:
    """Write JSON. `indent=None` for files whose only reader is an LLM.

    Pretty-printing is worth it for artefacts a person opens. For a file an
    agent loads whole it is pure overhead — the indentation on one 21-paper
    drafting item measured 12 KB, 14% of the file, spent entirely on alignment
    nobody looks at.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent, ensure_ascii=False,
                  separators=((",", ":") if indent is None else None))


def now_iso() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


# ----------------------------------------------------------------------------
# run_log.txt — single append-only timeline shared by every script in a run.
# Each event is one short line: `<iso-ts> <TAG-or-marker> ...`. Writes are
# atomic per call (single open(a)+write+close, line < PIPE_BUF), so Phase 3's
# three parallel branch subprocesses can all append safely without locks.
# ----------------------------------------------------------------------------


# Fields that are useful to surface on the [SCRIPT END] line. Kept tight on
# purpose — the JSON sibling under _status/{phase}.json is the source of truth
# for anything richer.
_END_KV_WHITELIST = (
    "processed", "failed", "total_items", "total_pending",
    "rendered", "forest_skipped", "verdict", "engine",
    "v1_chars", "v2_chars", "sections", "labels",
    "cite_keys_used", "leaves", "selected_papers", "cards",
)


def run_log_path(ws: "Workspace") -> Path:
    return ws.gen / "run_log.txt"


def _log_line(ws: "Workspace", body: str) -> None:
    """Append one `<iso> <body>\\n` line to run_log.txt. Best-effort: any
    I/O failure is swallowed so logging never breaks a script.

    Refuses to write — and in particular refuses to `mkdir` — when the root is
    not a workspace. `log_script_start()` runs before the first read that would
    reveal a wrong root, so without this guard a script pointed at the launch
    directory creates `<launch_cwd>/05_generation/run_log.txt` there and only
    *then* fails. That write is outside the workspace, so `spy check` and
    `verify_postcheck` never see it; one run left five such lines on disk with
    nothing in the transcript to say so.
    """
    if not ws.input.is_dir():
        return
    try:
        path = run_log_path(ws)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{now_iso()} {body}\n")
    except Exception:  # noqa: BLE001
        pass


def _format_kv(items) -> str:
    """Render `key=value` pairs comma-joined, skipping None/empty values.
    `items` is an iterable of (k, v) tuples."""
    parts = []
    for k, v in items:
        if v is None or v == "":
            continue
        if isinstance(v, float):
            sv = f"{v:.2f}" if abs(v) >= 0.01 else f"{v:g}"
        else:
            sv = str(v).replace("\n", " ").strip()
        parts.append(f"{k}={sv}")
    return ", ".join(parts)


def require_workspace(ws: "Workspace", script: str) -> None:
    """Fail loudly, and by name, when the resolved root is not a workspace.

    Called first thing by every script a *subagent* is told to run. Those
    scripts resolve their root from cwd or `SLR_WORKSPACE`, and a subagent's
    cwd is the launch directory, not the workspace — so the wrong root is the
    expected failure, not an exotic one. Without this the script dies several
    lines later on a `FileNotFoundError` naming a file, which tells the caller
    nothing about *which tree* it was looking in, and a subagent that cannot
    read the error marks its own good draft `degraded`.
    """
    if ws.input.is_dir():
        return
    raise SystemExit(
        f"{script}: {ws.root} is not an slr workspace "
        f"(no 01_input/ under it).\n"
        f"  Pass the workspace explicitly:  scholarseed-skill-python .../{script} <workspace>\n"
        f"  or export SLR_WORKSPACE=<workspace> before the call.\n"
        f"  Resolved from: "
        + ("SLR_WORKSPACE" if os.environ.get("SLR_WORKSPACE", "").strip()
           else "the current directory")
    )


def log_script_start(ws: "Workspace", phase: str, **kv) -> None:
    extra = _format_kv(kv.items())
    body = f"[SCRIPT START] {phase}"
    if extra:
        body += f", {extra}"
    _log_line(ws, body)


def log_debug(ws: "Workspace", phase: str, msg: str) -> None:
    """Append a [DEBUG] line to debug_log.txt for ad-hoc diagnostics."""
    try:
        path = ws.gen / "debug_log.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{now_iso()} [DEBUG] {phase}: {msg}\n")
    except Exception:  # noqa: BLE001
        pass


def log_item(ws: "Workspace", tag: str, ident: str,
             duration_sec: float, **kv) -> None:
    """Per-item line for concurrent runners. Example:
       `[DRAFT] section_id=2.1: 12.34s, status=SUCCESS, words=540`."""
    extra = _format_kv(kv.items())
    body = f"[{tag}] {ident}: {duration_sec:.2f}s"
    if extra:
        body += f", {extra}"
    _log_line(ws, body)


def write_status(ws: Workspace, phase: str, status: str, **extra) -> dict:
    rec = {
        "phase": phase,
        "status": status,
        "timestamp": now_iso(),
        **extra,
    }
    write_json(ws.status_dir / f"{phase}.json", rec)
    # session.log line uses the unified format 'YYYY-MM-DD HH:MM:SS [module]: message'
    # (local time, no tz). The status file written above stays a pure-JSON record;
    # only this stdout/log line gets the prefix. The phase08 handshake is printed
    # separately (and stays bare) so the agent can still parse it as raw JSON.
    _ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"{_ts} [generation/{phase}]: {json.dumps(rec, ensure_ascii=False)}")

    # Auto-emit the matching [SCRIPT END] line in run_log.txt. The script's
    # `log_script_start` call paired with this gives a complete bracket; the
    # gap between adjacent END→START timestamps across scripts is the agent-
    # orchestration overhead between them.
    duration = extra.get("duration_sec")
    dur_str = f"{duration:.2f}s" if isinstance(duration, (int, float)) else "?s"
    kv_pairs = [("status", status)]
    for k in _END_KV_WHITELIST:
        if k in extra and extra[k] not in (None, ""):
            kv_pairs.append((k, extra[k]))
    kv_str = _format_kv(kv_pairs)
    _log_line(ws, f"[SCRIPT END]   {phase}: {dur_str}, {kv_str}")

    return rec


# ----------------------------------------------------------------------------
# LLM I/O logger (diagnostic — compare provider/model prompt-response shape)
# ----------------------------------------------------------------------------


class LLMIOLogger:
    """Append each chat call's input messages and output text to a JSONL file.

    One line per LLM call (including retries). Concurrent-safe via asyncio.Lock.
    Failures swallowed silently — logging must never break the actual run.
    Caller is responsible for providing the destination path; the parent
    directory is created on first use.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = asyncio.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    async def log(self, record: dict) -> None:
        try:
            line = json.dumps(record, ensure_ascii=False, default=str)
        except Exception:
            return
        try:
            async with self._lock:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
        except Exception:
            pass


async def chat_with_logging(
    llm: Any,
    messages: list[dict],
    *,
    item_id: str,
    io_logger: Optional[LLMIOLogger],
    chat_kwargs: Optional[dict] = None,
    stream: bool = False,
    **extra_fields: Any,
) -> str:
    """Wrap llm.chat() and append a JSONL record with the full request + response.

    `stream=True` routes through `llm.chat_stream()` instead. The return value
    and the log record are identical either way — streaming only changes the
    transport, keeping the HTTP connection busy so a long single request (a
    full-document rewrite) does not trip the gateway's idle timeout.

    `item_id` names the unit-of-work (e.g. table_id, section_id, "full_draft").
    `extra_fields` are merged into the record (e.g. phase=, shape_attempt=,
    llm_attempt=). Logging exceptions are swallowed — chat() exceptions propagate.

    `chat_kwargs` are forwarded verbatim to `llm.chat()` (e.g.
    `{"response_format": {"type": "json_object"}}`, `{"max_tokens": 64000}`).
    Callers that need JSON-mode or a custom token cap pass them here so the
    wrapper stays transparent; they are NOT written to the log record (only
    request messages / output / timing are).

    If the underlying LLM honors the `_capture` kwarg (see light_llm.py),
    reasoning / thinking text is recorded under `reasoning_text` and the
    length under `reasoning_chars`. Empty when the backend does not expose
    reasoning content.
    """
    t_start = time.perf_counter()
    error_info: Optional[str] = None
    text: str = ""
    capture: dict = {}
    try:
        send = llm.chat_stream if stream else llm.chat
        text = await send(messages, _capture=capture, **(chat_kwargs or {}))
        return text
    except Exception as exc:  # noqa: BLE001
        error_info = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        if io_logger is not None:
            elapsed = time.perf_counter() - t_start
            reasoning_text = capture.get("reasoning", "") or ""
            record: dict = {
                "timestamp": datetime.now().isoformat(),
                "item_id": item_id,
                "model": getattr(llm, "model", "?"),
                "elapsed_sec": round(elapsed, 3),
                "prompt_chars": sum(len((m.get("content") or "")) for m in messages),
                "completion_chars": len(text or ""),
                "reasoning_chars": len(reasoning_text),
                "status": "error" if error_info else "ok",
                **extra_fields,
                "messages": messages,
                "output_text": text,
                "reasoning_text": reasoning_text,
            }
            if error_info:
                record["error"] = error_info
            await io_logger.log(record)


# ----------------------------------------------------------------------------
# Cite key generation
# ----------------------------------------------------------------------------

_TITLE_STOPWORDS = {
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of",
    "on", "or", "the", "to", "via", "with", "without", "over", "under", "is",
    "are", "be", "based", "using", "towards", "toward",
}


def _short_title_token(title: str) -> str:
    if not title:
        return "Paper"
    words = re.findall(r"[A-Za-z][A-Za-z0-9]*", title)
    salient = [w for w in words if w.lower() not in _TITLE_STOPWORDS]
    if not salient:
        salient = words or ["Paper"]
    head = salient[0]
    head = head[:1].upper() + head[1:]
    if len(salient) >= 2 and len(head) <= 4:
        nxt = salient[1]
        head += nxt[:1].upper() + nxt[1:]
    return head[:24]


def _author_lastname(paper: dict) -> str:
    authors = paper.get("authors") or []
    if isinstance(authors, list) and authors:
        first = authors[0]
        if isinstance(first, dict):
            name = first.get("name") or first.get("normalized_name") or ""
        else:
            name = str(first)
    else:
        name = ""
    if not name:
        return "Anon"
    if "," in name:
        last = name.split(",", 1)[0].strip()
    else:
        last = name.strip().split()[-1] if name.strip() else "Anon"
    last = re.sub(r"[^A-Za-z]", "", last) or "Anon"
    return last[:1].upper() + last[1:]


def make_cite_key(paper: dict) -> str:
    """Build Author+Year+ShortTitle cite key from paper metadata.

    Falls back gracefully when authors / year / title are missing.
    """
    if paper.get("bibtex_id"):
        return str(paper["bibtex_id"]).strip()
    if paper.get("cite_key"):
        return str(paper["cite_key"]).strip()
    last = _author_lastname(paper)
    year = paper.get("year") or paper.get("publication_year") or "0000"
    short = _short_title_token(paper.get("title") or "")
    return f"{last}{year}{short}"


_BIBTEX_HEADER_RE = re.compile(r"^@(\w+)\s*\{\s*([^,\s]+)\s*,", re.MULTILINE)
_BIBTEX_UNESCAPED_AMP_RE = re.compile(r"(?<!\\)&")
_BIBTEX_FIELD_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<field>year|journal)"
    r"(?P<gap>\s*=\s*)"
    r"(?P<open>\{?)(?P<value>[^,}\n]*?)(?P<close>\}?)"
    r"(?P<tail>\s*,?\s*)$",
    re.IGNORECASE,
)
_BIBTEX_BAD_YEAR_VALUES = {"", "0", "none", "null", "n.d."}
_BIBTEX_BAD_JOURNAL_VALUES = {"", "manuscript", "none", "null"}


_BIBTEX_URL_FIELDS = frozenset({
    "url", "doi", "eprint", "howpublished", "archiveprefix", "primaryclass",
})

_BIBTEX_VALUE_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<field>[A-Za-z][A-Za-z0-9_-]*)"
    r"(?P<gap>\s*=\s*)\{(?P<value>.*)\}(?P<tail>\s*,?\s*)$"
)

_BIBTEX_VALUE_ESCAPES = (
    (re.compile(r"(?<!\\)_"), r"\\_"),
    (re.compile(r"(?<!\\)%"), r"\\%"),
    (re.compile(r"(?<!\\)#"), r"\\#"),
    (re.compile(r"(?<!\\)\^"), r"\\^{}"),
    (re.compile(r"(?<!\\)~"), r"\\textasciitilde{}"),
    (re.compile(r"(?<!\\)\$"), r"\\$"),
)

_BIBTEX_MATH_REGION_RE = re.compile(r"(\$[^$]+\$|\\\(.+?\\\))")


def _escape_field_value(value: str) -> str:
    """Escape LaTeX text-mode specials in a BibTeX field value, preserving
    $...$ and \\(...\\) math regions so legitimate inline math (e.g. $O(n^2)$)
    survives. Negative lookbehinds avoid double-escaping already-escaped chars.
    """
    out: list[str] = []
    for i, seg in enumerate(_BIBTEX_MATH_REGION_RE.split(value)):
        if i % 2:
            out.append(seg)
            continue
        for pat, rep in _BIBTEX_VALUE_ESCAPES:
            seg = pat.sub(rep, seg)
        out.append(seg)
    return "".join(out)


def _escape_bibtex_for_latex(entry: str) -> str:
    # Semantic Scholar's citationStyles.bibtex passes journal/booktitle names
    # like "Physics in Medicine & Biology" through verbatim; an unescaped &
    # crashes xelatex with "Misplaced alignment tab character &" once the
    # .bbl is read back in. BibTeX syntax never uses & itself, so escaping
    # every unescaped & in the entry text is safe.
    #
    # The other text-mode specials (_ % # ^ ~ $) also crash xelatex when they
    # leak in from scraped titles/abstracts (e.g. "Benchmark^2"), but they
    # cannot be blanket-substituted across the whole entry: cite keys may
    # contain "_" (would break \cite resolution) and url/doi values contain
    # "_" "~" "#" "%" verbatim. So they are escaped per field-value, skipping
    # the @Type{key,...} header and the URL-family fields.
    entry = _BIBTEX_UNESCAPED_AMP_RE.sub(r"\\&", entry)
    out_lines: list[str] = []
    for line in entry.split("\n"):
        m = _BIBTEX_VALUE_LINE_RE.match(line)
        if not m or m.group("field").lower() in _BIBTEX_URL_FIELDS:
            out_lines.append(line)
            continue
        new_value = _escape_field_value(m.group("value"))
        out_lines.append(
            f"{m.group('indent')}{m.group('field')}{m.group('gap')}"
            f"{{{new_value}}}{m.group('tail')}"
        )
    return "\n".join(out_lines)


def _inject_card_fields(entry: str, card: dict | None, meta: dict | None = None) -> str:
    """Inject abstract, TLDR note, has_parse_dict, reading_depth (from
    `03_process/paper_cards.json` — `card`), and venue name (from
    `02_retrieval/selected_paper.json` — `meta.venue.name`) into a BibTeX
    entry. Note: `venue` is intentionally duplicated with the `journal` field
    that _synthesise_bibtex_entry / _patch_verbatim_bibtex already derive
    from the same source — downstream consumers asked for both.
    """
    venue_meta = meta.get("venue") if isinstance(meta, dict) else None
    venue_name = ""
    if isinstance(venue_meta, dict):
        venue_name = (venue_meta.get("name") or "").strip()
    elif isinstance(venue_meta, str):
        venue_name = venue_meta.strip()
    if not card and not venue_name:
        return entry
    card = card or {}
    abstract = (card.get("abstract") or "").strip()
    cf = card.get("common_fields")
    tldr = ""
    if isinstance(cf, dict):
        tldr = (cf.get("tldr") or "").strip()
    has_parse_dict = card.get("has_parse_dict")
    reading_depth = (card.get("reading_depth") or "").strip() if isinstance(card.get("reading_depth"), str) else card.get("reading_depth")
    if not abstract and not tldr and has_parse_dict is None and not reading_depth and not venue_name:
        return entry
    abstract = abstract.replace("{", "").replace("}", "")
    tldr = tldr.replace("{", "").replace("}", "")
    venue_name = venue_name.replace("{", "").replace("}", "")
    lines = entry.split("\n")
    # Detect indentation from existing field lines
    indent = " "
    for ln in lines:
        m = re.match(r"^([ \t]+)\w+\s*=", ln)
        if m:
            indent = m.group(1)
            break
    extra_lines: list[str] = []
    if abstract:
        extra_lines.append(f"{indent}abstract = {{{abstract}}},")
    if tldr:
        extra_lines.append(f"{indent}tldr = {{{tldr}}},")
    if has_parse_dict is not None:
        extra_lines.append(f"{indent}has_parse_dict = {{{str(bool(has_parse_dict)).lower()}}},")
    if reading_depth:
        extra_lines.append(f"{indent}reading_depth = {{{reading_depth}}},")
    if venue_name:
        extra_lines.append(f"{indent}venue = {{{venue_name}}},")
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].lstrip().startswith("}"):
            for j in range(i - 1, -1, -1):
                if not lines[j].strip():
                    continue
                if not lines[j].rstrip().endswith(",") and not lines[j].lstrip().startswith("@"):
                    lines[j] = lines[j].rstrip() + ","
                break
            lines[i:i] = extra_lines
            break
    return "\n".join(lines)


def render_bibtex_entry(cite_key: str, meta: dict, card: dict | None = None) -> str:
    """Return a BibTeX entry for `cite_key`, preferring upstream-provided
    `citationStyles.bibtex` when present, falling back to a synthesised entry.

    Upstream `selected_paper.json` may include:
        "citationStyles": {"bibtex": "@Article{Wu2025ASO,...}\n"}
    The cite_key we derive in `make_cite_key` already prefers `bibtex_id`, so
    when the upstream block exists its first-line key matches `cite_key`. We
    still rewrite the first-line key defensively in case of future drift.

    The entry type is an inherited Claude Code compatibility contract: preserve
    the upstream type byte-for-byte (including ``@Conference``); when upstream
    BibTeX is absent, `_synthesise_bibtex_entry` always emits ``@Article``.
    Never infer or remap the type from venue/publication metadata.

    The upstream bibtex string may itself be missing year/journal or contain
    placeholder values (year=0, journal=Manuscript). When that happens we
    patch with the top-level `year` / `venue` fields from `selected_paper.json`
    rather than letting the bad values leak into the rendered PDF.

    When `card` (from paper_cards.json) is provided, `abstract` and
    `common_fields.tldr` are appended as BibTeX fields.
    """
    cs = meta.get("citationStyles")
    raw = ""
    if isinstance(cs, dict):
        raw = (cs.get("bibtex") or "").strip()
    if raw:
        m = _BIBTEX_HEADER_RE.search(raw)
        if m:
            current_key = m.group(2)
            if current_key != cite_key:
                raw = raw.replace(f"{{{current_key},", f"{{{cite_key},", 1)
            raw = _patch_verbatim_bibtex(raw, meta)
            raw = _inject_card_fields(raw.rstrip(), card, meta=meta)
            return _escape_bibtex_for_latex(raw)

    entry = _synthesise_bibtex_entry(cite_key, meta)
    entry = _inject_card_fields(entry, card, meta=meta)
    return _escape_bibtex_for_latex(entry)


def _resolve_top_level_year(meta: dict) -> str:
    return str(meta.get("year") or meta.get("publication_year") or "").strip()


def _resolve_top_level_journal(meta: dict) -> str:
    venue = meta.get("venue")
    if isinstance(venue, dict):
        name = (venue.get("name") or "").strip()
        if name:
            return name
    elif isinstance(venue, str):
        if venue.strip():
            return venue.strip()
    return (meta.get("journal") or "").strip()


def _patch_verbatim_bibtex(raw: str, meta: dict) -> str:
    """Patch year/journal in an upstream bibtex string with top-level metadata
    when the bibtex value itself is missing or a placeholder. Drops the field
    entirely (instead of writing 0 / Manuscript) when neither source has it.
    """
    top_year = _resolve_top_level_year(meta)
    top_journal = _resolve_top_level_journal(meta)

    lines = raw.split("\n")
    out: list[str] = []
    had_year = False
    for line in lines:
        m = _BIBTEX_FIELD_LINE_RE.match(line)
        if not m:
            out.append(line)
            continue
        field = m.group("field").lower()
        value = m.group("value").strip().strip('{}"\'').lower()
        indent = m.group("indent")
        gap = m.group("gap")
        tail = m.group("tail")
        if field == "year":
            had_year = True
            if value not in _BIBTEX_BAD_YEAR_VALUES:
                out.append(line)
            elif top_year:
                out.append(f"{indent}year{gap}{{{top_year}}}{tail}")
            # else: drop the placeholder year line entirely
        else:  # journal
            if value not in _BIBTEX_BAD_JOURNAL_VALUES:
                out.append(line)
            elif top_journal:
                out.append(f"{indent}journal{gap}{{{top_journal}}}{tail}")
            # else: drop the placeholder journal line entirely

    if not had_year and top_year:
        # Inject before the first line that starts the closing brace.
        for i in range(len(out) - 1, -1, -1):
            if out[i].lstrip().startswith("}"):
                inject_indent = "  "
                for j in range(i - 1, -1, -1):
                    if not out[j].strip():
                        continue
                    m_indent = re.match(r"^([ \t]+)", out[j])
                    if m_indent:
                        inject_indent = m_indent.group(1)
                    # The line that was previously last needs a trailing comma
                    # so the injected field follows clean BibTeX syntax.
                    if not out[j].rstrip().endswith(",") and not out[j].lstrip().startswith("@"):
                        out[j] = out[j].rstrip() + ","
                    break
                out.insert(i, f"{inject_indent}year = {{{top_year}}},")
                break

    return "\n".join(out)


def _synthesise_bibtex_entry(cite_key: str, meta: dict) -> str:
    # Claude Code compatibility: missing upstream citationStyles.bibtex always
    # fell back to @Article.  Do not "improve" this by guessing from venue,
    # publication_types, booktitle, or any later metadata enrichment.
    title = (meta.get("title") or "").replace("{", "").replace("}", "").strip()
    year = meta.get("year") or meta.get("publication_year") or ""
    authors = meta.get("authors") or []
    if isinstance(authors, list) and authors:
        author_str = " and ".join(
            (a.get("name") if isinstance(a, dict) else str(a)) or ""
            for a in authors[:8]
        ).strip(" and ") or "Anonymous"
    else:
        author_str = "Anonymous"
    eids = meta.get("external_ids") or {}
    arxiv = eids.get("ArXiv") or eids.get("arxiv") or meta.get("arxiv_id") or ""
    doi = eids.get("DOI") or eids.get("doi") or meta.get("doi") or ""
    venue = meta.get("venue")
    journal = ""
    if isinstance(venue, dict):
        journal = venue.get("name") or ""
    if not journal:
        journal = meta.get("journal") or ""
    if not journal and arxiv:
        journal = f"arXiv preprint arXiv:{arxiv}"
    lines = [
        f"@Article{{{cite_key},",
        f"  title  = {{{title}}},",
        f"  author = {{{author_str}}},",
    ]
    if year:
        lines.append(f"  year   = {{{year}}},")
    if journal:
        lines.append(f"  journal= {{{journal}}},")
    for field in ("booktitle", "volume", "number", "pages", "publisher", "url"):
        value = meta.get(field)
        if value:
            lines.append(f"  {field} = {{{value}}},")
    if arxiv:
        lines.append(f"  eprint = {{{arxiv}}},")
        lines.append("  archiveprefix = {arXiv},")
    if doi:
        lines.append(f"  doi    = {{{doi}}},")
    lines.append("}")
    return "\n".join(lines)


def build_cite_key_map(selected_papers: dict, paper_cards: dict | None = None,
                       preassigned: dict | None = None) -> dict:
    """Return paperId -> cite_key, deduplicating collisions with letter suffixes.

    `preassigned` carries keys an earlier stage already committed to — in this
    pipeline, `03_process/cite_keys.json` written by
    `scripts/processing/build_bib.py`. Those keys are adopted verbatim and
    reserved before anything is derived, so a paper that arrived later can never
    be handed a key that is already in use, and a key never shifts between
    stages. That matters more than it looks: the outline and every section draft
    are written against these keys, so a key that changes after drafting turns
    each `\\cite{}` already written into a dangling reference.

    Note on the suffix alphabet: the first collision gets `…b`, not `…a`
    (`suffix` is incremented before the character is derived). That is the
    shipped behaviour, every artefact in an existing workspace is keyed by it,
    and it is unambiguous — it just is not the off-by-one it looks like.
    """
    out: dict[str, str] = {}
    used: set[str] = set()
    cards = paper_cards or {}

    for pid in sorted(preassigned or {}):
        key = str((preassigned or {})[pid] or "").strip()
        if not key or pid not in selected_papers or key in used:
            continue
        out[pid] = key
        used.add(key)

    for pid in sorted(selected_papers.keys()):
        if pid in out:
            continue
        merged = dict(selected_papers[pid])
        if pid in cards:
            for k, v in cards[pid].items():
                merged.setdefault(k, v)
        key = make_cite_key(merged)
        base = key
        suffix = 0
        while key in used:
            suffix += 1
            key = f"{base}{chr(ord('a') + suffix)}"
        used.add(key)
        out[pid] = key
    return out


_BIB_ENTRY_START_RE = re.compile(r"^@(\w+)\s*\{\s*([^,\s]+)\s*,")


def parse_bibtex_entries(text: str) -> dict[str, str]:
    """Split a .bib file into `cite_key -> entry text`.

    Written for the files this skill produces (`03_process/references.bib`),
    where every entry starts at column 0 with `@Type{key,` and ends at the
    line whose closing brace balances it. `%` comment lines between entries are
    skipped. Brace counting — rather than splitting on blank lines — is what
    keeps a multi-line abstract field, which `_inject_card_fields` writes, from
    being cut in half.

    A field value containing an unbalanced literal brace would confuse this, but
    `render_bibtex_entry` strips braces out of every value it synthesises, so no
    file this skill writes contains one.
    """
    entries: dict[str, str] = {}
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        match = _BIB_ENTRY_START_RE.match(lines[i])
        if not match:
            i += 1
            continue
        key = match.group(2)
        depth = 0
        buffer: list[str] = []
        while i < len(lines):
            line = lines[i]
            buffer.append(line)
            depth += line.count("{") - line.count("}")
            i += 1
            if depth <= 0:
                break
        entries[key] = "\n".join(buffer).rstrip()
    return entries


# ----------------------------------------------------------------------------
# Outline traversal
# ----------------------------------------------------------------------------


def iter_leaf_sections(outline: dict):
    """Yield (parent_section_dict | None, leaf_section_dict). A leaf is a
    section without subsections; if a top-level section has subsections, only
    its subsections are leaves.
    """
    for sec in outline.get("outline_tree", []):
        subs = sec.get("subsections") or []
        if subs:
            for sub in subs:
                yield sec, sub
        else:
            yield None, sec


def iter_all_sections(outline: dict):
    for sec in outline.get("outline_tree", []):
        yield None, sec
        for sub in sec.get("subsections") or []:
            yield sec, sub


def section_label(section_id: str) -> str:
    from writing_contract import section_label as shared_label
    return shared_label(section_id)


def fix_broken_refs(tex: str) -> str:
    """Fix \\ref targets that don't match any \\label in the document.

    Handles the common LLM mistake of writing \\ref{sec:2} instead of
    \\ref{sec:s2} (missing the 's' prefix that section_label() prepends).
    """
    import re as _re

    defined = set(_re.findall(r"\\label\{([^}]+)\}", tex))
    if not defined:
        return tex

    def _fix_match(m):
        full = m.group(0)
        target = m.group(1)
        if target in defined:
            return full
        candidate = "sec:s" + target.removeprefix("sec:")
        if candidate in defined:
            return full.replace(target, candidate)
        return full

    return _re.sub(r"\\ref\{([^}]+)\}", _fix_match, tex)


# ----------------------------------------------------------------------------
# Light text utils
# ----------------------------------------------------------------------------


# CJK Unicode ranges covering CJK Unified Ideographs (incl. Ext A/B) and
# common CJK punctuation/symbols. Used to make word-counting language-aware
# so Chinese drafts are not severely undercounted by bare `str.split()`.
_CJK_RANGES = (
    (0x3000, 0x303F),    # CJK Symbols and Punctuation
    (0x3400, 0x4DBF),    # CJK Unified Ideographs Extension A
    (0x4E00, 0x9FFF),    # CJK Unified Ideographs
    (0xF900, 0xFAFF),    # CJK Compatibility Ideographs
    (0xFF00, 0xFFEF),    # Halfwidth and Fullwidth Forms
    (0x20000, 0x2A6DF),  # CJK Unified Ideographs Extension B
)


def _is_cjk_char(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def _effective_word_count(text: str) -> int:
    """Language-aware effective word count.

    English tokens are counted by whitespace split. CJK characters are
    counted individually then divided by 1.6 (the academic-prose ratio
    between a Chinese 字 and an English word). The two are summed so the
    same length thresholds work for mixed-language drafts.
    """
    if not text:
        return 0
    cjk = sum(1 for ch in text if _is_cjk_char(ch))
    non_cjk = "".join(" " if _is_cjk_char(ch) else ch for ch in text)
    en = len(non_cjk.split())
    return en + int(round(cjk / 1.6))


def latex_word_count(tex: str) -> int:
    t = re.sub(r"\\[a-zA-Z]+\*?\{[^}]*\}", " ", tex)
    t = re.sub(r"\\[a-zA-Z]+\*?", " ", t)
    t = re.sub(r"[{}%]", " ", t)
    return _effective_word_count(t)


def shorten(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def format_paper_card(card: dict | None, meta: dict, *, depth: str = "full") -> dict:
    """Flat pass-through view of one paper card for figure/table generators.

    Returns the full raw card content untouched — no field selection, no
    `shorten()` truncation, no list trimming — re-arranged into the flat
    shape that figure/table collectors already consume (common_fields.*
    splatted at top-level; card.* dict children kept as sub-dicts; card.*
    scalar children splatted at top-level).

    Pure-metadata bookkeeping fields are dropped: `paperId`, `info_type`,
    `has_parse_dict`, `reading_depth` carry no paper content and would only
    add noise to the LLM context.

    `depth` is accepted but ignored, kept for callers that still pass it.

    Output shape (only keys with content present):
      title, year, paper_type, relevance_level, abstract,
      tldr, research_question, core_contribution, innovation_points,
      key_results, limitations, future_work, claims,
      background, problem, idea, conclusion,
      method:         { ...raw method dict... },
      experiments:    { ...raw experiments dict... },
      discussion:     { ...raw discussion dict... },
      summary:        { ...raw summary dict... },
      analysis:       { ...raw analysis dict... },
      survey_outline: { ...raw survey_outline dict... }
    """
    del depth  # explicit: figure/table generators get the full card too
    card = card or {}
    out: dict = {
        "title": card.get("title") or meta.get("title", ""),
        "year": card.get("year") or meta.get("year", ""),
        "paper_type": card.get("paper_type") or meta.get("paper_type", ""),
        "relevance_level": card.get("relevance_level") or meta.get("relevance_level", ""),
    }
    abstract = card.get("abstract") or meta.get("abstract")
    if abstract:
        out["abstract"] = abstract

    cf = card.get("common_fields")
    if isinstance(cf, dict):
        for k, v in cf.items():
            if v not in (None, "", [], {}):
                out[k] = v

    inner = card.get("card")
    if isinstance(inner, dict):
        for k, v in inner.items():
            if v in (None, "", [], {}):
                continue
            # Dict-valued card.* children stay as sub-dicts; scalars and
            # lists get splatted to top-level (matches the prior flat shape
            # and the way figure/table prompts already consume these).
            out[k] = v
    return out


# Card paths a survey drafter actually argues from. Everything here answers
# "what did this paper claim, how does it work, what did it try it on, and where
# does it fall short" — the evidence a technical survey needs to define shared
# objects, explain representative mechanisms, and compare papers rather than
# merely introduce them.
#
# `experiments.datasets` / `.baselines` / `.metrics` were out of this set until
# a run came back where twelve of fourteen subsections held a single paragraph
# and the user's complaint was "很多论文一句话带过, 缺少对比". They are back, and
# the reasoning that removed them was the mistake: what a method was evaluated
# on and against is not reproduction-level detail, it is the only ground on
# which two papers can be compared at all. A writer that cannot see that two
# systems were measured on the same benchmark can only introduce them one after
# the other, which is exactly the prose that came back.
#
# Method descriptions, formulas and ablations are deliberately in. They were
# once treated as reproduction-only detail, but removing them left technical
# writers unable to state a common problem formally or explain why two methods
# differ. The view remains bounded: it contains structured extractions for this
# section's assigned papers, never raw full text or neighbouring sections' cards.
_DRAFTING_CARD_PATHS = frozenset({
    "card.problem", "card.idea", "card.conclusion", "card.background",
    "card.method.name", "card.method.description", "card.method.key_components",
    "card.method.key_formulas", "card.method.novelty",
    "card.discussion.limitations", "card.discussion.strengths",
    "card.discussion.conclusions", "card.discussion.open_questions",
    "card.discussion.future_work", "card.discussion.future_directions",
    "card.discussion.recommendations",
    "card.experiments.datasets", "card.experiments.baselines",
    "card.experiments.metrics", "card.experiments.ablation_findings",
    "card.experiments.key_results", "card.experiments.key_findings",
    "card.experiments.models_evaluated", "card.experiments.human_performance",
    "card.summary.scope", "card.summary.taxonomy", "card.summary.key_themes",
    "card.summary.total_papers_reviewed",
    "card.analysis.trends", "card.analysis.comparisons", "card.analysis.open_problems",
    "card.survey_outline.sections",
    "card.theorem_proof.main_results", "card.theorem_proof.key_assumptions",
    "card.theorem_proof.key_formulas", "card.theorem_proof.proof_technique",
    "card.theorem_proof.formal_guarantees",
    "card.implication.theoretical_impact", "card.implication.practical_implications",
    "card.implication.connections",
    "card.dataset.name", "card.dataset.description", "card.dataset.size",
    "card.dataset.source", "card.dataset.splits",
    "card.metrics.primary_metrics", "card.metrics.evaluation_protocol",
    "card.other_info",
})

def format_paper_card_nested(card: dict | None, meta: dict, *,
                             depth: str = "full", scope: str = "speed") -> dict:
    """Nested view of a paper card, mirroring the raw `paper_cards.json` shape.

    Two depths, and the difference is what the consumer is going to write:

    - **`full`** — every `common_fields.*` and `card.*` field untouched.
    - **`drafting`** — section-writing fields only (`_DRAFTING_CARD_PATHS`),
      with every selected value preserved in full. This is what a section
      writer gets.

    `drafting` exists because the worklist is the delivery vehicle for the
    corpus and the multiplication is unforgiving: a section with 21 assigned
    papers embedded 112 KB of cards, and its writer spent about half its
    runtime reading them before writing a word. Per-section item files removed
    that cross-section amplification. The drafting view therefore drops raw
    full text and unselected card fields, but never truncates a selected
    abstract, string, list, formula, or nested value.

    Top-level metadata (`title`, `year`, `paper_type`, `relevance_level`,
    `abstract`) is sourced from the card first, falling back to `meta`.

    Figure-rendering and table-generation call `format_paper_card()` instead
    (the flat full-card variant) and are unaffected by either depth.
    """
    card = card or {}
    trimmed = depth == "drafting"
    del scope  # execution profile does not change section-writing evidence
    out: dict = {
        "title": card.get("title") or meta.get("title", ""),
        "year": card.get("year") or meta.get("year", ""),
        "paper_type": card.get("paper_type") or meta.get("paper_type", ""),
        "relevance_level": card.get("relevance_level") or meta.get("relevance_level", ""),
    }
    abstract = card.get("abstract") or meta.get("abstract")
    if abstract:
        out["abstract"] = abstract

    cf = card.get("common_fields")
    if isinstance(cf, dict) and cf:
        # `common_fields` is already the extraction's own distillation — tldr,
        # core contribution, innovation points, limitations, claims. It is the
        # highest-value part of the card per byte, so it is preserved whole.
        out["common_fields"] = cf

    inner = card.get("card")
    if isinstance(inner, dict) and inner:
        if not trimmed:
            out["card"] = inner
            return out
        kept: dict = {}
        for key, value in inner.items():
            if isinstance(value, dict):
                sub = {
                    sk: sv
                    for sk, sv in value.items()
                    if f"card.{key}.{sk}" in _DRAFTING_CARD_PATHS
                }
                if sub:
                    kept[key] = sub
            elif f"card.{key}" in _DRAFTING_CARD_PATHS:
                kept[key] = value
        if kept:
            out["card"] = kept
    return out


# ----------------------------------------------------------------------------
# JSON repair from LLM output (used by validation scripts)
# ----------------------------------------------------------------------------


def extract_json(text: str) -> Any:
    """Tolerant JSON extraction from LLM output. Handles ```json fences and
    leading/trailing prose. Used by validation scripts that read agent
    output — the agent itself writes raw JSON via Write.
    """
    if not text:
        raise ValueError("Empty input")
    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```", text)
    if fence:
        text = fence.group(1)
    text = text.strip()
    first_obj = text.find("{")
    first_arr = text.find("[")
    starts = [s for s in (first_obj, first_arr) if s >= 0]
    if not starts:
        raise ValueError(f"No JSON object/array found: {text[:200]!r}")
    start = min(starts)
    snippet = text[start:]
    for end in range(len(snippet), 0, -1):
        try:
            return json.loads(snippet[:end])
        except json.JSONDecodeError:
            continue
    raise ValueError(f"Could not parse JSON: {snippet[:200]!r}")


# ---------------------------------------------------------------------------
# LaTeX command normalization — repair two malformations the drafting LLM
# emits often enough to break both the cite-key scan and the pdflatex compile.
# Shared by validate_drafts / validate_refined (so the source JSON is clean)
# and phase05b_insert_assets (final choke point before v3 + citations.bib).
#
#   1. `\ cite{...}` / `\ citet{...}` / `\ citep{...}` — a stray space between
#      the backslash and the command name. natbib never sees the command (so
#      the citation is lost) AND every `\\cite[tp]?\{` scan (bib generation,
#      whitelist enforcement) misses the key. A space after `\` before a
#      command name is always a typo, never intended LaTeX → fix unconditionally.
#
#   2. `\$\beta\$` / `\$\alpha_t\$` — the LLM escaped the math delimiters, so
#      `\$` renders a literal dollar and `\beta` lands in text mode →
#      `Missing $ inserted`. We rewrite `\$...\$` back to `$...$` ONLY when the
#      span (a) contains a math macro (lookahead) and (b) consists solely of
#      math-atom characters — no whitespace, no CJK. That keeps subscripts /
#      superscripts like `\$\alpha_t\$` while never touching a literal dollar
#      amount such as `\$5 到 \$10`, whose space/CJK content fails the charset.
# ---------------------------------------------------------------------------
_BAD_SPACED_CITE_RE = re.compile(r"\\[ \t]+(cite[tp]?)\b")
_ESCAPED_MATH_MACRO_RE = re.compile(
    r"\\\$"                                            # opening escaped delimiter
    r"(?=[^$]*\\[A-Za-z])"                             # ...must contain a math macro
    r"((?:\\[A-Za-z]+|[A-Za-z0-9_^{}()+\-.,|*/])+)"   # math atoms only (no space/CJK)
    r"\\\$"                                            # closing escaped delimiter
)


def normalize_latex_commands(text: str) -> tuple[str, dict[str, int]]:
    """Repair `\\ cite`-style and `\\$macro\\$`-style LaTeX malformations.

    Returns the cleaned text plus a per-pattern hit count for status
    reporting. Idempotent — already-correct `\\citet` / `$\\beta$` are left
    untouched, so it is safe to run at multiple pipeline stages.
    """
    text, n_cite = _BAD_SPACED_CITE_RE.subn(r"\\\1", text)
    text, n_math = _ESCAPED_MATH_MACRO_RE.subn(r"$\1$", text)
    return text, {"spaced_cite": n_cite, "escaped_math_macro": n_math}
