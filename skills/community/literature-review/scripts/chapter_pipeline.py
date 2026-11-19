"""Native chapter generation, join completed figures, refine full v1 into v2."""

from __future__ import annotations

import asyncio
import copy
import json
import time
from pathlib import Path

from abstract_contract import (
    ABSTRACT_CHAPTER_GUIDANCE,
    ABSTRACT_GUIDANCE,
    ABSTRACT_REPAIR_GUIDANCE,
    inspect_abstracts,
)
from asset_plan import derive
from authoring import authoring_task, context_message
from bibliography_contract import inspect_bibliography
from chapter_plan import GLOBAL_EVIDENCE_ROLES, cards_plain, compile_plan
from citation_identity import authoring_view, normalize_citations, require_evidence_references
from evidence import read, save
from figure_caption import CAPTION_CONTENT_GUIDANCE
from generation_errors import GenerationError, diagnostic
from manuscript_delta import REFINE_GUIDANCE, apply_delta
from manuscript_publication import precompile
from native_document import assemble, chapter_frame, complete_chapter, extension, figure_files
from paper_materials import is_quick
from platform_io import file_lock
from precheck import (
    PARTIAL,
    SOURCE_PRECHECK_NOTES,
    SOURCE_PRECHECK_REPORT,
    SOURCE_PRECHECK_TIMEOUT_KEY,
    TIMEOUT,
    TIMEOUT_SECONDS,
    UNAVAILABLE,
    diagnostic_notes,
    precheck,
    source_hash,
)
from quick import generate as generate_quick
from repetition import repetition_notes
from templates import LATEX_AUTHORING_GUIDANCE
from usage import WRITING_STAGES, accumulate, summarize
from writing_contract import digest, read_request, section_label
from writing_prompt_guidance import MANUSCRIPT_WRITING_GUIDANCE, TASK_GUIDANCE

PUBLISH_ACTION = (
    "After inspecting v2 and before workflow publish, read host update_plan/get and finish the actual writing step. "
    "Read get again, then start the actual publication step using the new revision. "
    "Call the host tool directly with its declared schema; no saved response file or progress CLI is needed. "
    "Run workflow publish only after publication is in_progress; inspect and deliver the actual file, "
    "then read get and finish that step. Preserve original request arguments for an uncertain retry."
)

CHAPTER_GUIDANCE = (
    r"""Write the assigned chapter as a raw native continuation: LaTeX for
latex_pdf, Markdown for markdown. The script records its ID and assembles it.

CHAPTER SCOPE AND OPENING
Complete the assigned analytical tasks within the explicit scope and length.
Select relevant supported evidence: the complete card set supplies context, not
a requirement to repeat every fact. Preserve local instructions and confirmed
subsection titles. The last message supplies the
script-written opening: continue after it. Direct children of \section use
\subsection with supplied labels; children of ## use ###. Start with prose when
no subheading is needed. An abstract is prose only; its closing wrapper is scripted.
An unsectioned component has no invented heading. Output contains neither a JSON
wrapper, code fence, repeated opening nor a complete document/template/byline.

LANGUAGE AND EVIDENCE
The packet's output_language governs authored content. Standard
technical symbols, terms and proper names may retain their normal form. Use only
supplied citation keys. LaTeX source uses \citep{key} or \citet{key}; Markdown and
DOCX authoring source uses \cite{key}. Keep these identity-bearing tokens until
publication. The publisher renders the requested numeric or author-year labels
and reference entries. Preserve mathematical structure with native math syntax:
LaTeX math in LaTeX source, dollar-delimited math in Markdown and DOCX authoring
source, or unambiguous prose. Keep operators, grouping and upper/lower roles;
escape only literal prose special characters, without JSON-escaping native output.

ASSET OWNERSHIP
document_asset_assignments identifies the sections responsible for the whole
document's requested assets. These are assignments, not completion reports:
chapters run concurrently. Fulfill this chapter's part without duplicating assets
assigned elsewhere; use prose comparisons when another section owns the table.
asset_contract is the complete local asset permission list, derived from the
confirmed outline. Broader evidence, navigation and other chapters' assets supply
context, not permission to add a table or image here. Empty tables means zero
tables; express comparisons in prose. Otherwise write each listed table exactly
once beneath its specified section/subsection, using its label, dimensions,
allowed evidence and caption meaning. Write native tables, not table JSON.
A chapter-owned asset may appear within that chapter's subsections. An asset
assigned to a specific subsection stays within that subsection; PDF float-page
placement does not change its source ownership.
Figure assets have a different owner: this chapter supplies explanation and
references only (LaTeX: Figure~\ref{fig:F1}, Chinese: 图~\ref{fig:F1}). The figure
branch and assembler supply the image, environment, label and caption together;
the continuation contains no figure wrapper, includegraphics, placeholder or
caption for them. Table references likewise use labels, not guessed print numbers.

"""
    + r"""
CONCURRENT HANDOFF
Resolve notation from the confirmed scope and supplied materials. Author only this chapter's
scope and assets. The request states whether whole-document refinement is scheduled.
Each response must satisfy its contract regardless of that later stage.
"""
)
CHAPTER_SYSTEM = TASK_GUIDANCE + "\n" + MANUSCRIPT_WRITING_GUIDANCE + "\n" + CHAPTER_GUIDANCE

