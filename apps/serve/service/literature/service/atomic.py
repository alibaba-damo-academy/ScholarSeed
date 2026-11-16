"""PDF to a reusable machine asset; no reading prose or library insertion."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import asdict

from service.literature.persistence.assets import MaterialAssets
from service.literature.persistence.files import read_source_file
from service.literature.service.comprehension import (
    COMPATIBLE_EXTRACTOR_VERSIONS,
    ComprehensionError,
    ReadingInput,
    extract_asset,
    prepare_reading,
)
from service.paths import SERVICE_LITERATURE_DATABASE
from service.workbench.service.extraction import EXTRACTOR_VERSION, extract

INPUT_LIMIT = 4_100_000
ParseError = ValueError


def parser_fingerprint():
    return EXTRACTOR_VERSION


def cached_material(store: MaterialAssets, revision: str, language: str):
    # A prompt/repair revision must not invalidate successful compatible assets.
    for version in COMPATIBLE_EXTRACTOR_VERSIONS:
        asset = store.get(revision, language, version)
        if asset and asset.get("l1", {}).get("extraction_quality", {}).get("status") == "READY":
            return asset
    return None


def prepare_pdf(
    payload: bytes, title: str = "", abstract: str = "", language: str = "en"
) -> ReadingInput:
    revision = hashlib.sha256(payload).hexdigest()
    cached = cached_material(MaterialAssets(SERVICE_LITERATURE_DATABASE), revision, language)
    if cached:
        snapshot = cached["source_snapshot"]
        content = "\n".join(
            f'#{number} {fragment["text"]}' for number, fragment in snapshot["fragments"].items()
        )
        return ReadingInput(
            revision,
            title,
            abstract,
            content,
            snapshot,
            cached["metadata"]["coverage"],
            language,
            INPUT_LIMIT,
        )
    index = extract(payload)
    return prepare_reading(
        index,
        doc_id=index.revision,
        title=title,
        abstract=abstract,
        language=language,
        input_limit=INPUT_LIMIT,
        payload=payload,
        include_images=False,
    )


def parse_pdf(payload: bytes) -> dict:
    source = prepare_pdf(payload)
    return {
        "parser": EXTRACTOR_VERSION,
        "parser_sha256": EXTRACTOR_VERSION,
        "parser_version": EXTRACTOR_VERSION,
        "status": "ok",
        "info_type": "origin_pdf",
        "sentences": source.content,
        "source_sha256": source.snapshot["source_revision"].removeprefix("sha256:"),
        "source_coverage": source.coverage,
        "reading_input": asdict(source),
    }


def prepare_abstract(title: str, abstract: str, language: str = "en") -> ReadingInput:
    if not abstract.strip():
        raise ValueError("Original abstract required")
    revision = "sha256:" + hashlib.sha256((title + "\n" + abstract).encode()).hexdigest()
    snapshot = {
        "source_revision": revision,
        "fragments": {"1": {"text": abstract, "kind": "abstract", "pages": [], "spans": []}},
        "images": {},
    }
    return ReadingInput(
        revision,
        title,
        abstract,
        "#1 " + abstract,
        snapshot,
        {"complete": False, "evidence_kind": "abstract"},
        language,
        INPUT_LIMIT,
    )


def parse_source(path, output_dir=None, *, materialized_text=False):
    if materialized_text:
        raise ValueError("Original PDF required for reusable material extraction")
    return parse_pdf(read_source_file(path))


def usable_source(parsed):
    if not parsed.get("sentences", "").strip():
        raise ValueError("PDF has no usable text")
    return parsed["sentences"]


async def material_asset(
    source: ReadingInput,
    client,
    *,
    paper_type: str = "",
    database=None,
    paper=None,
    pdf_payload=None,
) -> dict:
    store = MaterialAssets(database or SERVICE_LITERATURE_DATABASE)
    if pdf_payload is not None and paper:
        await asyncio.to_thread(
            store.save_source, source.snapshot["source_revision"], paper, pdf_payload
        )
    saved = await asyncio.to_thread(
        cached_material, store, source.snapshot["source_revision"], source.language
    )
    if saved:
        return saved
    try:
        result = await extract_asset(source, client, paper_type=paper_type)
    except ComprehensionError as error:
        if error.diagnostics:
            await asyncio.to_thread(
                store.save_failure,
                source.snapshot["source_revision"],
                source.language,
                error.diagnostics,
            )
        raise
    if source.coverage.get("evidence_kind") == "abstract":
        result["l1"]["reading_depth"] = "abstract_only"
    asset = {
        **result,
        "revision": source.snapshot["source_revision"].removeprefix("sha256:"),
        "response_language": source.language,
    }
    asset = json.loads(json.dumps(asset, ensure_ascii=False))
    await asyncio.to_thread(store.save, asset)
    return asset
