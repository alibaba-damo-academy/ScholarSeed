"""Abstract-only preparation and one-pass Markdown writing for Quick mode."""

import argparse
import asyncio
import json
import shutil
from pathlib import Path

from bibliography import resolve as resolve_citations, read_information
from citation_identity import normalize_citations, require_evidence_references, referenced_keys
from evidence import read, save
from generation_errors import GenerationError, diagnostic
from load_model_config import load_stage_config
from paper_materials import evidence_records, require_ready, text_present
from platform_io import file_lock
from processing.build_bib import build as build_bibliography
from scripted_generation import invoke
from strategy import QUICK, require_capabilities
from task_contract import publication_view, read_request
from task_input import task_input
from planning import require_plan
from writing_prompt_guidance import MANUSCRIPT_WRITING_GUIDANCE, TASK_GUIDANCE

SELECTED = "02_retrieval/selected_paper.json"
KEYS = "03_process/cite_keys.json"
BIBLIOGRAPHY = "03_process/references.bib"
REPORT = "02_retrieval/fulltext_report.json"
PACKET = "05_generation/_internal/quick_packet.json"
STATUS = "_status/writing.json"
DRAFT_GUIDANCE = r"""Write the entire requested deliverable in one Markdown response.
The supplied original abstracts are the complete scientific evidence for this
draft. Establish what each paper actually studies and reports before developing
the requested synthesis. Preserve the subject, task, comparison reference,
outcome, qualifications and certainty of each statement as a connected claim.
Keep a claimed benefit attached to the comparison for which it was reported.
Method details, causal explanations, proof conditions and capability limits
require support in these abstracts; leave unspecified details unspecified.
Missing evidence of a capability does not establish that the method lacks it.

Compare papers on dimensions for which their abstracts supply comparable
evidence. Distinct research objects or contribution roles can be discussed
together without asserting a common learning objective, causal relationship,
historical progression or general superiority. State the actual relationship
and its evidence limits. Keep any proposed interpretation qualified and separate
from findings attributed to a source; do not turn familiar technical background
into an unreported result of that paper. Qualify or omit unsupported comparisons.

Citations in this editable source use each paper's exact citation_token, such as
\cite{Smith2024}. The user's numeric citation style is the final display style:
the publisher assigns numbers after drafting. Copy citation_token at the claim,
including grouped keys inside one cite command. Paper order is not a citation
identity. This source protocol keeps each attribution bound to its actual paper. No sentence
IDs or evidence-card extraction are required. The publisher supplies references.
Choose the form and organization from original_user_requests and effective_requirements.
A focused question needs a direct answer and supporting synthesis; a method comparison
needs comparable dimensions; a paper summary or report needs the requested lens.
Use a full survey structure only when the user requests a full survey. A requested
chapter stays a chapter, and a paragraph stays a paragraph. Plan the narrative
internally in this same call: establish the question, group evidence by the requested
axes, connect findings with explicit transitions, and finish with an answer whose
certainty matches the abstracts. Prefer synthesis over a paper-by-paper catalogue.
Use clear Markdown headings, coherent paragraphs and compact tables when helpful;
match the requested language, length and local section instructions. Supply a title
only when appropriate to the requested form. Cite substantive source attributions
with the exact supplied keys and leave bibliography assembly to the publisher.
Quick supports prose, headings, lists, Markdown tables and mathematical source text.
Images and non-Markdown delivery belong to Standard. Return raw Markdown, without
a JSON wrapper or a surrounding code fence. This is the only drafting call; keep
the abstract, body and conclusion consistent within this response."""


def prepare_abstracts(workspace):
    workspace = Path(workspace)
    request = read_request(workspace)
    if request.get("execution", {}).get("mode") != QUICK:
        raise ValueError("abstract-only preparation belongs to Quick mode")
    require_capabilities(request)
    records = evidence_records(workspace)
    if not records:
        raise ValueError("Quick requires actual supplied or retrieved abstracts")
    missing = [
        identity for identity, paper in records.items() if not text_present(paper.get("abstract"))
    ]
    if missing:
        raise ValueError(
            "Quick requires actual abstracts for every selected paper; provide abstracts or choose Standard: "
            + ", ".join(missing)
        )
    report, status = build_bibliography(workspace, include_cards=False)
    if status["status"] == "FAILED":
        raise ValueError(status.get("status_reason", "bibliography construction failed"))
    save(
        workspace / REPORT,
        {
            "total_papers": len(records),
            "with_full_text": 0,
            "abstract_only": len(records),
            "coverage": 0,
            "network_downloads": 0,
            "network_downloads_scope": "original_sources_only",
            "sources_enabled": ["abstract"],
            "papers": [
                {"paper_id": identity, "outcome": "abstract_only", "source": "abstract", "chars": 0}
                for identity in records
            ],
        },
    )
    return {
        "status": status["status"],
        "stage": "processing",
        "evidence_kind": "abstract",
        "abstract_count": len(records),
        "model_calls": 0,
        "cards_extracted": 0,
        "network_downloads": 0,
        "network_downloads_scope": "original_sources_only",
        "bibliography": report,
    }