TABLE_AUTHORING_GUIDANCE_LATEX = r"""TABLE AUTHORING CONTRACT
The publication preamble supplies booktabs, array, tabularx and longtable.
This chapter owns planned tables. Write each one exactly once at its scientifically
appropriate point within its assigned owner and discuss it in surrounding prose.
Use only asset_contract.tables; preserve each table_id, tab: label, comparison
dimensions, allowed citation keys and scientific caption meaning. Render the
caption content in one \caption{...} followed by its \label{tab:T1}; LaTeX supplies
the display number. A legacy numbered caption is rewritten as descriptive content.

Choose the environment from the column layout and the expected wrapped cell
height. In the single-column NeurIPS preprint, standard Chinese and ICLR
templates, use a standalone longtable by default for study-by-study comparisons
with sentences in multiple columns (mechanism, question, finding or limitation).
Even a handful of such rows can fill a page. Put the table immediately after
the paragraph that first cites it, before the discussion moves on. Let it
break between rows. Write the caption and label once, end that row with \\,
and repeat just the column headings with \endfirsthead and \endhead.
Size each longtable column as a share of the actual text width, including its
padding. Use p{\dimexpr <share>\linewidth-2\tabcolsep\relax} with shares
summing to at most 1. For example, a four-column comparison might allocate
.18, .16, .32 and .34; the first specification would be
>{\raggedright\arraybackslash}p{\dimexpr.18\linewidth-2\tabcolsep\relax}.
Choose shares for the actual columns and give longer prose more space. Use
this expression for every column instead of estimating widths in centimeters.
Plain longtable has no stretching X column.
Keep it outside table, table*, resizebox and minipage so page breaks work.

For compact tables of short labels or numbers, use table with a width-bounded
tabularx and wrapping X columns as needed. In a two-column body (IEEE, ICML,
AAAI), keep the venue layout: use a column-width table or a compact full-width
table*. Split a tall comparison into coherent labeled parts if needed, retaining
the planned identity, evidence and dimensions. Use longtable only in a permitted
single-column section. Use only the packages already supplied by the template.
Reserve l/c/r columns for short atomic values.

Keep cells concise; move shared qualifications to the caption or
surrounding prose without losing meaning. Render citation keys only through
\citet{...} or \citep{...}; never expose raw cite keys or long unbreakable ASCII
strings as cell text. Use \toprule, \midrule and \bottomrule, without vertical
rules, \hline or a stray backslash after a rule command. Every evidence-bearing
row cites supplied evidence. Use \resizebox{\linewidth}{!}{...} only as a last
resort because it can make text unreadably small.

Before returning, silently verify equal cell counts across rows, wrapping for all
free-text columns, presence of every planned label, absence of duplicate tables,
and that no table can exceed \linewidth."""

TABLE_AUTHORING_GUIDANCE_MARKDOWN = r"""TABLE AUTHORING CONTRACT
This chapter owns planned tables. Write each one exactly once at its scientifically
appropriate point, preserve its supplied table_id, scientific caption meaning, comparison dimensions and allowed citation
keys. Put <a id="tab:T1"></a> immediately before its descriptive caption and pipe
table, using the supplied label. Discuss it in surrounding prose. The list in
asset_contract.tables is exhaustive; keep cells concise and evidence-backed."""

