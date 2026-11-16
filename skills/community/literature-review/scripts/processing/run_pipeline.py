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
from types import SimpleNamespace
from pathlib import Path

from service.literature.service.atomic import material_asset, prepare_abstract
from service.literature.service.comprehension import ReadingInput, ComprehensionError, EXTRACTION_INCOMPLETE, extraction_blocks


import llm_call  # for setting LLM_RETRIES at runtime
from config import _create_llm
from llm_call import _merge_usage
from log_utils import setup_logging
from paper_materials import ABSTRACT_ONLY, source_identity
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
    trim_content_partial,
)
from paper_materials import QUALITY_ACTION, QUALITY_READY, QUALITY_DEGRADED, quality_problem
from step0_load import load_inputs
from utils import (
    _atomic_write_json,
    _load_json,
    _lookup_paper_info,
    _resolve_folder,
    _resolve_input_dir,
    _resolve_output_dir,
)
from diagnostics import EvidenceLog, text_size

# ---- Retry constant (can be overridden at runtime) ----
MAX_RETRIES = 3       # Outer validation retry (card quality check)


# ============================================================================
# Core Processing Logic — single paper
# ============================================================================

async def _process_single_paper(
    llm,
    paper_id: str,
    entity_entry: dict,
    paper_info_entry: dict | None,
    depth: str,
    paper_type: str,
    with_source_map: bool = False,
    with_delta: bool = False,
    with_ideation: bool = False,
    stop: Optional[PipelineStop] = None,
    usage_out: Optional[dict] = None,
    diagnostic=None,
) -> tuple[dict, Optional[dict], Optional[dict], Optional[dict], dict]:
    """Process a single paper end-to-end (KV Cache Scheme 2).

    Returns: (card_entry, delta_entry, ideation_entry, source_map_entry, aggregated_usage).
    If usage_out is passed, usage is also accumulated into it (survives exceptions).
    """
    paper_info_entry = paper_info_entry or {}
    if with_delta or with_ideation:
        raise ValueError('Review material extraction produces L1 cards only, without delta or ideation stages')
    title = entity_entry.get('title') or '(title unavailable)'
    abstract = entity_entry.get('abstract') or ''
    agg_usage = usage_out if usage_out is not None else {}
    saved = paper_info_entry.get('paper_card')
    if saved and not quality_problem(saved):
        return {**saved, 'paperId': paper_id}, None, None, None, agg_usage
    prepared = (paper_info_entry.get('parse_report') or {}).get('reading_input')
    source = (ReadingInput(**{**prepared, 'title': title, 'abstract': abstract}) if prepared
              else prepare_abstract(title, abstract))

    class Client:
        def __init__(self):
            self.records = []
            self.failure: Exception | None = None
            self.call_number = 0

        async def chat(self, system, user, *, max_tokens=None, json_mode=False,
                       cache_prefix=None, temperature=None, images=(), **kwargs):
            self.failure = None
            if images:
                raise ValueError('Review material extraction is text-only')
            self.call_number += 1
            call_number = self.call_number

            def observe(event, **values):
                response = values.pop('response', None)
                if response is not None:
                    parsed = llm_call._extract_json_from_response(response)
                    if response.lstrip().startswith('<card>'):
                        try:
                            parsed = {key: value for key, value in extraction_blocks(response, paper_type).items()
                                      if key != 'paper_type'}
                        except ComprehensionError as error:
                            parsed = None
                            values['protocol_error'] = str(error)
                    values['response_ref'] = diagnostic.result(paper_id, 'model_response',
                                                               {'text': response, 'parsed': parsed})
                    values['returned_keys'] = sorted(parsed) if isinstance(parsed, dict) else None
                    fields = parsed.get('fields') if isinstance(parsed, dict) else None
                    values['repair_fields'] = sorted(fields) if isinstance(fields, dict) else None
                diagnostic.event(event, paper_id=paper_id, call_number=call_number, **values)

            if diagnostic:
                diagnostic.event('model_call', paper_id=paper_id, call_number=call_number,
                                 system_size=text_size(system), input_size=text_size(user))
            try:
                value, usage = await llm_call._llm_call(
                    llm, system, user, expect_json=json_mode, max_tokens=max_tokens,
                    stop=stop, where=f'{paper_id}/asset', usage_out=agg_usage,
                    **({'observer': observe} if diagnostic else {}))
            except Exception as error:
                self.failure = error
                raise
            self.records.append(SimpleNamespace(
                input_tokens=usage.get('prompt_tokens', 0), output_tokens=usage.get('completion_tokens', 0),
                invocation_id='', model_key='', receipt_id=''))
            return json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else value, usage

    payload = Path(paper_info_entry['source_file']).read_bytes() if prepared else None
    client = Client()
    try:
        asset = await material_asset(source, client, paper_type=paper_type,
                                     paper=entity_entry, pdf_payload=payload)
    except Exception as exc:
        if diagnostic:
            details = getattr(exc, 'diagnostics', {})
            diagnostic.result(paper_id, 'extraction_failure', {
                'error_type': type(exc).__name__, 'error': str(exc),
                'l1': details.get('l1'), 'source_mapping': details.get('source_mapping'),
                'source_revision': source.snapshot.get('source_revision'), 'usage': agg_usage})
        if client.failure is not None:
            raise client.failure from client.failure.__cause__
        if not isinstance(exc, ComprehensionError) or prepared or str(exc) != EXTRACTION_INCOMPLETE:
            raise
        # The original abstract remains usable evidence when optional structured
        # extraction fails. This task-local record is not a cached framework L1.
        card = {**{key: entity_entry.get(key) for key in ('title', 'authors', 'year')},
                'paperId': paper_id, 'abstract': abstract,
                'card': {'abstract': abstract}, 'reading_depth': ABSTRACT_ONLY,
                'material_sha256': source_identity(entity_entry, paper_info_entry),
                'has_parse_dict': False,
                'extraction_notice': str(exc)}
        return card, None, None, None, agg_usage
    card = {**asset['l1'], 'paperId': paper_id, 'title': title, 'abstract': abstract,
            'authors': entity_entry.get('authors') or [], 'year': entity_entry.get('year'),
            'source_coverage': asset['metadata']['coverage'],
            'asset_revision': asset['revision'], 'has_parse_dict': bool(prepared)}
    return card, None, None, None, agg_usage