def manuscript_packet(workspace):
    workspace = Path(workspace)
    require_ready(workspace)
    require_plan(workspace)
    request = read_request(workspace)
    if request.get("execution", {}).get("mode") != QUICK:
        raise ValueError("single-pass Markdown writing belongs to Quick mode")
    require_capabilities(request)
    keys = read(workspace / KEYS)
    records = evidence_records(workspace)
    task = task_input(workspace)
    if isinstance(task.get("sources"), dict):
        task["sources"] = {"policy": task["sources"].get("policy")}
    packet = {
        "task": task,
        "language": request["language"],
        "output_scope": request["output_scope"],
        "papers": [
            {
                "cite_key": keys[identity],
                "citation_token": "\\cite{" + keys[identity] + "}",
                **{key: paper.get(key) for key in ("title", "authors", "year", "abstract")},
            }
            for identity, paper in records.items()
        ],
        "output_format": "markdown",
        "evidence_kind": "abstract",
        "citation_protocol": {
            "source": "Copy papers[].citation_token for inline citations; the publisher converts these keys to numeric references.",
            "final_style": "numeric",
        },
    }
    generation = workspace / "05_generation"
    generation.mkdir(parents=True, exist_ok=True)
    if not (generation / "full_draft_v2.md").exists():
        shutil.copyfile(workspace / BIBLIOGRAPHY, generation / "citations.bib")
        save(
            generation / "publication.json",
            {
                **publication_view(request),
                "language": request["language"].lower(),
                "output_scope": request["output_scope"],
            },
        )
        save(workspace / PACKET, packet)
    return packet


async def generate(workspace, config=None, client=None):
    workspace = Path(workspace).resolve()
    generation = workspace / "05_generation"
    (generation / "_internal").mkdir(parents=True, exist_ok=True)
    with file_lock(generation / "_internal/quick.lock"):
        packet = manuscript_packet(workspace)
        destination = generation / "full_draft_v2.md"
        if destination.exists():
            return {
                "status": "SUCCESS",
                "state": "main_editable",
                "artifact": str(destination),
                "model_calls": 0,
            }
        config = config or load_stage_config("chapter_generation")
        if not config:
            raise GenerationError(
                "INPUT_MISSING", "Quick writing needs the configured chapter-generation model"
            )
        status = {
            "status": "RUNNING",
            "state": "drafting",
            "pipeline": "abstract_markdown",
            "model_calls": 0,
            "refinement": "not_scheduled",
            "cards_extracted": 0,
        }
        save(workspace / STATUS, status)
        try:
            text, metrics = await invoke(
                workspace,
                "quick_draft",
                [
                    {
                        "role": "system",
                        "content": TASK_GUIDANCE
                        + "\n"
                        + MANUSCRIPT_WRITING_GUIDANCE
                        + "\n"
                        + DRAFT_GUIDANCE,
                    },
                    {"role": "user", "content": json.dumps(packet, ensure_ascii=False)},
                ],
                config,
                client=client,
                json_output=False,
            )
            request = read_request(workspace)
            keys = read(workspace / KEYS)
            text, _repairs = normalize_citations(text.strip() + "\n", keys)
            save(generation / "full_draft_v1.md", text)
            require_evidence_references(text, keys.values())
            if not referenced_keys(text):
                raise GenerationError(
                    "CITATION_IDENTITIES_MISSING",
                    "The draft has no keyed source citations; preserve the raw response. Numeric labels alone do not identify papers.",
                    next_action="Recover keyed citations from explicit source attribution in the draft; if identity is ambiguous, retain the failure rather than infer a mapping from paper order.",
                )
            save(destination, text)
            status.update(
                status="SUCCESS",
                state="main_editable",
                artifact=str(destination),
                model_calls=metrics["model_calls"],
                next_action="Start the publication step in_progress using progress, then run workflow publish. Inspect the Markdown file and deliver it.",
            )
            save(workspace / STATUS, status)
            return status
        except Exception as error:
            status.update(status="FAILED", state="failed", error=diagnostic(error))
            save(workspace / STATUS, status)
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare",))
    parser.add_argument("workspace", type=Path)
    args = parser.parse_args()
    try:
        if read_request(args.workspace).get("execution", {}).get("mode") != QUICK:
            raise ValueError("abstract preparation belongs to Quick mode")
        information = read_information(args.workspace)
        lookup = asyncio.run(resolve_citations(args.workspace, read(args.workspace / SELECTED), information))
        result = prepare_abstracts(args.workspace)
        result['bibliographic_metadata_lookup'] = lookup
        report = read(args.workspace / REPORT)
        report['bibliographic_metadata_lookup'] = {key: value for key, value in lookup.items() if key != 'items'}
        save(args.workspace / REPORT, report)
    except (ValueError, OSError) as error:
        print(json.dumps(diagnostic(error), ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