TABLE_REPAIR_GUIDANCE = r"""TABLE LAYOUT REPAIR
Deterministic preflight found problems only in the tables listed in
table_layout_warnings. Repair every reported problem while preserving each
affected table's scientific meaning, label, citations, units,
qualifications, rows and comparison dimensions. Restrict table-layout changes
to the listed tables; continue the document-wide prose refinement above.
Asset-contract warnings are a separate repair scope; caption wording may change
to remove self-numbering.

Make each affected table width-bounded by \linewidth and fit its height to a page
or use a standalone multipage longtable with repeated headers. Preserve the
planned caption/label and rows; do not nest longtable inside a float or scaling
box. Move long qualifications out of l/c/r columns into wrapping columns or
table notes. For single-column prose comparisons, preserve or restore a standalone
longtable near the first callout. Allocate its p columns as shares of \linewidth
with 2\tabcolsep subtracted from each share. Use wrapping X columns only in a compact
tabularx. Respect the venue's two-column layout. Replace inappropriate l/c/r columns,
keep fixed widths conservative, and shorten only redundant wording without losing
meaning. Use resizebox{\linewidth}{!} only when a readable tabularx design is not
feasible. Compilation alone is insufficient: resolve the reported structural
layout problems in the returned source delta."""


def chapter_asset_contract(packet):
    return {
        "tables": copy.deepcopy(packet.get("shared_tables", [])),
        "figures": copy.deepcopy(packet.get("shared_figures", [])),
    }


def chapter_system(packet, table_template=None):
    if packet.get("chapter_kind") == "abstract":
        sections = [TASK_GUIDANCE, ABSTRACT_GUIDANCE, ABSTRACT_CHAPTER_GUIDANCE]
    else:
        sections = [TASK_GUIDANCE, MANUSCRIPT_WRITING_GUIDANCE, CHAPTER_GUIDANCE]
    if packet.get("output_format") == "latex_pdf":
        sections.insert(1, LATEX_AUTHORING_GUIDANCE)
    if packet.get("shared_figures") and packet.get("chapter_kind") != "abstract":
        sections.append(
            "At each owned figure callout, use the surrounding paragraph to explain "
            "the scientific relationship in its content_plan: what connects or changes, "
            "under which conditions, and why it matters here. Cite the supporting work. "
            "The caption introduces the comparison; develop it with evidence in the prose. "
            "Write from the confirmed plan and evidence; "
            "colors, line styles and panel positions are decided separately by the figure author."
        )
    if packet.get("shared_tables") and packet.get("chapter_kind") != "abstract":
        if table_template and packet.get("output_format") == "latex_pdf":
            sections.append(f"Active LaTeX publication template: {table_template}.")
        sections.append(CAPTION_CONTENT_GUIDANCE)
        sections.append(
            TABLE_AUTHORING_GUIDANCE_LATEX
            if packet.get("output_format") == "latex_pdf"
            else TABLE_AUTHORING_GUIDANCE_MARKDOWN
        )
    sections.append(
        "One whole-document refinement follows assembly. Produce a complete chapter now."
    )
    return "\n".join(sections)


def chapter_messages(packet, cite_keys=None, *, table_template=None):
    original = packet
    packet = copy.deepcopy(packet)
    packet["asset_contract"] = chapter_asset_contract(packet)
    if cite_keys is not None:
        packet = authoring_view(packet, cite_keys)
    scope = packet["asset_contract"]
    evidence = packet.pop("evidence", "")
    if "task" in packet:
        packet["task"] = authoring_task(packet["task"])
    outline = packet.pop("confirmed_full_outline", {})
    assigned = packet.pop("assigned_sections", [])
    packet["document_context"] = {
        key: value
        for key, value in outline.items()
        if key not in ("outline_tree", "figures", "tables")
        and packet.get(key) != value
        and not any(node.get(key) == value for node in assigned)
    }

    def local_plan(node):
        result = {
            key: copy.deepcopy(value)
            for key, value in node.items()
            if key not in ("figures", "tables", "subsections")
        }
        if node.get("section_id"):
            result["label"] = section_label(node["section_id"])
        if "subsections" in node:
            result["subsections"] = [local_plan(child) for child in node["subsections"]]
        return result

    packet["chapter_plan"] = [local_plan(node) for node in assigned]
    for field in (
        "shared_tables",
        "shared_figures",
        "required_asset_refs",
        "local_asset_labels",
        "required_output_sections",
        "chapter_opening",
        "chapter_closing",
    ):
        packet.pop(field, None)
    messages = [
        {"role": "system", "content": chapter_system(original, table_template)},
        {"role": "user", "content": context_message(packet, evidence)},
    ]
    packet = original
    if "chapter_opening" not in packet:
        tail = "This previously prepared task expects body-only text. Return the assigned body without its top-level heading or abstract wrapper."
    elif packet["chapter_kind"] == "component":
        tail = "Complete the requested unsectioned component. There is no fixed heading. Return only its native content, without a chapter heading."
    elif packet["chapter_kind"] == "abstract":
        tail = (
            "The abstract opening below has already been written. Write the complete abstract body "
            "after it, omitting the supplied opening and scripted closing wrapper.\n\n"
            + packet["chapter_opening"]
        )
    else:
        tail = (
            "The section heading below has already been written. Write the complete remaining chapter body, "
            "including every subsection and analytical task in chapter_plan. "
            "Omit only this supplied heading; the requested output is the entire chapter body, "
            "not just its introductory paragraph.\n\n" + packet["chapter_opening"]
        )
    summary = (
        "Local asset scope: tables="
        + json.dumps([t["label"] for t in scope["tables"]])
        + "; figure callouts only="
        + json.dumps([f["label"] for f in scope["figures"]])
        + ". Use the supplied owners and caption content; printed numbering belongs to the publisher.\n"
    )
    return [*messages, {"role": "user", "content": summary + tail}]