# ============================================================================
# Main Processing Loop (async)
# ============================================================================

async def _run_async(args):
    """Main processing loop (async) with KV Cache Scheme 2 + delta/ideation/source_map."""
    global MAX_RETRIES
    MAX_RETRIES = getattr(args, "max_retries", 3)
    llm_call.LLM_RETRIES = getattr(args, "llm_retries", 3)

    folder_path = _resolve_folder(args.folder)
    diagnostic = EvidenceLog(folder_path, 'processing')
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
    pending_ids = {identity for identity, entry in pending_papers}
    for identity in entity.keys() & existing_cards.keys() - pending_ids:
        diagnostic.event('paper_reused', paper_id=identity, model_calls=0,
                         result_store='03_process/paper_cards.json')

    if not pending_papers:
        blocked = [pid for pid in entity if quality_problem(existing_cards.get(pid))]
        result = {"status": "PARTIAL_SUCCESS" if blocked else "SUCCESS", "processed": 0,
                  "failed": 0, "quality_blocked_ids": blocked,
                  "message": "Saved extraction needs review; no automatic re-extraction" if blocked
                  else "All papers already processed"}
        if blocked:
            result["next_action"] = QUALITY_ACTION
        diagnostic.event('run_finished', status=result['status'], processed=0)
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
    diagnostic.event('model_selected', model=getattr(llm, 'model', None),
                     retry_owner=getattr(llm, 'retry_owner', 'script'), papers=len(pending_papers))

    setup_logging(diagnostic.directory / 'processing.log')

    log_path = diagnostic.directory / 'stderr.log'
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
            paper_started = time.monotonic()
            diagnostic.event('paper_started', paper_id=pid)
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
                card_entry, delta_entry, ideation_entry, source_map_entry, _ = (
                    await _process_single_paper(
                        llm, pid, ent, info, depth, paper_type,
                        with_source_map=with_source_map,
                        with_delta=with_delta,
                        with_ideation=with_ideation,
                        stop=pipeline_stop,
                        usage_out=paper_usage,
                        diagnostic=diagnostic,
                    )
                )

                paper_elapsed = time.time() - paper_t0
                actual_type = (
                    card_entry.get("paper_type", "") if isinstance(card_entry, dict) else ""
                ) or paper_type or "?"
                logging.info(
                    f"[PAPER] {pid}: {paper_elapsed:.1f}s, depth={card_entry.get('reading_depth', depth)}, type={actual_type}, "
                    f"info_type={info.get('info_type', 'N/A') if info else 'null'}"
                )

                # Save card incrementally
                from paper_materials import source_identity, material_state
                card_entry["material_state"] = material_state(ent, info)
                cards[pid] = card_entry
                diagnostic.result(pid, 'card_result', card_entry)
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

                problem = quality_problem(card_entry)
                if problem:
                    tracker.record_failure(pid, problem, category="validation")
                    logging.warning(f"[QUALITY_BLOCKED] {pid}: {problem}; saved locally")
                    return

                tracker.record_success(pid)
                await pipeline_stop.record_paper_success(pid)

            except asyncio.CancelledError:
                diagnostic.event('paper_cancelled', paper_id=pid)
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
                diagnostic.event('paper_failed', paper_id=pid, error_type=type(exc).__name__, error=str(exc))
                info = classify_error(exc)
                category = getattr(exc, "category", None) or info.category
                error_msg = format_exception(exc, where=pid)
                tracker.record_failure(pid, error_msg, category=category)
                logging.error(f"[ERROR] {pid}: {error_msg}")
                if await pipeline_stop.record_paper_failure(pid, exc, where=pid):
                    logging.error(f"[CIRCUIT_BREAKER] {pipeline_stop.fatal_reason}")
            finally:
                await _accumulate_usage(paper_usage)
                diagnostic.event('paper_finished', paper_id=pid,
                                 elapsed_seconds=time.monotonic() - paper_started, usage=paper_usage)

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
        if card_data.get("card") and not quality_problem(card_data):
            total_card_chars += len(json.dumps(card_data["card"], ensure_ascii=False))
            valid_count += 1

    paper_count = tracker.processed
    quality_stats = {
        "quality_blocked_ids": [pid for pid in entity if quality_problem(cards.get(pid))],
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
    elif tracker.failed == 0 and tracker.skipped == 0 and tracker.cancelled == 0 and not quality_stats["quality_blocked_ids"]:
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
    diagnostic.event('run_finished', status=status, total=tracker.total,
                     processed=tracker.processed, failed=tracker.failed, usage=token_stats)
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
