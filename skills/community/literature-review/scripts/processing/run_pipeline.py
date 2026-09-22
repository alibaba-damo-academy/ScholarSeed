"""
Pipeline 编排 — _process_single_paper + _run_async (并发调度主循环)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from typing import Optional

import llm_call  # for setting LLM_RETRIES at runtime
from config import _create_llm
from llm_call import _merge_usage
from log_utils import setup_logging
from progress import (
    DELTA_IDEATION_TYPES,
    VALID_TYPES,
    FatalLLMError,
    GracefulShutdown,
    PipelineStop,
    PipelineStoppedError,
    ProgressTracker,
    classify_error,
    format_exception,
)
from step1_classify import _classify_paper_type
from step2_prepare import (
    _determine_reading_depth,
    _get_sections,
    _has_full_text,
    _number_abstract_sentences,
    _parse_sentences_index,
    trim_content_partial,
)
from step3_warmup import _warmup_cache
from step4_card import _extract_card_combined, _validate_card
from step5_delta import _extract_delta, _validate_delta
from step6_ideation import _extract_ideation_claims, _validate_ideation
from step7_upload import _upload_paper_info
from step0_load import load_inputs
from utils import (
    _atomic_write_json,
    _load_json,
    _lookup_paper_info,
    _resolve_folder,
    _resolve_input_dir,
    _resolve_output_dir,
)

# ---- Retry constant (can be overridden at runtime) ----
MAX_RETRIES = 3       # Outer validation retry (card quality check)


# ============================================================================
# Core Processing Logic — single paper
# ============================================================================

async def _process_single_paper(
    llm,
    paper_id: str,
    entity_entry: dict,
    paper_info_entry: dict,
    depth: str,
    paper_type: str,
    with_source_map: bool = False,
    with_delta: bool = False,
    with_ideation: bool = False,
    stop: Optional[PipelineStop] = None,
    usage_out: Optional[dict] = None,
) -> tuple[dict, Optional[dict], Optional[dict], Optional[dict], dict, dict]:
    """Process a single paper end-to-end (KV Cache Scheme 2).

    Returns: (card_entry, delta_entry, ideation_entry, source_map_entry, aggregated_usage, meta)
    where meta = {card_from_hub, gen_delta, gen_ideation} drives the upload decision.
    If usage_out is passed, usage is also accumulated into it (survives exceptions).
    """
    paper_info_entry = paper_info_entry or {}
    title = entity_entry.get("title", "") or "(title unavailable)"
    abstract = entity_entry.get("abstract", "") or ""
    info_type = paper_info_entry.get("info_type", "")
    agg_usage: dict = usage_out if usage_out is not None else {}

    # ---- Hub cache hit: info_type="card" — reuse stored products, generate only what is missing ----
    card_from_hub = (info_type == "card")
    if card_from_hub and depth == "metadata_only":
        depth = "full"
    hub_delta_entry = None
    hub_ideation_entry = None
    hub_source_map_entry = None
    card = None
    common_fields = {}
    card_source_map = {}
    if card_from_hub:
        hub_pc = paper_info_entry.get("paper_card")
        hub_type = None
        if isinstance(hub_pc, dict):
            card = hub_pc.get("card")
            common_fields = hub_pc.get("common_fields") or {}
            ht = hub_pc.get("paper_type")
            if ht in VALID_TYPES:
                hub_type = ht

        # Hub card validity check — hub claims info_type="card" but the bundle is
        # actually incomplete. Don't trust the flag: discard hub artifacts and
        # fall through to fresh extraction, otherwise we'd emit a card=None entry
        # or a card with no source_mapping that can't be rebuilt afterwards.
        hub_sm_present = isinstance(paper_info_entry.get("source_mapping"), dict)
        if not card:
            logging.info(
                f"[CARD_INVALIDATE] {paper_id}: info_type=card but hub card "
                f"missing/empty; discarding hub artifacts, re-extracting"
            )
            card_from_hub = False
            card = None
            common_fields = {}
        elif with_source_map and not hub_sm_present:
            logging.info(
                f"[CARD_INVALIDATE] {paper_id}: info_type=card but hub "
                f"source_mapping missing; re-extracting to rebuild card mapping"
            )
            card_from_hub = False
            card = None
            common_fields = {}

        # Type conflict resolution — upstream (reclassify / entity) takes priority over hub
        if paper_type and hub_type and paper_type != hub_type:
            # Upstream type disagrees with hub → discard all hub artifacts, re-extract
            logging.info(
                f"[CARD_INVALIDATE] {paper_id}: upstream type={paper_type} "
                f"!= hub type={hub_type}; discarding hub card/delta/ideation"
            )
            card_from_hub = False
            card = None
            common_fields = {}
        elif not paper_type and hub_type:
            # No upstream type → fall back to hub type
            paper_type = hub_type
        # else: both agree or both empty → keep as-is

        if card_from_hub:
            hub_sm = paper_info_entry.get("source_mapping")
            if isinstance(hub_sm, dict):
                hub_source_map_entry = hub_sm
                card_source_map = hub_sm.get("card_mapping") or {}
            d = paper_info_entry.get("delta")
            if with_delta and isinstance(d, dict) and d.get("deltas"):
                hub_delta_entry = d
            i = paper_info_entry.get("ideation")
            if with_ideation and isinstance(i, dict) and i.get("idea_claims"):
                hub_ideation_entry = i

    # Discovered metadata is filtered upstream. Local/legacy inputs still need
    # actual source text or a validated hub card; never extract from a title alone.
    sections = _get_sections(paper_info_entry)
    has_section_text = isinstance(sections, str) and bool(sections.strip())
    if not abstract.strip() and not has_section_text and card is None:
        raise ValueError(f"{paper_id}: no abstract or full text available for paper-card extraction")
    if not abstract.strip() and has_section_text and depth == "metadata_only":
        depth = "partial"

    # Step 1: Classify paper_type if missing
    if not paper_type:
        paper_type, _ = await _classify_paper_type(
            llm, title, abstract, stop=stop, where=f"{paper_id}/classify",
            usage_out=agg_usage,
        )

    # Step 2: Prepare content
    if depth == "metadata_only" or not sections:
        if abstract:
            content = _number_abstract_sentences(abstract)
        else:
            content = f"Title: {title}"
    elif isinstance(sections, str) and sections.strip():
        content = sections
        if depth == "partial":
            content, _ = trim_content_partial(content)
    else:
        if abstract:
            content = _number_abstract_sentences(abstract)
        else:
            content = f"Title: {title}"

    # Decide what still needs a fresh LLM extraction
    has_bib = bool(paper_info_entry.get("bib") or paper_info_entry.get("bib_info"))
    should_gen_delta = (
        with_delta
        and hub_delta_entry is None
        and paper_type in DELTA_IDEATION_TYPES
        and depth != "metadata_only"
        and (info_type == "origin_latex" or (info_type == "card" and has_bib))
    )
    should_gen_ideation = (
        with_ideation
        and hub_ideation_entry is None
        and paper_type in DELTA_IDEATION_TYPES
        and depth != "metadata_only"
    )

    # Step 3: Warmup
    if (not card_from_hub and (with_delta or with_ideation)) or should_gen_delta or should_gen_ideation:
        await _warmup_cache(llm, title, content, stop=stop, where=f"{paper_id}/warmup",
                            usage_out=agg_usage)
    else:
        logging.debug(f"[WARMUP_SKIP] {paper_id}: no fresh delta/ideation extraction")

    # Step 4: Card + common_fields (+ optional source_map)
    effective_source_map = with_source_map
    if card_from_hub:
        logging.info(
            f"[CARD_CACHE_HIT] {paper_id}: reuse hub card/common/source_map "
            f"(type={paper_type}, hub_delta={hub_delta_entry is not None}, "
            f"hub_ideation={hub_ideation_entry is not None})"
        )
    else:
        for attempt in range(MAX_RETRIES):
            try:
                card, common_fields, card_source_map, _ = await _extract_card_combined(
                    llm, paper_type, title, content,
                    with_source_map=effective_source_map,
                    stop=stop, where=f"{paper_id}/card+common",
                    usage_out=agg_usage,
                )
                errors = _validate_card(paper_type, depth, card, common_fields)
                if not errors:
                    break
                logging.warning(
                    f"[RETRY] {paper_id}: card validation failed (attempt {attempt + 1}/{MAX_RETRIES}): {errors}"
                )
            except (FatalLLMError, RuntimeError):
                raise
            except Exception as exc:
                logging.warning(
                    f"[RETRY] {paper_id}: card extraction error (attempt {attempt + 1}/{MAX_RETRIES}): {exc}"
                )
                if attempt + 1 >= MAX_RETRIES:
                    raise

    # Step 5: Delta extraction
    delta = None
    delta_source_map = {}
    if should_gen_delta:
        for attempt in range(MAX_RETRIES):
            try:
                delta, delta_source_map, _ = await _extract_delta(
                    llm, title, content,
                    with_source_map=effective_source_map,
                    stop=stop, where=f"{paper_id}/delta",
                    usage_out=agg_usage,
                )
                delta_errors = _validate_delta(delta)
                if not delta_errors:
                    break
                logging.warning(
                    f"[RETRY] {paper_id}: delta validation failed (attempt {attempt + 1}/{MAX_RETRIES}): {delta_errors}"
                )
            except (FatalLLMError, RuntimeError):
                raise
            except Exception as exc:
                logging.warning(
                    f"[RETRY] {paper_id}: delta extraction error (attempt {attempt + 1}/{MAX_RETRIES}): {exc}"
                )
                if attempt + 1 >= MAX_RETRIES:
                    break

    # Step 6: Ideation claims
    ideation = None
    if should_gen_ideation:
        for attempt in range(MAX_RETRIES):
            try:
                ideation, _ = await _extract_ideation_claims(
                    llm, title, content,
                    stop=stop, where=f"{paper_id}/ideation",
                    usage_out=agg_usage,
                )
                ideation_errors = _validate_ideation(ideation)
                if not ideation_errors:
                    break
                logging.warning(
                    f"[RETRY] {paper_id}: ideation validation failed (attempt {attempt + 1}/{MAX_RETRIES}): {ideation_errors}"
                )
            except (FatalLLMError, RuntimeError):
                raise
            except Exception as exc:
                logging.warning(
                    f"[RETRY] {paper_id}: ideation extraction error (attempt {attempt + 1}/{MAX_RETRIES}): {exc}"
                )
                if attempt + 1 >= MAX_RETRIES:
                    break

    # Quality Notes
    quality_notes = []
    if depth == "metadata_only":
        quality_notes.append("Reading depth is 'metadata_only' — card extracted from abstract only.")
    if not sections and not card_from_hub:
        quality_notes.append("No full text available.")
    if not abstract or len(abstract) < 100:
        quality_notes.append(f"Abstract is very short ({len(abstract or '')} chars).")

    # Build result entry (card)
    has_parse_dict = bool(sections) or (card_from_hub and bool(paper_info_entry.get("paper_card", {}).get("has_parse_dict")))
    result_entry = {
        "paperId": paper_id,
        "title": entity_entry.get("title", ""),
        "abstract": entity_entry.get("abstract", ""),
        "year": entity_entry.get("year"),
        "paper_type": paper_type,
        "relevance_level": entity_entry.get("relevance_level", "L1"),
        "info_type": info_type,
        "has_parse_dict": has_parse_dict,
        "reading_depth": depth,
        "card": card,
        "common_fields": common_fields,
    }

    if quality_notes:
        note_text = " | ".join(quality_notes)
        if card and isinstance(card, dict):
            existing_other = card.get("other_info", "")
            card["other_info"] = f"{existing_other} | {note_text}".strip(" |") if existing_other else note_text
        else:
            result_entry["quality_notes"] = note_text

    # Build delta entry
    delta_entry = None
    if hub_delta_entry is not None:
        delta_entry = dict(hub_delta_entry)
        delta_entry["paperId"] = paper_id
        delta_entry["title"] = entity_entry.get("title", "")
    elif delta is not None:
        delta_items = delta if isinstance(delta, list) else delta.get("deltas", [])
        bib_dict = paper_info_entry.get("bib") or paper_info_entry.get("bib_info") or {}
        for item in delta_items:
            if isinstance(item, dict):
                bib_id = item.get("cited_bib_id", "")
                bib_info = bib_dict.get(bib_id, {})
                item["cited_bib_title"] = bib_info.get("title", "")
        delta_entry = {
            "paperId": paper_id,
            "title": entity_entry.get("title", ""),
            "paper_type": paper_type,
            "deltas": delta_items,
        }

    # Build ideation entry
    ideation_entry = None
    if hub_ideation_entry is not None:
        ideation_entry = dict(hub_ideation_entry)
        ideation_entry["paperId"] = paper_id
        ideation_entry["title"] = entity_entry.get("title", "")
    elif ideation is not None:
        claims = ideation.get("idea_claims", []) if isinstance(ideation, dict) else []
        ideation_sentences = {}
        if claims:
            sent_idx_for_ideation = _parse_sentences_index(content)
            all_claim_ids: set[int] = set()
            for claim in claims:
                sids = claim.get("source_ids", [])
                if isinstance(sids, list):
                    all_claim_ids.update(x for x in sids if isinstance(x, int))
            ideation_sentences = {
                str(sid): sent_idx_for_ideation[sid]
                for sid in sorted(all_claim_ids)
                if sid in sent_idx_for_ideation
            }
        ideation_entry = {
            "paperId": paper_id,
            "title": entity_entry.get("title", ""),
            "paper_type": paper_type,
            "idea_claims": claims,
            "sentences": ideation_sentences,
        }

    # Build source_map entry
    source_map_entry = None
    if card_from_hub and delta is None:
        if isinstance(hub_source_map_entry, dict):
            source_map_entry = dict(hub_source_map_entry)
            source_map_entry["paperId"] = paper_id
            source_map_entry["title"] = entity_entry.get("title", "")
    elif with_source_map and (card_source_map or delta_source_map):
        sent_idx = _parse_sentences_index(content)
        all_ids: set[int] = set()
        for ids in card_source_map.values():
            if isinstance(ids, list):
                all_ids.update(x for x in ids if isinstance(x, int))
        for ids in delta_source_map.values():
            if isinstance(ids, list):
                all_ids.update(x for x in ids if isinstance(x, int))
        resolved_sentences = {
            str(sid): sent_idx[sid]
            for sid in sorted(all_ids)
            if sid in sent_idx
        }

        source_map_entry = {
            "paperId": paper_id,
            "title": entity_entry.get("title", ""),
            "card_mapping": card_source_map,
            "delta_mapping": delta_source_map,
            "sentences": resolved_sentences,
        }

    meta = {
        "card_from_hub": card_from_hub,
        "gen_delta": delta is not None,
        "gen_ideation": ideation is not None,
    }
    return result_entry, delta_entry, ideation_entry, source_map_entry, agg_usage, meta


# ============================================================================
# Main Processing Loop (async)
# ============================================================================

async def _run_async(args):
    """Main processing loop (async) with KV Cache Scheme 2 + delta/ideation/source_map."""
    global MAX_RETRIES
    MAX_RETRIES = getattr(args, "max_retries", 3)
    llm_call.LLM_RETRIES = getattr(args, "llm_retries", 3)

    folder_path = _resolve_folder(args.folder)
    input_dir = _resolve_input_dir(folder_path)
    output_dir = _resolve_output_dir(args, folder_path)
    concurrency = args.concurrency

    relevance_override = args.relevance
    limit = args.limit
    with_source_map = getattr(args, "with_source_map", False)
    with_delta = getattr(args, "with_delta", False)
    with_ideation = getattr(args, "with_ideation", False)
    reclassify_type = getattr(args, "reclassify_type", False)

    # Load inputs
    entity, paper_info, title_index, existing_cards, pending_papers = load_inputs(
        input_dir, output_dir, limit
    )

    if not pending_papers:
        result = {"status": "SUCCESS", "processed": 0, "failed": 0, "message": "All papers already processed"}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    # Init LLM
    llm = _create_llm(
        provider=getattr(args, "provider", None),
        model=getattr(args, "model", None),
        base_url=getattr(args, "base_url", None),
        thinking=getattr(args, "thinking", False),
        workspace=folder_path,
    )

    # Init logging — 统一写入 session.log + 通过 StreamHandler→stderr→run_log.txt
    setup_logging(os.path.join(folder_path, "session.log"))

    # Init run_log.txt — monkey-patch stderr 拦截 logging StreamHandler 输出
    log_path = os.path.join(output_dir, "run_log.txt")
    _log_file = open(log_path, "a", encoding="utf-8")

    _orig_stderr_write = sys.stderr.write
    def _log_only_write(msg):
        _log_file.write(msg)
        _log_file.flush()
    sys.stderr.write = _log_only_write

    # Init progress tracker
    progress_path = os.path.join(output_dir, "processing_progress.json")
    tracker = ProgressTracker(progress_path, len(pending_papers))

    # Init graceful shutdown + pipeline stop
    shutdown = GracefulShutdown()
    pipeline_stop = PipelineStop(
        window_size=20,
        min_samples=10,
        failure_rate_threshold=0.8,
    )

    # Semaphore for concurrency control
    semaphore = asyncio.Semaphore(concurrency)

    # Results accumulators
    cards_path = os.path.join(output_dir, "paper_cards.json")
    deltas_path = os.path.join(output_dir, "deltas.json")
    claims_path = os.path.join(output_dir, "claims_for_ideation.json")
    source_maps_path = os.path.join(output_dir, "source_maps.json")

    cards = dict(existing_cards)
    deltas_data = _load_json(deltas_path, {})
    claims_data = _load_json(claims_path, {})
    source_maps_data = _load_json(source_maps_path, {}) if with_source_map else {}

    # Token usage accumulator
    token_stats_lock = asyncio.Lock()
    token_stats = {"total_input": 0, "total_output": 0, "total_cached": 0}

    async def _accumulate_usage(paper_usage: dict):
        """Safely accumulate per-paper usage into shared token_stats."""
        if not paper_usage:
            return
        async with token_stats_lock:
            hit = paper_usage.get("prompt_cache_hit_tokens", 0) or 0
            miss = paper_usage.get("prompt_cache_miss_tokens", 0) or 0
            prompt = paper_usage.get("prompt_tokens", 0) or 0
            # OpenAI-shape usage: prompt_tokens already covers hit + miss, so
            # prefer the cache split when the gateway reports it.
            token_stats["total_input"] += (hit + miss) if (hit + miss) > 0 else prompt
            token_stats["total_output"] += paper_usage.get("completion_tokens", 0) or 0
            token_stats["total_cached"] += hit

    async def process_one(pid: str, ent: dict):
        """Process a single paper with semaphore."""
        if shutdown.should_stop or pipeline_stop.should_stop():
            tracker.record_skipped(
                pid, pipeline_stop.fatal_reason or "shutdown requested before start"
            )
            return

        async with semaphore:
            if shutdown.should_stop or pipeline_stop.should_stop():
                tracker.record_skipped(
                    pid, pipeline_stop.fatal_reason or "shutdown requested before processing"
                )
                return

            paper_usage: dict = {}
            try:
                paper_t0 = time.time()
                title = ent.get("title", "")
                info = _lookup_paper_info(paper_info, title_index, pid, title)
                has_full_text = _has_full_text(info)

                # Determine reading depth
                rel_level = relevance_override or ent.get("relevance_level", "L1")
                depth = _determine_reading_depth(rel_level, has_full_text)

                # Determine paper type — upstream takes priority over hub
                if reclassify_type:
                    # Force LLM re-classification, ignoring entity and hub types
                    paper_type, _ = await _classify_paper_type(
                        llm, title, ent.get("abstract", ""),
                        stop=pipeline_stop, where=f"{pid}/reclassify",
                        usage_out=paper_usage,
                    )
                else:
                    paper_type = ent.get("paper_type", "")
                    if paper_type not in VALID_TYPES:
                        paper_type = ""

                # Process (usage_out survives exceptions)
                card_entry, delta_entry, ideation_entry, source_map_entry, _, paper_meta = (
                    await _process_single_paper(
                        llm, pid, ent, info, depth, paper_type,
                        with_source_map=with_source_map,
                        with_delta=with_delta,
                        with_ideation=with_ideation,
                        stop=pipeline_stop,
                        usage_out=paper_usage,
                    )
                )

                paper_elapsed = time.time() - paper_t0
                actual_type = (
                    card_entry.get("paper_type", "") if isinstance(card_entry, dict) else ""
                ) or paper_type or "?"
                logging.info(
                    f"[PAPER] {pid}: {paper_elapsed:.1f}s, depth={depth}, type={actual_type}, "
                    f"info_type={info.get('info_type', 'N/A') if info else 'null'}"
                )

                # Save card incrementally
                if info.get('parse_report'):
                    import hashlib
                    card_entry['source_text_sha256'] = hashlib.sha256(info.get('sentences','').encode()).hexdigest()
                from paper_materials import source_identity, material_state
                card_entry["material_sha256"] = source_identity(ent, info)
                card_entry["material_state"] = material_state(ent, info)
                cards[pid] = card_entry
                _atomic_write_json(cards_path, cards)

                # Save delta incrementally
                if delta_entry is not None:
                    deltas_data[pid] = delta_entry
                    _atomic_write_json(deltas_path, deltas_data)

                # Save ideation claims incrementally
                if ideation_entry is not None:
                    claims_data[pid] = ideation_entry
                    _atomic_write_json(claims_path, claims_data)

                # Save source_map incrementally
                if source_map_entry is not None:
                    source_maps_data[pid] = source_map_entry
                    _atomic_write_json(source_maps_path, source_maps_data)

                # Upload to PaperHub
                arxiv_id = (info.get("arxiv_id") if info else None) or ent.get("arxiv_id")
                produced_new = (
                    (not paper_meta.get("card_from_hub"))
                    or paper_meta.get("gen_delta")
                    or paper_meta.get("gen_ideation")
                )
                should_upload = (
                    depth == "full"
                    and arxiv_id
                    and isinstance(card_entry, dict)
                    and card_entry.get("card")
                    and produced_new
                )
                if should_upload:
                    await _upload_paper_info(
                        arxiv_id, card_entry, delta_entry, source_map_entry, ideation_entry
                    )

                tracker.record_success(pid)
                await pipeline_stop.record_paper_success(pid)

            except asyncio.CancelledError:
                tracker.record_cancelled(
                    pid, pipeline_stop.fatal_reason or "pipeline task cancelled"
                )
                raise
            except PipelineStoppedError as exc:
                tracker.record_skipped(pid, str(exc))
                logging.info(f"[SKIPPED] {pid}: {exc}")
            except FatalLLMError as exc:
                error_msg = format_exception(exc, where=pid)
                tracker.record_failure(pid, error_msg, category="fatal_http")
                logging.error(f"[FATAL] {pid}: {error_msg}")
                shutdown.should_stop = True
            except Exception as exc:
                info = classify_error(exc)
                category = getattr(exc, "category", None) or info.category
                error_msg = format_exception(exc, where=pid)
                tracker.record_failure(pid, error_msg, category=category)
                logging.error(f"[ERROR] {pid}: {error_msg}")
                if await pipeline_stop.record_paper_failure(pid, exc, where=pid):
                    logging.error(f"[CIRCUIT_BREAKER] {pipeline_stop.fatal_reason}")
            finally:
                await _accumulate_usage(paper_usage)

    # Dispatch all tasks concurrently
    task_to_pid = {
        asyncio.create_task(process_one(pid, ent)): pid
        for pid, ent in pending_papers
    }
    pending = set(task_to_pid)
    while pending:
        done, pending = await asyncio.wait(
            pending,
            timeout=0.5,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            pid = task_to_pid[task]
            try:
                task.result()
            except asyncio.CancelledError:
                if not tracker.is_finalized(pid):
                    tracker.record_cancelled(pid, "pipeline task cancelled")
            except Exception as exc:
                # process_one normally consumes errors; retain accounting even
                # if an unexpected orchestration error escapes it.
                if not tracker.is_finalized(pid):
                    info = classify_error(exc)
                    tracker.record_failure(
                        pid,
                        format_exception(exc, where=f"{pid}/task"),
                        category=getattr(exc, "category", None) or info.category,
                    )
                    await pipeline_stop.record_paper_failure(
                        pid, exc, where=f"{pid}/task"
                    )

        if shutdown.should_stop or pipeline_stop.should_stop():
            reason = pipeline_stop.fatal_reason or "graceful shutdown requested"
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            for task in pending:
                pid = task_to_pid[task]
                if not tracker.is_finalized(pid):
                    tracker.record_cancelled(pid, reason)
            pending.clear()

    # Defensive invariant closure: every scheduled paper must have one terminal
    # state even if a task was cancelled before its coroutine body started.
    for task, pid in task_to_pid.items():
        if not tracker.is_finalized(pid):
            reason = pipeline_stop.fatal_reason or "task ended without a terminal result"
            if task.cancelled():
                tracker.record_cancelled(pid, reason)
            else:
                tracker.record_skipped(pid, reason)

    # Reorder cards to match selected_paper.json key order
    ordered_cards = {}
    for pid in entity:
        if pid in cards:
            ordered_cards[pid] = cards[pid]
    for pid in cards:
        if pid not in ordered_cards:
            ordered_cards[pid] = cards[pid]
    cards = ordered_cards
    _atomic_write_json(cards_path, cards)

    # Ensure deltas.json exists when delta extraction is enabled
    if with_delta and not os.path.exists(deltas_path):
        _atomic_write_json(deltas_path, deltas_data)
        logging.info(
            f"[DELTA] no delta extracted; wrote empty deltas.json "
            f"({len(deltas_data)} entries) to {deltas_path}"
        )

    # Compute quality stats
    type_dist = {}
    depth_dist = {}
    relevance_dist = {}
    total_card_chars = 0
    valid_count = 0
    for card_data in cards.values():
        pt = card_data.get("paper_type", "unknown")
        type_dist[pt] = type_dist.get(pt, 0) + 1
        dp = card_data.get("reading_depth", "unknown")
        depth_dist[dp] = depth_dist.get(dp, 0) + 1
        rl = card_data.get("relevance_level", "unknown")
        relevance_dist[rl] = relevance_dist.get(rl, 0) + 1
        if card_data.get("card"):
            total_card_chars += len(json.dumps(card_data["card"], ensure_ascii=False))
            valid_count += 1

    paper_count = tracker.processed
    quality_stats = {
        "type_distribution": type_dist,
        "reading_depth_distribution": depth_dist,
        "relevance_level_distribution": relevance_dist,
        "avg_card_chars": round(total_card_chars / max(len(cards), 1)),
        "completeness_rate": round(valid_count / max(len(cards), 1), 3),
        "total_deltas": len(deltas_data),
        "total_ideation_papers": len(claims_data),
        "total_source_maps": len(source_maps_data),
        "token_stats": {
            "total_input": token_stats["total_input"],
            "total_output": token_stats["total_output"],
            "total_cached": token_stats["total_cached"],
            "avg_input_per_paper": round(token_stats["total_input"] / max(paper_count, 1)),
            "avg_output_per_paper": round(token_stats["total_output"] / max(paper_count, 1)),
        },
    }

    # Determine final status
    if pipeline_stop.should_stop():
        status = "FAILED"
    elif tracker.failed == 0 and tracker.skipped == 0 and tracker.cancelled == 0:
        status = "SUCCESS"
    elif tracker.processed > 0:
        status = "PARTIAL_SUCCESS"
    else:
        status = "FAILED"

    tracker.finalize(
        status,
        quality_stats,
        fatal_reason=pipeline_stop.fatal_reason,
    )

    # Output final result to stdout
    result = {
        "status": status,
        "total": tracker.total,
        "processed": tracker.processed,
        "failed": tracker.failed,
        "skipped": tracker.skipped,
        "cancelled": tracker.cancelled,
        "accounted": tracker.accounted,
        "total_cards": len(cards),
        "total_deltas": len(deltas_data),
        "total_ideation_papers": len(claims_data),
        "quality_stats": quality_stats,
        "token_stats": quality_stats["token_stats"],
    }
    if tracker.failed_papers:
        result["failed_papers"] = tracker.failed_papers[:10]
    if tracker.skipped_papers:
        result["skipped_papers"] = tracker.skipped_papers[:10]
    if tracker.cancelled_papers:
        result["cancelled_papers"] = tracker.cancelled_papers[:10]
    if pipeline_stop.fatal_reason:
        result["fatal_reason"] = pipeline_stop.fatal_reason

    # Restore stderr and close log file
    sys.stderr.write = _orig_stderr_write
    _log_file.close()

    print(json.dumps(result, ensure_ascii=False, indent=2))