def local_outline(outline, ids):
    return (
        {**outline, "outline_tree": [s for s in outline["outline_tree"] if s["section_id"] in ids]}
        if outline["outline_tree"]
        else outline
    )


def assets_for(asset_plan, ids):
    belongs = (
        lambda a: a["section_id"] is None
        and "component" in ids
        or a["section_id"] is not None
        and a["section_id"].split(".")[0] in ids
    )
    return {
        **asset_plan,
        "shared_tables": [a for a in asset_plan["shared_tables"] if belongs(a)],
        "shared_figures": [a for a in asset_plan["shared_figures"] if belongs(a)],
        "required_asset_refs": {
            sid: refs
            for sid, refs in asset_plan["required_asset_refs"].items()
            if sid.split(".")[0] in ids
        },
    }


def packet_for(jobs, plan, outline, assets, cards, keys, task, request, completed, format):
    ids = [j["section_id"] for j in jobs]
    paper_ids = list(dict.fromkeys(pid for j in jobs for pid in j["paper_ids"]))
    global_evidence = any(j["role"] in GLOBAL_EVIDENCE_ROLES for j in jobs)
    if global_evidence:
        paper_ids = list(cards)
    require_evidence_references(
        authoring_view([job["plan"] for job in jobs], keys),
        [keys[identity] for identity in paper_ids],
    )
    selected = local_outline(outline, ids)
    owned = assets_for(assets, ids)
    owned["shared_tables"] = [
        {
            **table,
            "allowed_cite_keys": [keys[p] for p in (table["paper_ids"] or paper_ids) if p in keys],
        }
        for table in owned["shared_tables"]
    ]
    global_task = authoring_task({k: v for k, v in task.items() if k != "section_instructions"})
    from language_plan import section_language

    owner = selected["outline_tree"][0] if selected.get("outline_tree") else {}
    default_language_value = request.get("language", "ENGLISH").lower()
    output_language = section_language(owner, default_language_value)
    packet = {
        "stage": "chapter_generation",
        "chapter_ids": ids,
        "task": global_task,
        "section_role": jobs[0]["role"],
        "default_language": default_language_value,
        "output_language": output_language,
        "language_source": (
            "default"
            if str(owner.get("language", "default")).lower() == "default"
            else "outline_override"
        ),
        "review_thesis": plan["review_thesis"],
        "organizing_axis": plan["organizing_axis"],
        "navigation": plan["navigation"],
        "document_asset_assignments": [
            {
                "asset_id": asset.get("table_id") or asset.get("figure_id"),
                "section_id": asset.get("section_id"),
                "section_title": next(
                    (
                        node.get("title", "")
                        for parent in outline.get("outline_tree", [])
                        for node in [parent, *parent.get("subsections", [])]
                        if node.get("section_id") == asset.get("section_id")
                    ),
                    "",
                ),
            }
            for kind in ("shared_tables", "shared_figures")
            for asset in assets[kind]
        ],
        "confirmed_full_outline": outline if global_evidence else selected,
        "assigned_sections": [j["plan"] for j in jobs],
        "local_instructions": {
            sid: text
            for sid, text in request.get("section_instructions", {}).items()
            if sid.split(".")[0] in ids
        },
        "assigned_paper_ids": paper_ids,
        "evidence": cards_plain(paper_ids, cards, keys, abstract=jobs[0]["role"] == "abstract"),
        "output_format": format,
        **{k: owned[k] for k in ("shared_figures", "shared_tables", "required_asset_refs")},
        "local_asset_labels": [
            a["label"] for kind in ("shared_figures", "shared_tables") for a in owned[kind]
        ],
        "required_output_sections": [
            {
                "section_id": s["section_id"],
                "publisher_title_do_not_repeat": s["title"],
                "required_subsection_headings": [
                    {"title": c["title"], "label": section_label(c["section_id"])}
                    for c in s.get("subsections", [])
                ],
            }
            for s in selected["outline_tree"]
        ],
        **chapter_frame(selected["outline_tree"][0] if selected["outline_tree"] else None, format),
    }
    return packet


