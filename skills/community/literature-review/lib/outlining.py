"""Request-local outline instructions and reversible model-facing paper identities."""

import copy
import hashlib
import json
import re

from authoring import authoring_task, context_message
from citation_identity import LITERAL_FIELDS
from figure_caption import CAPTION_CONTENT_GUIDANCE
from strategy import QUICK
from writing_prompt_guidance import EVIDENCE_GUIDANCE

ADAPTER_VERSION = 2
ALIAS_PREFIX = "P"
ALIAS_WIDTH = 2
SURVEY = "survey"
SECTION = "section"
REFERENCE_FIELDS = {"paper_ids": "paper_id", "cite_keys": "cite_key"}
NARRATIVE_FIELDS = frozenset(
    (
        "description",
        "review_thesis",
        "organizing_axis",
        "requirement",
        "question",
        "completion",
        "axes",
        "purpose",
        "content_plan",
        "caption_draft",
        "qualifications",
        "visual_guidance",
        "warnings",
    )
)
REFERENCE_TOKEN = re.compile(
    r"\\(?P<literal>\[\[paper:[^\[\]\n]+\]\]|P\d+(?![A-Za-z0-9_]))|\[\[paper:(?P<alias>[^\[\]\n]+)\]\]"
)
BARE_ALIAS = re.compile(r"(?<![A-Za-z0-9_\\])P\d+(?![A-Za-z0-9_])")
SURVEY_FIELDS = {"Survey outline", "Legacy survey outline"}
ASSET_KINDS = ("figure_count", "table_count")

COMMON = """Plan exactly the requested deliverable; return one JSON object, not prose.
User requirements and scoped exceptions override defaults and examples. Preserve
their subject, analytical lens, requested facets, language and qualitative size.
Covering every requested facet does not mean writing an entire paper. A corpus
size or API capacity is not a word budget. Do not invent numeric length quotas.
If existing scope and explicit requirements conflict, retain the conflict in
warnings; do not silently expand or narrow the task.
Use the supplied paper aliases for attribution; do not invent author names.
Evidence informs the argument, not a structural template.
Compare mechanisms and conditions rather than listing papers. Do not prewrite
conclusions, formulas, table cells or chapter prose. Do not invent the host
paper's method, contributions, novelty or claims about earlier/later chapters.
The publisher owns the bibliography: no References/Bibliography/参考文献 outline
node. Corpus counts belong only where needed to describe the requested scope or method.
In narrative fields, including description, completion and warnings, express
paper references as [[paper:P01]]. Prefix a literal
alias or literal reference marker with a backslash, such as \\P01 or
\\[[paper:P01]]. The adapter removes that escape without creating a reference.
Structural IDs, user quotations and code are not references.
Warnings are optional unresolved issues requiring action; use [] when none,
not routine material-status notices or normal publisher responsibilities.
""" + "\n" + EVIDENCE_GUIDANCE

SCOPES = {
    SURVEY: """COMPLETE SURVEY
Plan the requested complete review. Unless the task excludes them, a full review
normally includes an abstract, introduction, thematic body and conclusions.
Explicit required/forbidden sections take priority. A descriptive document title,
shared background and cross-chapter transitions are appropriate only when useful.
Reference survey directories may inform organizing axes, not be copied wholesale.
""",
    SECTION: """SINGLE COMPONENT
The deliverable is a component, not a complete paper. Resolve its particular genre
and granularity from the supplied task without inventing missing host-paper context.
For a requested paragraph, leave survey_title empty, use outline_tree=[] and describe its internal argument
sequence; do not manufacture headings. For one requested chapter/section, use one
top-level node with optional internal subsections, not a set of peer paper chapters.
If the task explicitly requests multiple selected components, preserve that scope.
If paragraph versus chapter remains unclear, state that uncertainty and preserve
their shared component boundary; do not expand to a complete document.
Do not add a separate abstract, introduction, background chapter, paper roadmap,
whole-paper conclusion or future-work chapter just to make the output complete.
This does not prohibit a requested abstract, introduction or other named component.
Put necessary definitions, comparisons and synthesis inside the requested unit.
For Related Work, classify and compare relevant approaches within that unit;
requested analytical dimensions are not a mandate to create peer paper chapters.
Use reference taxonomies as evidence, not their full-document directories.
""",
}
UNRESOLVED = """UNRESOLVED SCOPE
No recognized structured output scope is available. Preserve the task's wording,
identify its requested deliverable and record genuine ambiguity in warnings.
Do not assume a full review or impose a single paragraph without task support.
"""

