"""L1 input snapshots, model calls and a deterministic reading projection."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from knowledge_layer.comprehend import (
    BLOCK_VERSION,
    PAPER_TYPES,
    PROMPT_VERSION,
    VERSION,
    ExtractionOptions,
    ExtractionResponseClient,
    SourceImage,
    build_block_prompt,
    classify_paper_type,
    extraction_blocks,
    process_single_doc,
)

from service.assistant.persistence.invocations import AssistantInvocationRecord
from service.assistant.service.actions import CompiledAssistantAction
from service.literature.service.materials import (
    MAX_PREPARATION_SECONDS,
    prepare_images,
    with_table_text,
)
from service.literature.service.utils import PRECISE_FIELD, source_membership
from service.platform.citations import PdfIndex
from service.platform.inference import ModelAttachment, ModelInvocationStatus, ReasoningPolicy

SCHEMA_VERSION = "l1-reading/v2"
COMPATIBLE_EXTRACTOR_VERSIONS = (VERSION, "0.2.7", "0.2.6", "0.2.5", "0.2.4")
MAX_OUTPUT_TOKENS = 16_384
VALIDATION_ATTEMPTS = 2
TRANSPORT_ATTEMPTS = 1
PROMPT_RESERVE_CHARACTERS = 20_000
CLASSIFICATION_CONTEXT_CHARACTERS = 6_000
EXTRACTION_PURPOSE = "literature.comprehension"
INPUT_TOO_LARGE = "pdf_ai_input_too_large"
INPUT_UNAVAILABLE = "pdf_ai_l1_input_unavailable"
EXTRACTION_INCOMPLETE = "pdf_ai_l1_incomplete"
MODEL_FAILED = "pdf_ai_generation_failed"
METHOD_FIELDS = {
    "method": "card.method.description",
    "benchmark": "card.dataset",
    "survey": "card.summary",
    "theory": "card.theorem_proof",
}
MISSING_TEXT = {
    "zh": "提取结果未提供此项，请查阅原文。",
    "en": "Not extracted; consult the original paper.",
}


class ComprehensionError(ValueError):
    def __init__(self, code: str, *, diagnostics: dict | None = None) -> None:
        self.code = code
        self.diagnostics = diagnostics or {}
        errors = self.diagnostics.get("l1", {}).get("extraction_quality", {}).get("errors", [])
        self.detail = "; ".join(str(error) for error in errors[:4])
        super().__init__(f"{code}: {self.detail}" if self.detail else code)


@dataclass(frozen=True)
class ReadingInput:
    doc_id: str
    title: str
    abstract: str
    content: str
    snapshot: dict
    coverage: dict
    language: str
    input_limit: int
    images: tuple[SourceImage, ...] = ()


def prepare_reading(
    index: PdfIndex,
    *,
    doc_id: str,
    title: str,
    abstract: str,
    language: str,
    input_limit: int,
    payload: bytes = b"",
    image_input: bool = False,
    include_images: bool = True,
) -> ReadingInput:
    """Number the exact indexed fragments once; retain their original geometry."""
    preparation_started = time.monotonic()
    deadline = preparation_started + MAX_PREPARATION_SECONDS
    preparation_diagnostic = {}
    index = with_table_text(index, payload, deadline=deadline, diagnostics=preparation_diagnostic)
    table_seconds = time.monotonic() - preparation_started
    assembly_started = time.monotonic()
    fragments = {
        str(number): asdict(fragment)
        for number, fragment in enumerate(index.fragments, 1)
        if fragment.text.strip()
    }
    if not fragments:
        raise ComprehensionError(INPUT_UNAVAILABLE)
    content = "\n".join(
        f"#{number} "
        + (
            fragment["text"].replace("\n", "\n  ")
            if fragment["kind"] == "table_text"
            else " ".join(fragment["text"].split())
        )
        for number, fragment in fragments.items()
    )
    if len(content) + len(title) + len(abstract) + PROMPT_RESERVE_CHARACTERS > input_limit:
        raise ComprehensionError(INPUT_TOO_LARGE)
    included = sorted(
        {page["page"] for fragment in fragments.values() for page in fragment["pages"]}
    )
    missing = sorted(
        set(range(1, index.page_count + 1)) - set(included) | set(index.unavailable_pages)
    )
    omissions = [asdict(omission) for omission in index.omissions]
    assembly_seconds = time.monotonic() - assembly_started
    images, manifest, image_policy = prepare_images(
        index,
        payload,
        enabled=image_input is True and include_images and bool(payload),
        disabled_reason="requested_text_only" if not include_images else "model_text_only",
        first_number=max(map(int, fragments), default=0) + 1,
        deadline=deadline,
    )
    if "preparation_time_budget" in image_policy.get("skipped", []) and not preparation_diagnostic:
        preparation_diagnostic["timeout_stage"] = "image"
    return ReadingInput(
        doc_id,
        title,
        abstract,
        content,
        {
            "index_id": index.index_id,
            "source_revision": index.revision,
            "input_sha256": hashlib.sha256(content.encode()).hexdigest(),
            "fragments": fragments,
            "images": manifest,
            "image_policy": image_policy,
            "preparation_diagnostic": preparation_diagnostic,
            "preparation_stages": {
                "table_seconds": round(table_seconds, 3),
                "assembly_seconds": round(assembly_seconds, 3),
                "image_seconds": image_policy["elapsed_seconds"],
            },
        },
        {
            "total_pages": index.page_count,
            "included_pages": included,
            "unavailable_pages": missing,
            "omissions": omissions,
            "complete": not missing and not omissions,
        },
        language,
        input_limit,
        images,
    )


FIELD_LABELS = {
    "name": ("名称", "Name"),
    "description": ("说明", "Description"),
    "size": ("规模", "Size"),
    "source": ("来源", "Source"),
    "splits": ("划分", "Splits"),
    "method": ("方法 / 配置", "Method / configuration"),
    "dataset": ("数据集", "Dataset"),
    "metric": ("指标", "Metric"),
    "value": ("结果", "Value"),
    "conditions": ("条件", "Conditions"),
    "task": ("任务", "Task"),
    "role": ("角色", "Role"),
    "component": ("组件", "Component"),
    "formula": ("公式", "Formula"),
    "variables": ("变量", "Variables"),
    "primary_metrics": ("评价指标", "Metrics"),
    "evaluation_protocol": ("评估协议", "Protocol"),
    "models_evaluated": ("评估模型", "Evaluated models"),
    "key_findings": ("主要发现", "Findings"),
    "human_performance": ("人类表现", "Human performance"),
    "scope": ("范围", "Scope"),
    "taxonomy": ("分类框架", "Taxonomy"),
    "key_themes": ("主要主题", "Themes"),
    "trends": ("趋势", "Trends"),
    "comparisons": ("比较", "Comparisons"),
    "open_problems": ("开放问题", "Open problems"),
    "conclusions": ("结论", "Conclusions"),
    "recommendations": ("建议", "Recommendations"),
    "theoretical_impact": ("理论意义", "Theoretical impact"),
    "practical_implications": ("实际意义", "Practical implications"),
    "connections": ("相关联系", "Connections"),
}


# Some otherwise valid JSON model responses encode LaTeX \t/\b/\f as control
# characters. Repair only recognizable commands inside math in the display copy.
# The stored L1, original quotes and source snapshot are never rewritten.
_MATH_COMMANDS = {
    "\t": ("imes", "riangle", "ext", "heta", "au", "op"),
    "\b": ("eta", "ar", "oldsymbol", "egin"),
    "\f": ("rac",),
    "\r": ("ight", "ho"),
    "\n": ("abla", "u", "eq"),
}


def _display_math(value: str) -> str:
    def repair(match):
        text = match.group(0)
        for control, suffixes in _MATH_COMMANDS.items():
            for suffix in suffixes:
                text = re.sub(
                    re.escape(control + suffix) + r"\b",
                    lambda match, control=control, suffix=suffix: "\\"
                    + {"\t": "t", "\b": "b", "\f": "f", "\r": "r", "\n": "n"}[control]
                    + suffix,
                    text,
                )
        return text

    return re.sub(r"\$\$[\s\S]*?\$\$|\$[^$]+\$", repair, value)


def _text(value: object, language: str = "en") -> str:
    if isinstance(value, str):
        return _display_math(value.strip())
    if isinstance(value, list):
        return "\n\n".join(text for item in value if (text := _text(item, language)))
    if isinstance(value, dict):
        labels = 0 if language == "zh" else 1
        if all(value.get(key) for key in ("method", "metric", "value", "dataset")):
            heading = f"**{value['method']}** · **{value['value']}** {value['metric']} · {value['dataset']}"
            context = " · ".join(
                _text(value.get(key), language) for key in ("task", "conditions") if value.get(key)
            )
            return heading + ("\n\n" + context if context else "")
        return "\n\n".join(
            f"**{FIELD_LABELS.get(key, (key, key))[labels]}** · {text}"
            for key, item in value.items()
            if key != "role" and (text := _text(item, language))
        )
    return str(value) if isinstance(value, (int, float)) else ""


def project_field(value: object, path: str, mapping: dict, source: ReadingInput) -> dict:
    """Resolve a whole L1 field against its own existing source anchors."""
    fragments = source.snapshot["fragments"]
    fields = mapping.get("card_mapping", {})
    numbers = list(
        dict.fromkeys(
            str(number)
            for field, ids in fields.items()
            if field == path or field.startswith((path + ".", path + "["))
            for number in ids
        )
    )
    direct, context = (
        source_membership(fragments, numbers, value)
        if PRECISE_FIELD.search(path)
        else (numbers, [])
    )
    completed = [*direct, *context]
    fields = {path: completed}
    evidence = []
    seen = set()
    for field, source_numbers in fields.items():
        if field != path and not field.startswith((path + ".", path + "[")):
            continue
        for number in source_numbers:
            visual = source.snapshot.get("images", {}).get(str(number))
            if visual and number not in seen:
                seen.add(number)
                evidence.append(
                    {
                        "page": visual["page"],
                        "quote": "",
                        "kind": "image",
                        "label": visual["label"],
                        "region_id": visual["region_id"],
                        "quads": [visual["quad"]],
                    }
                )
                continue
            fragment = fragments.get(str(number))
            if not fragment or number in seen:
                continue
            seen.add(number)
            # A fragment may cross pages. Quote only its actual spans on each page.
            for page in fragment["pages"]:
                spans = [span for span in fragment.get("spans", []) if span["page"] == page["page"]]
                quote = " ".join(fragment["text"][span["start"] : span["end"]] for span in spans)
                if not quote and len(fragment["pages"]) == 1:
                    quote = fragment["text"]
                if quote.strip() and (
                    PRECISE_FIELD.search(path) or any(char.isalpha() for char in quote)
                ):
                    evidence.append(
                        {
                            "page": page["page"],
                            "quote": quote,
                            "fragment_id": fragment["fragment_id"],
                            "kind": (
                                "table_text" if fragment.get("kind") == "table_text" else "text"
                            ),
                            "quads": page["quads"],
                        }
                    )
    text = _text(value, source.language)
    return {
        "text": text or MISSING_TEXT[source.language],
        "evidence": evidence,
        "uncertain": not text or not evidence,
        "context_fragment_ids": [fragments[n]["fragment_id"] for n in context if n in fragments],
        **({"completed_evidence": True} if completed != numbers else {}),
    }


def project_summary(knowledge: dict, mapping: dict, source: ReadingInput) -> dict:
    """Expose existing facts and source quotes; never generate a second summary."""

    def section(value: object, path: str) -> dict:
        return project_field(value, path, mapping, source)

    common = knowledge["common_fields"]
    method_path = METHOD_FIELDS[knowledge["paper_type"]]
    method: object = knowledge
    for part in method_path.split("."):
        method = method.get(part) if isinstance(method, dict) else None
    claims = [
        section(
            claim.get("claim") if isinstance(claim, dict) else claim,
            f"common_fields.claims[{index}].claim",
        )
        for index, claim in enumerate(common.get("claims") or [])
    ]
    if not claims:
        claims = [section(knowledge["card"].get("conclusion"), "card.conclusion")]
    contribution = section(common.get("core_contribution"), "common_fields.core_contribution")
    limitations = section(common.get("limitations"), "common_fields.limitations")
    sections = []

    def add(key, paths):
        items = []
        for path in paths:
            value = knowledge
            for part in path.split("."):
                value = value.get(part) if isinstance(value, dict) else None
            if isinstance(value, list):
                for index, entry in enumerate(value):
                    if _text(entry):
                        items.append(
                            {**section(entry, f"{path}[{index}]"), "path": f"{path}[{index}]"}
                        )
            elif _text(value):
                items.append({**section(value, path), "path": path})
        if items:
            sections.append({"key": key, "items": items})

    add("problem", ["card.background", "card.problem"])
    kind = knowledge["paper_type"]
    if kind == "method":
        add(
            "method",
            [
                "card.idea",
                "card.method.description",
                "card.method.key_components",
                "card.method.key_formulas",
            ],
        )
        add(
            "results",
            [
                "card.experiments.key_results",
                "card.experiments.results",
                "card.experiments.ablation_findings",
            ],
        )
    elif kind == "benchmark":
        add("method", ["card.idea", "card.dataset", "card.metrics"])
        add("results", ["card.experiments"])
    elif kind == "survey":
        add("method", ["card.summary"])
        add("results", ["card.analysis", "card.discussion"])
    else:
        add(
            "method",
            [
                "card.theorem_proof.key_assumptions",
                "card.theorem_proof.proof_technique",
                "card.theorem_proof.key_formulas",
            ],
        )
        add(
            "results",
            [
                "card.theorem_proof.main_results",
                "card.theorem_proof.formal_guarantees",
                "card.implication",
            ],
        )
    if not any(item["key"] == "results" for item in sections):
        sections.append({"key": "results", "items": claims})
    add("limitations", ["common_fields.limitations"])
    return {
        "sections": sections,
        "overview": section(common.get("tldr"), "common_fields.tldr"),
        "text": _text(common.get("tldr")) or contribution["text"],
        "paper_type": knowledge["paper_type"],
        "contribution": contribution,
        "claims": claims,
        "method": section(method, method_path),
        "limitations": limitations,
    }


class ReadingClient:
    """Adapt the provider-free L1 chat boundary to recorded product actions."""

    def __init__(
        self,
        source: ReadingInput,
        invoke: Callable[[CompiledAssistantAction, int], Awaitable[AssistantInvocationRecord]],
    ) -> None:
        self.source = source
        self.invoke = invoke
        self.records: list[AssistantInvocationRecord] = []
        self.calls = 0

    async def chat(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int | None = None,
        json_mode: bool = False,
        cache_prefix: str | None = None,
        temperature: float | None = None,
        images: tuple[SourceImage, ...] = (),
        prompt_version: str = PROMPT_VERSION,
    ) -> tuple[str, dict]:
        # Product model settings own transport parameters and caching.
        del cache_prefix, temperature
        self.calls += 1
        if len(user) > self.source.input_limit:
            raise ComprehensionError(INPUT_TOO_LARGE)
        record = await self.invoke(
            CompiledAssistantAction(
                attachments=tuple(
                    ModelAttachment(image.media_type, image.data, f"source-{image.number}")
                    for image in images
                ),
                purpose=EXTRACTION_PURPOSE,
                prompt_version=prompt_version,
                instructions=system,
                input_text=user,
                max_input_chars=self.source.input_limit,
                json_output=json_mode,
                max_output_tokens=min(max_tokens or MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
                reasoning_policy=ReasoningPolicy.LOW_LATENCY,
            ),
            self.calls,
        )
        self.records.append(record)
        if record.status is ModelInvocationStatus.CANCELLED:
            raise asyncio.CancelledError
        if record.status is not ModelInvocationStatus.COMPLETED:
            raise ComprehensionError(record.error_code or MODEL_FAILED)
        return record.output_text, {
            "prompt_tokens": record.input_tokens,
            "completion_tokens": record.output_tokens,
        }


async def extract_asset(
    source: ReadingInput, client: ReadingClient, *, paper_type: str = ""
) -> dict:
    started = time.monotonic()
    kind = (
        paper_type
        if paper_type in PAPER_TYPES
        else await classify_paper_type(
            client,
            source.title,
            source.abstract or source.content[:CLASSIFICATION_CONTEXT_CHARACTERS],
            attempts=TRANSPORT_ATTEMPTS,
        )
    )
    instructions, reference = build_block_prompt(kind, output_language=source.language)
    payload = json.dumps(
        {
            "title": source.title,
            "paper_type": kind,
            "language": source.language,
            **reference,
            "original": source.content,
            "images": {str(image.number): image.label for image in source.images},
        },
        ensure_ascii=False,
    )
    if len(payload) + len(instructions) > source.input_limit:
        raise ComprehensionError(INPUT_TOO_LARGE)
    output, _ = await client.chat(
        instructions, payload, json_mode=False, images=source.images, prompt_version=BLOCK_VERSION
    )
    prepared = ExtractionResponseClient(
        client, output, lambda text: extraction_blocks(text, kind), output
    )
    result = await validate_extraction(
        source, prepared, paper_type=kind, prompt_version=BLOCK_VERSION
    )
    result["metadata"].update(
        prompt_version=BLOCK_VERSION,
        elapsed_seconds=round(time.monotonic() - started, 3),
        **prepared.retry_metadata(),
    )
    return result


async def validate_extraction(
    source: ReadingInput, client, *, paper_type: str, prompt_version: str = PROMPT_VERSION
) -> dict:
    started = time.monotonic()
    knowledge, mapping = await process_single_doc(
        client,
        source.doc_id,
        {
            "title": source.title,
            "abstract": source.abstract,
            "content": source.content,
            "classification_context": source.content[:CLASSIFICATION_CONTEXT_CHARACTERS],
            "paper_type": paper_type,
        },
        "full",
        True,
        False,
        None,
        {},
        images=source.images,
        options=ExtractionOptions(
            validation_attempts=VALIDATION_ATTEMPTS,
            llm_attempts=TRANSPORT_ATTEMPTS,
            output_language=source.language,
        ),
    )
    if (
        knowledge["extraction_quality"]["status"] != "READY"
        or not knowledge["completeness"]["complete"]
        or not mapping
        or not mapping.get("card_mapping")
    ):
        raise ComprehensionError(
            EXTRACTION_INCOMPLETE,
            diagnostics={
                "l1": knowledge,
                "source_mapping": mapping,
                "source_snapshot": source.snapshot,
                "extractor_version": VERSION,
                "prompt_version": prompt_version,
            },
        )
    # Reading strategy and actual source coverage are independent.
    # Preserve the strategy returned by the shared kernel.
    records = client.records
    return {
        "l1": knowledge,
        "source_mapping": mapping,
        "source_snapshot": source.snapshot,
        "metadata": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "input_mode": "text_images" if source.images else "text_only",
            "image_policy": source.snapshot.get("image_policy", {}),
            "image_count": len(source.images),
            "extractor_version": VERSION,
            "prompt_version": prompt_version,
            "coverage": source.coverage,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "usage": {
                "input_tokens": (
                    sum(item.input_tokens for item in records)
                    if all(item.input_tokens > 0 for item in records)
                    else None
                ),
                "output_tokens": (
                    sum(item.output_tokens for item in records)
                    if all(item.output_tokens > 0 for item in records)
                    else None
                ),
                "calls": len(records),
            },
            "invocations": [
                {
                    "id": item.invocation_id,
                    "model_key": item.model_key,
                    "input_tokens": item.input_tokens or None,
                    "output_tokens": item.output_tokens or None,
                    "receipt_id": item.receipt_id,
                }
                for item in records
            ],
        },
    }


async def comprehend(source: ReadingInput, client: ReadingClient, *, paper_type: str = "") -> dict:
    result = await extract_asset(source, client, paper_type=paper_type)
    return {
        **result,
        "modules": {"summary": project_summary(result["l1"], result["source_mapping"], source)},
    }


def project_saved(result: dict) -> dict:
    """Upgrade only the presentation from saved facts; never re-extract or rewrite provenance."""
    if result.get("modules", {}).get("summary", {}).get("organized"):
        return result
    if not result.get("l1") or not result.get("source_snapshot", {}).get("fragments"):
        return result
    source = ReadingInput(
        result.get("literature_id", ""),
        "",
        "",
        "",
        result["source_snapshot"],
        result.get("metadata", {}).get("coverage", {}),
        result.get("response_language", "zh"),
        0,
    )
    summary = project_summary(result["l1"], result.get("source_mapping", {}), source)
    return {
        **result,
        "modules": {**result.get("modules", {}), "summary": summary},
        "content": summary,
    }


def saved_source(result: dict, language: str, input_limit: int) -> ReadingInput:
    """Use the saved source snapshot, not a fresh PDF parse or model extraction."""
    knowledge = result.get("l1", {})
    snapshot = result.get("source_snapshot", {})
    if (
        not knowledge.get("card")
        or not knowledge.get("common_fields")
        or knowledge.get("paper_type") not in METHOD_FIELDS
        or not snapshot.get("fragments")
    ):
        raise ComprehensionError(EXTRACTION_INCOMPLETE)
    return ReadingInput(
        result.get("literature_id", ""),
        knowledge.get("title", ""),
        "",
        "",
        snapshot,
        result.get("metadata", {}).get("coverage", {}),
        language,
        input_limit,
    )


def source_pages(source: ReadingInput) -> tuple[str, ...]:
    fragments = source.snapshot["fragments"].values()
    count = max((page["page"] for fragment in fragments for page in fragment["pages"]), default=0)
    count = max(
        count,
        source.coverage.get("total_pages", 0),
        max((image["page"] for image in source.snapshot.get("images", {}).values()), default=0),
    )
    pages: list[list[str]] = [[] for _ in range(count)]
    for fragment in source.snapshot["fragments"].values():
        for page in fragment["pages"]:
            spans = [span for span in fragment["spans"] if span["page"] == page["page"]]
            quote = " ".join(fragment["text"][span["start"] : span["end"]] for span in spans)
            if not quote and len(fragment["pages"]) == 1:
                quote = fragment["text"]
            pages[page["page"] - 1].append(quote)
    return tuple("\n".join(page) for page in pages)