def prepare_packets(ws, contract, outline, assets, cards, keys, task, spec):
    from load_model_config import load_stage_config
    from request_capacity import capacity

    request = read_request(ws)
    plan = compile_plan(outline, set(keys))
    cfg = load_stage_config("chapter_generation")
    entries = []
    for job in plan["jobs"]:
        packet = packet_for(
            [job],
            plan,
            outline,
            assets,
            cards,
            keys,
            task,
            request,
            {},
            "markdown" if spec["format"] == "docx" else spec["format"],
        )
        path = ws / "05_generation/_internal/chapter_packets" / f"{job['section_id']}.json"
        messages = chapter_messages(packet, keys)
        checked = capacity(messages, cfg) if cfg else None
        save(path, packet)
        entries.append({"section_id": job["section_id"], "path": str(path), "capacity": checked})
    save(ws / "05_generation/_internal/chapter_packets.json", {"packets": entries})
    return entries


async def generate(workspace, chapter_cfg=None, refine_cfg=None, client=None):
    if is_quick(workspace):
        return await generate_quick(workspace, config=chapter_cfg, client=client)
    ws = Path(workspace).resolve()
    internal = ws / "05_generation/_internal"
    internal.mkdir(parents=True, exist_ok=True)
    with file_lock(internal / "chapter_pipeline.lock"):
        return await _generate(ws, chapter_cfg, refine_cfg, client)