STRUCTURE = """OUTPUT CONTRACT
Keep the existing field names. Root: survey_title (the current deliverable's title,
possibly empty for a component), topic, description, outline_tree, review_thesis,
organizing_axis; optional warnings.
review_thesis means this deliverable's question/argument, not a predetermined result.
For unsectioned prose, describe the internal argument in description and leave
outline_tree empty. Do not create background nodes to satisfy a schema.
For sectioned output, each L1 node has section_id (unique numeric string), title,
description, language (default|chinese|english), role, paper_ids,
analysis_tasks; optional subsections, figures, tables.
Roles: foundation|background|introduction|analysis|synthesis|conclusion|abstract|component.
L2 has section_id (parent.child), title, description; optional paper_ids, figures,
tables. L2 inherits language and has no language key. No third level.
Use default language unless the user requests a local exception. Required abstract
uses section_id "0". Honor required_outline_nodes and structure_contract.
Every analysis node needs at least one analysis_task: task_id, kind
(explain|compare|formalize|assess|synthesize), question, completion, optional axes.
Assign plain supporting aliases such as "P01" directly in each chapter/subsection's
paper_ids, including sources needed for its definitions and analytical tasks.
Chapters are authored independently in parallel. Put necessary concepts, notation
and evaluation conventions in local descriptions or analysis_tasks, not a separate
execution graph. Preserve the requested reading order without waiting on other chapters.
"""

ASSETS = """ASSET PLANNING
Figures/tables are optional, not a completeness requirement. If the user fixed counts,
carry their exact bounds into this plan and allocate matching assets across sections.
When counts were left automatic, decide from the actual evidence and narrative needs;
zero is valid. The initial agreement does not invent a numeric asset quota. Respect explicit
counts and exclusions. Include an asset only if it serves this deliverable's
argument and granularity; do not turn a prose paragraph into an illustrated paper.
Nest assets once under their exact L1/L2 owner, using unique F1/T1-style IDs.
No root figures/tables for a nonempty outline_tree. An unsectioned table-only
component may have root tables with null ownership; root figures are unsupported.
Each asset has purpose, content_plan, caption_draft, paper_ids and optional
qualifications (an array of nonempty strings). Figures have figure_id and optional visual_guidance; tables have
table_id, row_unit, comparison_dimensions. Final columns are
[row_unit, *comparison_dimensions]. Keep drawing guidance separate from content.
purpose explains why this asset serves the argument; content_plan specifies what
it compares or shows, retaining scientific conditions. Row/column fields do not replace them.
For each figure, use purpose to state the question a reader should be able to
answer by looking. Choose a visual task that fits it (e.g. follow a mechanism,
compare alternatives on a shared axis, or trace a family tree). In content_plan
identify the essential visible relationship and the evidence that justifies it.
For a conceptual overview, plan a drawable scene. Start content_plan with
what the reader sees an object do, what changes between the compared cases,
and where a combined case shares a component. Treat method families as peers.
For comparisons, suggest a shared alignment or neighboring panels and leave
connector routing to the illustrator. Give each group room for its labels.
Use directional flow for relationships that have an order. Keep study names and
variants in the chapter's analysis_task and paper_ids unless the user wants
a taxonomy, timeline or named examples in the picture. A broad overview can
cover several families through one representative operation per family.
Draft a caption that introduces the subject and gives the reader a useful
scientific distinction. Leave extended interpretation, examples and limitations
to the owning paragraph. Preserve everything explicitly requested in the
figure. Carry any requested style, palette and in-image language into the relevant
figure's visual_guidance, respecting whether it applies locally or across figures.
Empty asset paper_ids leaves the corpus eligible, not permission to invent evidence.
Omit unused optional fields, or use their typed empty values: "qualifications": []
and "visual_guidance": "". With a supported qualification, use an array such as
"qualifications": ["Compare results only under matched evaluation conditions"].
These optional values are not null; required purpose/content_plan/caption_draft remain nonempty.
Do not author final cells or image prompts at this stage.
"""

QUICK_ASSETS = """QUICK MARKDOWN TABLES
Quick supports prose and Markdown tables, with no figure branch.
Plan a table when it serves the requested comparison. Assign unique T1, T2-style
table_id values. caption_draft is the caption text; code supplies its number.
Each table has table_id,
purpose, content_plan, caption_draft, paper_ids, row_unit and comparison_dimensions.
Place it under its owning section or subsection; use root tables only for an
unsectioned table component. Figures require a Standard-mode agreement.
"""

FINAL = """FINAL CHECK
First check the deliverable boundary: is this exactly the requested document or
component, or have its internal themes become an unsolicited whole paper?
Then check qualitative length, required/forbidden nodes, evidence relevance,
paper aliases, L1/L2 language placement, unique asset ownership and every required
asset field, including nonempty purpose and content_plan. Omit irrelevant
retrieved papers; shared words in titles do not establish topical relevance.
Return only the JSON object. Examples illustrate shapes, not mandatory content.
"""


def _example(scope, include_table=True, include_figure=True):
    root = {
        "survey_title": "",
        "topic": "Requested topic",
        "description": "Compare the requested mechanisms and their limits.",
        "review_thesis": "How do the relevant approaches differ?",
        "organizing_axis": "Mechanisms and conditions",
        "outline_tree": [],
    }
    section = {
        "section_id": "1",
        "title": "Requested section",
        "description": "Compare mechanisms within this unit.",
        "language": "default",
        "role": "analysis",
        "paper_ids": ["P01", "P02"],
        "analysis_tasks": [
            {
                "task_id": "A1",
                "kind": "compare",
                "question": "Which conditions distinguish the approaches?",
                "completion": "Compare [[paper:P01]] and [[paper:P02]] using their supported differences and limits.",
            }
        ],
    }
    if include_table:
        section["tables"] = [
            {
                "table_id": "T1",
                "purpose": "Make supported differences in mechanisms and applicability visible.",
                "content_plan": "Compare [[paper:P01]] and [[paper:P02]] on mechanisms, conditions and supported limitations; do not rank results from incomparable evaluations.",
                "row_unit": "Work",
                "comparison_dimensions": [
                    "Mechanism",
                    "Applicable conditions",
                    "Supported limitations",
                ],
                "caption_draft": "Representative mechanisms and their applicable conditions",
                "qualifications": [],
                "paper_ids": ["P01", "P02"],
            }
        ]
    if include_figure:
        section["figures"] = [
            {
                "figure_id": "F1",
                "purpose": "Where do the two approaches transform their inputs differently?",
                "content_plan": "Follow the same input through the two documented transformations. Enlarge the point where their actions diverge and show each resulting output. The surrounding paragraph locates the representative studies.",
                "caption_draft": "Mechanisms and input-output boundaries of the compared approaches",
                "visual_guidance": "Give the two alternatives equal panel space and align corresponding features. Put a short label beside each depicted change.",
                "paper_ids": ["P01", "P02"],
                "qualifications": [],
            }
        ]
    warning = (
        "\nOPTIONAL WARNING EXAMPLE (only for an actual conflict in user requirements):\n"
        + json.dumps(
            {
                "warnings": [
                    "The user both excludes [[paper:P01]] and requires it as the sole comparison baseline; clarify whether this paper may be included."
                ]
            }
        )
    )
    if scope == SECTION:
        return (
            "SHAPE EXAMPLES (choose by task)\nUnsectioned component:\n"
            + json.dumps(root)
            + "\nSingle requested section:\n"
            + json.dumps({**root, "outline_tree": [section]})
            + warning
        )
    before = copy.deepcopy(section)
    before.pop("tables", None)
    before.pop("figures", None)
    before.update(
        title="Mechanisms",
        description="Explain the mechanisms before comparing their applicability.",
    )
    before["analysis_tasks"][0].update(
        kind="explain",
        question="How do the approaches work?",
        completion="Explain the mechanisms of [[paper:P01]] and [[paper:P02]] from their evidence.",
    )
    section.update(section_id="2", title="Comparison")
    section["analysis_tasks"][0]["task_id"] = "A2"
    after = copy.deepcopy(before)
    after.update(
        section_id="3",
        title="Limitations and open questions",
        role="synthesis",
        description="Continue after the comparison with supported limitations and unresolved questions.",
    )
    after["analysis_tasks"][0].update(
        task_id="A3",
        kind="synthesize",
        question="Which questions remain unresolved?",
        completion="Synthesize the supported limitations of [[paper:P01]] and [[paper:P02]], distinguishing findings from proposed directions.",
    )
    return (
        "OUTLINE LAYOUT EXAMPLE (illustrative excerpt, not a complete survey or a fixed chapter count; assign real paper aliases)\n"
        + json.dumps({**root, "outline_tree": [before, section, after]})
        + warning
    )