async def _generate(ws, chapter_cfg, refine_cfg, client):
    from load_model_config import load_stage_config
    from manuscript import prepare
    from scripted_generation import invoke, parse_response

    gen = ws / "05_generation"
    existing = next(
        (
            gen / f"full_draft_v2.{s}"
            for s in ("tex", "md")
            if (gen / f"full_draft_v2.{s}").exists()
        ),
        None,
    )
    if existing:
        from manuscript_publication import publication_source

        publication_source(ws)
        result = {
            "status": "SUCCESS",
            "state": "main_editable",
            "artifact": str(existing),
            "model_calls": 0,
            "next_action": "Edit v2 directly and run workflow publish.",
        }
        status_path = ws / "_status/writing.json"
        previous = read(status_path) if status_path.exists() else {}
        result = {**previous, **result}
        result.pop("error", None)
        result.pop("code", None)
        result.update(accumulate(previous, result, 0), model_usage=summarize(ws, WRITING_STAGES))
        result["elapsed_sec"] = result["cumulative"]["elapsed_sec"]
        result["model_calls"] = result["model_usage"]["totals"]["attempts"]
        save(status_path, result)
        return result
    saved_packet = read(gen / "refine.packet.json") if (gen / "refine.packet.json").exists() else {}
    if (
        (gen / "_internal/refinement_task.json").exists()
        or (gen / "refine.commit.json").exists()
        or "audit_contract" in saved_packet
    ):
        raise GenerationError(
            "LEGACY_WORKSPACE",
            "Preserve this historical audit task; use a new workspace for ordinary refinement.",
        )
    contract_path = gen / "_internal/manuscript_contract.json"
    if not contract_path.exists() or not (gen / "_internal/chapter_packets.json").exists():
        prepare(ws)
    contract = read(contract_path)
    if contract.get("pipeline") != "native_v2":
        raise GenerationError(
            "LEGACY_WORKSPACE",
            "Use a new workspace for native generation; import an existing publication source separately.",
        )
    spec = contract["publication"]
    suffix = extension(spec["format"])
    entries = read(gen / "_internal/chapter_packets.json")["packets"]
    packets = [read(e["path"]) for e in entries]
    cite_key_map = read(ws / "03_process/cite_keys.json")
    chapter_cfg = chapter_cfg or load_stage_config("chapter_generation")
    refine_cfg = refine_cfg or load_stage_config("refinement_delta")
    if not chapter_cfg or not refine_cfg:
        raise GenerationError(
            "INPUT_MISSING", "chapter and refinement model configurations required"
        )
    started = time.monotonic()
    status_path = ws / "_status/writing.json"
    previous = read(status_path) if status_path.exists() else {}
    status = {
        "status": "RUNNING",
        "state": "drafting",
        "pipeline": "native_v2",
        "model_calls": 0,
        "jobs": previous.get("jobs", {}),
    }

    def update(state=None):
        if state:
            status["state"] = state
        report = {
            **status,
            **accumulate(previous, status, time.monotonic() - started),
            "model_usage": summarize(ws, WRITING_STAGES),
        }
        report["elapsed_sec"] = report["cumulative"]["elapsed_sec"]
        report["model_calls"] = report["model_usage"]["totals"]["attempts"]
        save(status_path, report)

    update()
    semaphore = asyncio.Semaphore(read_request(ws)["chapter_concurrency"])

    async def author(packet):
        sid = packet["chapter_ids"][0]
        path = gen / "chapters" / f"{sid}.{suffix}"
        if status["jobs"].get(sid, {}).get("state") == "complete" and path.exists():
            return
        status["jobs"][sid] = {"state": "running"}
        update()
        messages = chapter_messages(packet, cite_key_map, table_template=spec.get("template"))
        try:
            async with semaphore:
                text, metrics = await invoke(
                    ws, "chapter_" + sid, messages, chapter_cfg, client=client, json_output=False
                )
            text, repairs = normalize_citations(text, cite_key_map)
            save(path, complete_chapter(packet, text))
            status["model_calls"] += metrics["model_calls"]
            status["jobs"][sid] = {
                "state": "complete",
                "path": str(path),
                "citation_id_repairs": repairs,
            }
        except Exception as exc:
            status["model_calls"] += getattr(exc, "context", {}).get("model_calls", 0)
            status["jobs"][sid] = {"state": "failed", "error": diagnostic(exc)}
            raise
        finally:
            update()

    try:
        # All siblings finish; only failed calls are attempted on a later resume.
        results = await asyncio.gather(
            *(author(packet) for packet in packets), return_exceptions=True
        )
        failures = [result for result in results if isinstance(result, BaseException)]
        if failures:
            raise failures[0]
        update("waiting_figures")
        deadline = time.monotonic() + refine_cfg.get("figure_wait_timeout_sec", 1800)
        while True:
            figure_path = gen / "_internal/figures_worklist.json"
            figures = read(figure_path)["items"] if figure_path.exists() else []
            if not figures:
                break
            report_path = gen / "_status/figures_plan_generate.json"
            report = read(report_path) if report_path.exists() else {}
            if report.get("status") == "SUCCESS" and not figure_files(ws, figures):
                break
            if report.get("status") in ("FAILED", "PARTIAL_SUCCESS"):
                raise GenerationError(
                    "FIGURES_FAILED",
                    "Retry the failed figure task, then resume manuscript generate; completed chapters remain.",
                )
            if time.monotonic() >= deadline:
                raise GenerationError(
                    "FIGURES_WAIT_TIMEOUT",
                    "Figures are not complete; finish the figure task and resume manuscript generate.",
                )
            await asyncio.sleep(0.5)
        v1 = gen / f"full_draft_v1.{suffix}"
        v2 = gen / f"full_draft_v2.{suffix}"
        if not v1.exists():
            update("assembling")
            outline = read(gen / "_internal/manuscript_outline.json")["outline"]
            assemble(ws, outline, packets, spec, figures)
        normalized, repairs = normalize_citations(v1.read_text(), cite_key_map)
        if repairs and (gen / "refine.packet.json").exists():
            raise GenerationError(
                "REFINEMENT_INPUT_CHANGED",
                "Preserved v1 would require citation changes; nothing overwritten",
            )
        if repairs:
            save(v1, normalized)
        update("refining")
        # V1 includes actual image wrappers/captions. Included text dependencies
        # are supplied in full as independent delta targets, never just paths.
        from native_asset_checks import inspect_chapter_figures, inspect_native_assets
        from native_table_layout import inspect_native_tables
        from publication_files import source_bundle

        packet_path = gen / "refine.packet.json"
        sources, paths = source_bundle(v1)
        if packet_path.exists():
            packet = read(packet_path)
            if packet.get("sources") != sources:
                raise GenerationError(
                    "REFINEMENT_INPUT_CHANGED",
                    "Current source bundle differs from preserved refinement packet; nothing overwritten",
                )
        else:
            packet = {
                "sources": sources,
                "output_format": spec["format"],
                "task": packets[0]["task"],
                "confirmed_outline": read(gen / "_internal/manuscript_outline.json")["outline"],
                "resolved_section_languages": contract.get("resolved_section_languages", {}),
            }
        planned_tables = []
        seen_tables = set()
        for chapter_packet in packets:
            for table in chapter_packet.get("shared_tables", []):
                if table["table_id"] not in seen_tables:
                    planned_tables.append(table)
                    seen_tables.add(table["table_id"])
        table_report = (
            inspect_native_tables(sources["main"], planned_tables)
            if suffix == "tex"
            else {"status": "SUCCESS", "tables_checked": 0, "issues": []}
        )
        save(gen / "_status/table_layout_precheck.json", table_report)
        request_packet = dict(packet)
        request_packet.pop("table_layout_warnings", None)
        request_packet["task"] = authoring_task(request_packet["task"])
        request_packet.pop("evidence", None)
        request_packet["output_format"] = "markdown" if suffix == "md" else "latex_pdf"
        request_packet["resolved_section_languages"] = contract.get(
            "resolved_section_languages", {}
        )
        asset_plan = derive(request_packet["confirmed_outline"])
        asset_report = inspect_native_assets(sources, asset_plan, request_packet["output_format"])
        chapters = {
            p["chapter_ids"][0]: (gen / "chapters" / f"{p['chapter_ids'][0]}.{suffix}").read_text()
            for p in packets
        }
        chapter_warnings = inspect_chapter_figures(chapters, request_packet["output_format"])
        asset_report["issues"].extend(chapter_warnings)
        asset_report["status"] = "WARNING" if asset_report["issues"] else "SUCCESS"
        save(gen / "_status/asset_contract_precheck.json", asset_report)
        request_packet.pop("asset_contract_warnings", None)
        if asset_report["issues"]:
            request_packet["asset_contract_warnings"] = asset_report["issues"]
        refine_guidance = REFINE_GUIDANCE
        bibliography_report = inspect_bibliography(sources, suffix == "md")
        request_packet.pop("bibliography_warnings", None)
        if bibliography_report["issues"]:
            request_packet["bibliography_warnings"] = bibliography_report["issues"]
        abstract_report = inspect_abstracts(sources["main"], packets)
        save(gen / "_status/abstract_precheck.json", abstract_report)
        request_packet.pop("abstract_warnings", None)
        if any(p.get("chapter_kind") == "abstract" for p in packets):
            request_packet["abstract_instructions"] = [
                {
                    "section_id": p["chapter_ids"][0],
                    "output_language": p["output_language"],
                    "local_instructions": p.get("local_instructions", {}),
                }
                for p in packets
                if p.get("chapter_kind") == "abstract"
            ]
            refine_guidance += "\n" + ABSTRACT_REPAIR_GUIDANCE
        if abstract_report["issues"]:
            request_packet["abstract_warnings"] = abstract_report["issues"]
        if table_report["issues"]:
            request_packet["table_layout_warnings"] = table_report["issues"]
            refine_guidance += "\n" + TABLE_REPAIR_GUIDANCE
        if suffix == "tex" and not packet_path.exists():
            request_packet.pop("compilation_diagnostics", None)
            request_packet.pop("publication_requirements", None)
            compilation = await asyncio.to_thread(precompile, ws, v1)
            save(gen / "_status/compilation_precheck.json", compilation)
            if compilation["status"] == "FAILED":
                request_packet["compilation_diagnostics"] = {
                    "errors": compilation["errors"],
                    "task": "Repair the reported LaTeX source errors in the supplied document while preserving its mathematical meaning and existing content.",
                }
            elif compilation["status"] != "SUCCESS":
                request_packet["publication_requirements"] = (
                    LATEX_AUTHORING_GUIDANCE
                    + "\nEnsure the complete document uses these template facilities and repair inconsistent mathematical notation and dependencies."
                )
        source_check = None
        source_notes = ""
        if suffix == "md":
            check_path = gen / SOURCE_PRECHECK_REPORT
            if packet_path.exists():
                if not check_path.is_file():
                    raise GenerationError(
                        "REFINEMENT_INPUT_CHANGED",
                        "Saved refinement has no source precheck; use a fresh workspace without overwriting this task",
                    )
                source_check = read(check_path)
            else:
                source_check = await asyncio.to_thread(
                    precheck,
                    ws,
                    v1,
                    spec["format"],
                    contract.get("language", "english"),
                    timeout_seconds=refine_cfg.get(SOURCE_PRECHECK_TIMEOUT_KEY, TIMEOUT_SECONDS),
                )
                save(check_path, source_check)
            if (
                source_check.get("source_sha256") != source_hash(v1)
                or source_check.get("requested_format") != spec["format"]
                or v1.read_text() != sources["main"]
            ):
                raise GenerationError(
                    "REFINEMENT_INPUT_CHANGED",
                    "Source precheck does not match the frozen manuscript and delivery format; nothing overwritten",
                )
            source_notes = diagnostic_notes(source_check, contract.get("language", "english"))
        request_packet["refinement_protocol"] = "source-delta/v1"
        repetition_text = repetition_notes(
            sources["main"], request_packet["output_format"], contract.get("language", "english")
        )
        notes = "\n\n".join(text for text in (source_notes, repetition_text) if text)
        messages = [
            {"role": "system", "content": refine_guidance},
            {
                "role": "user",
                "content": json.dumps(
                    authoring_view(request_packet, cite_key_map), ensure_ascii=False
                ),
            },
        ]
        if notes:
            messages.append({"role": "user", "content": notes})
        response = gen / "refine.response.txt"
        delta_path = gen / "delta.json"
        receipt_path = gen / "refine.receipt.json"
        identity = digest(
            {
                "packet": authoring_view(request_packet, cite_key_map),
                "repetition_notes": repetition_text,
                **({"source_precheck_notes": source_notes} if source_check is not None else {}),
                "guidance": refine_guidance,
                "config": refine_cfg,
                "citation_keys": cite_key_map,
            }
        )
        if packet_path.exists() and read(packet_path) != request_packet:
            raise GenerationError(
                "REFINEMENT_INPUT_CHANGED",
                "Preserved refinement inputs differ; nothing overwritten",
            )
        if not response.exists():
            if receipt_path.exists():
                raise GenerationError(
                    "REFINEMENT_INCOMPLETE",
                    "Response is missing from a completed call; preserve its receipt and logs",
                )
            save(packet_path, request_packet)
            if repetition_text:
                save(gen / "repetition.txt", repetition_text)
            if source_notes:
                save(gen / SOURCE_PRECHECK_NOTES, source_notes)
            text, metrics = await invoke(
                ws, "refinement_delta", messages, refine_cfg, client=client, json_output=False
            )
            status["model_calls"] += metrics["model_calls"]
            save(
                receipt_path,
                {"identity": identity, "response_sha256": digest(text), "metrics": metrics},
            )
            save(response, text)
        else:
            receipt = read(receipt_path) if receipt_path.exists() else {}
            if receipt.get("identity") != identity or receipt.get("response_sha256") != digest(
                response.read_text()
            ):
                raise GenerationError(
                    "REFINEMENT_INPUT_CHANGED",
                    "Response does not match its saved inputs; preserve completed work",
                )
        delta = parse_response(response.read_text())
        save(delta_path, delta)
        result, applied = apply_delta(sources, delta)
        # All validation precedes writes. Retain frozen included files with v1.
        for target, text in result.items():
            text, repairs = normalize_citations(text, cite_key_map)
            result[target] = text
        post_table_report = (
            inspect_native_tables(result["main"], planned_tables)
            if suffix == "tex"
            else {"status": "SUCCESS", "tables_checked": 0, "issues": []}
        )
        save(gen / "_status/table_layout_postcheck.json", post_table_report)
        post_asset_report = inspect_native_assets(
            result, asset_plan, request_packet["output_format"]
        )
        save(gen / "_status/asset_contract_postcheck.json", post_asset_report)
        post_abstract_report = inspect_abstracts(result["main"], packets)
        save(gen / "_status/abstract_postcheck.json", post_abstract_report)
        for target, text in result.items():
            if target != "main":
                save(paths[target], text)
        save(v2, result["main"])
        status.update(
            status="SUCCESS",
            artifact=str(v2),
            **applied,
            **({"source_precheck": source_check} if source_check is not None else {}),
            abstract=post_abstract_report,
            asset_contract=post_asset_report,
            table_layout=post_table_report,
            refinement_applied=True,
            next_action="Edit v2 and its dependencies directly. " + PUBLISH_ACTION,
        )
        if post_abstract_report["issues"]:
            status["next_action"] = (
                "Review abstract default deviations against user/template exceptions; repair v2 directly where needed. "
                + PUBLISH_ACTION
            )
        if source_check is not None and source_check.get("status") in (
            PARTIAL,
            TIMEOUT,
            UNAVAILABLE,
        ):
            status["next_action"] = (
                "Source precheck was incomplete; inspect source_precheck and retain publication and visual verification. "
                + status["next_action"]
            )
        update("main_editable")
        return read(status_path)
    except BaseException as exc:
        if status.get("state") == "refining":
            status["refinement_applied"] = False
            save(
                gen / "refine.error.json",
                diagnostic(exc) if isinstance(exc, Exception) else {"code": "CANCELLED"},
            )
        status.update(
            status="FAILED",
            error=diagnostic(exc) if isinstance(exc, Exception) else {"code": "CANCELLED"},
        )
        update()
        raise