def build_prompt(task, request, evidence, output_format):
    scope = request.get("output_scope")
    papers = sorted(evidence["papers"], key=lambda paper: paper["paper_id"])
    identities = [paper["paper_id"] for paper in papers]
    keys = [paper["cite_key"] for paper in papers]
    if len(set(identities)) != len(identities) or len(set(keys)) != len(keys):
        raise ValueError("outline evidence requires unique paper IDs and citation keys")
    aliases = {}
    records = []
    for ordinal, paper in enumerate(papers, start=1):
        alias = f"{ALIAS_PREFIX}{ordinal:0{ALIAS_WIDTH}d}"
        aliases[alias] = {"paper_id": paper["paper_id"], "cite_key": paper["cite_key"]}
        fields = copy.deepcopy(paper["fields"])
        fields.pop("TLDR", None)
        fields.pop("Evidence limits", None)
        header = f"[[paper:{alias}]] {paper['title']} ({paper['paper_type']}, {paper['year']})"
        lines = [header]
        for label, value in fields.items():
            if scope == SECTION and label in SURVEY_FIELDS:
                continue
            lines.append(
                label
                + ": "
                + (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
            )
        records.append("\n".join(lines))
    forbidden_assets = {
        constraint["kind"]
        for constraint in task.get("constraints", [])
        if constraint.get("kind") in ASSET_KINDS
        and isinstance(constraint.get("value"), dict)
        and constraint["value"].get("max") == 0
    }
    modules = [COMMON, SCOPES.get(scope, UNRESOLVED), STRUCTURE]
    if forbidden_assets != set(ASSET_KINDS):
        if request.get("execution", {}).get("mode") == QUICK:
            modules.append(QUICK_ASSETS)
        else:
            modules.extend([ASSETS, CAPTION_CONTENT_GUIDANCE])
    modules.extend(
        [
            _example(
                scope,
                include_table="table_count" not in forbidden_assets,
                include_figure="figure_count" not in forbidden_assets
                and request.get("execution", {}).get("mode") != QUICK,
            ),
            FINAL,
        ]
    )
    structure = task["structure"]
    context = {
        "output_scope": scope,
        "deliverable": request.get("deliverable"),
        "stage": "outline",
        "output_format": output_format,
        "structure_contract": copy.deepcopy(structure),
        "required_outline_nodes": [
            {**node, "section_id": "0"} if node.get("role") == "abstract" else copy.deepcopy(node)
            for node in structure["required_sections"]
        ],
        "task": authoring_task(task),
    }
    messages = [
        {"role": "system", "content": "\n\n".join(modules)},
        {
            "role": "user",
            "content": context_message(context, "\n\n".join(records)),
        },
    ]
    return messages, {
        "version": ADAPTER_VERSION,
        "output_scope": scope,
        "papers": aliases,
        "corpus_digest": corpus_digest(evidence),
    }


def corpus_digest(evidence):
    ordered = {
        **evidence,
        "papers": sorted(evidence["papers"], key=lambda paper: paper["paper_id"]),
    }
    return hashlib.sha256(
        json.dumps(ordered, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def restore_ids(
    outline, adapter, expected_request_id=None, expected_corpus_digest=None, changes=None
):
    if expected_request_id is not None and adapter.get("request_id") != expected_request_id:
        raise ValueError("outline response request identity mismatch")
    if (
        expected_corpus_digest is not None
        and adapter.get("corpus_digest") != expected_corpus_digest
    ):
        raise ValueError("outline response corpus identity mismatch")
    result = copy.deepcopy(outline)
    aliases = adapter["papers"]
    changes = [] if changes is None else changes

    def narrative(value, location):
        if isinstance(value, list):
            return [narrative(item, f"{location}/{ordinal}") for ordinal, item in enumerate(value)]
        if not isinstance(value, str):
            raise ValueError(f"{location}: narrative must be text or a text array")

        def plain(segment):
            if "[[paper:" in segment:
                raise ValueError(f"{location}: malformed paper reference")
            if adapter.get("version", 1) >= ADAPTER_VERSION and any(
                match[0] in aliases for match in BARE_ALIAS.finditer(segment)
            ):
                raise ValueError(
                    f"{location}: ambiguous bare paper alias; use [[paper:P01]] or escape a literal"
                )
            return segment

        parts = []
        offset = 0
        for match in REFERENCE_TOKEN.finditer(value):
            parts.append(plain(value[offset : match.start()]))
            literal = match.group("literal")
            if literal is not None:
                parts.append(literal)
            else:
                alias = match.group("alias")
                if alias not in aliases:
                    raise ValueError(f"{location}: unknown inline paper alias {alias}")
                key = aliases[alias]["cite_key"]
                parts.append(r"\cite{" + key + "}")
                changes.append(
                    {
                        "path": location,
                        "start": match.start(),
                        "end": match.end(),
                        "alias": alias,
                        "cite_key": key,
                    }
                )
            offset = match.end()
        parts.append(plain(value[offset:]))
        return "".join(parts)

    def texts(node, location="outline"):
        if isinstance(node, list):
            return [texts(item, f"{location}/{ordinal}") for ordinal, item in enumerate(node)]
        if not isinstance(node, dict):
            if isinstance(node, str) and "[[paper:" in node:
                raise ValueError(f"{location}: inline paper reference outside a narrative field")
            return node
        return {
            field: (
                copy.deepcopy(value)
                if field in LITERAL_FIELDS
                else (
                    narrative(value, f"{location}/{field}")
                    if field in NARRATIVE_FIELDS
                    else texts(value, f"{location}/{field}")
                )
            )
            for field, value in node.items()
        }

    def visit(node, location="outline"):
        if isinstance(node, list):
            for ordinal, child in enumerate(node):
                visit(child, f"{location}/{ordinal}")
            return
        if not isinstance(node, dict):
            return
        for field, identity in REFERENCE_FIELDS.items():
            if field not in node:
                continue
            values = node[field]
            if not isinstance(values, list) or any(
                not isinstance(value, str) or value not in aliases for value in values
            ):
                raise ValueError(f"{field} must contain only the supplied P-style paper aliases")
            node[field] = [aliases[value][identity] for value in values]
            changes.extend(
                {
                    "path": f"{location}/{field}/{ordinal}",
                    "alias": value,
                    identity: aliases[value][identity],
                }
                for ordinal, value in enumerate(values)
            )
        for field, child in node.items():
            if field not in REFERENCE_FIELDS and field not in LITERAL_FIELDS:
                visit(child, f"{location}/{field}")

    visit(result)
    return texts(result)
