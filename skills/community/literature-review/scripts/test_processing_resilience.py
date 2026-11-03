#!/usr/bin/env scholarseed-skill-python
"""Regression tests for processing retries, circuit breaking, and accounting."""
from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROCESSING = ROOT / "scripts" / "processing"
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(PROCESSING))

import llm_call  # noqa: E402
import run_pipeline
import pdf_fixture
from paper_source_parser import parse_source
from llm import _LightLLM  # noqa: E402
from progress import (  # noqa: E402
    LLMCallError,
    PipelineStop,
    ProgressTracker,
    classify_error,
    format_exception,
)


class FakeResponse:
    status_code = 429
    headers = {"Retry-After": "7"}


class FakeRateLimitError(Exception):
    status_code = 429
    response = FakeResponse()


class FlakyLLM:
    timeout = 600

    def __init__(self, failures: list[BaseException]):
        self.failures = list(failures)

    async def chat(self, *args, **kwargs):
        if self.failures:
            raise self.failures.pop(0)
        return '{"ok": true}', {"completion_tokens": 2}


class ProcessingResilienceTest(unittest.IsolatedAsyncioTestCase):
    async def test_table_warning_text_reaches_card_model(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            source = pathlib.Path(folder) / 'paper.pdf'
            document = pdf_fixture.open()
            page = document.new_page()
            page.insert_text((50, 100), 'Table 1. Borderless comparison.')
            page.insert_text((50, 150), 'The estimator is calibrated on independent data.')
            document.save(source)
            document.close()
            parsed = parse_source(source)
        self.assertEqual(parsed['status'], 'ok')
        with patch.object(run_pipeline, '_warmup_cache', new=AsyncMock()), patch.object(
            run_pipeline, '_extract_card_combined', new=AsyncMock(side_effect=RuntimeError('card model reached'))
        ) as extract:
            with self.assertRaisesRegex(RuntimeError, 'card model reached'):
                await run_pipeline._process_single_paper(
                    types.SimpleNamespace(), 'paper', {'title': 'Evidence', 'abstract': 'A summary.'},
                    {'info_type': parsed['info_type'], 'sentences': parsed['sentences'], 'parse_report': parsed},
                    'full', 'method',
                )
        self.assertIn('calibrated on independent data', str(extract.call_args))

    async def test_metadata_without_text_never_generates_a_card(self) -> None:
        import run_pipeline
        llm = types.SimpleNamespace(chat=AsyncMock())
        with self.assertRaisesRegex(ValueError, "no abstract or full text"):
            await run_pipeline._process_single_paper(
                llm, "web-paper", {"title": "Metadata-only discovery", "abstract": ""},
                {}, "metadata_only", "",
            )
        llm.chat.assert_not_awaited()

    async def test_fulltext_is_used_when_a_low_tier_paper_has_no_abstract(self) -> None:
        import run_pipeline
        # Stop at extraction and inspect the actual evidence sent onward.
        class EvidenceReached(Exception):
            pass
        with patch.object(run_pipeline, "_warmup_cache", new=AsyncMock()), patch.object(
            run_pipeline, "_extract_card_combined", new=AsyncMock(side_effect=EvidenceReached)
        ) as extract:
            with self.assertRaises(EvidenceReached):
                await run_pipeline._process_single_paper(
                    types.SimpleNamespace(), "web-paper", {"title": "Has text"},
                    {"info_type": "origin_latex", "sections": "#1 Actual full-text evidence."},
                    "metadata_only", "method",
                )
        self.assertIn("#1 Actual full-text evidence.", str(extract.call_args))

    async def test_timeout_error_is_never_blank(self) -> None:
        detail = format_exception(asyncio.TimeoutError(), where="p/card", timeout=600)
        self.assertIn("category=timeout", detail)
        self.assertIn("operation exceeded 600s", detail)

    async def test_retry_after_is_respected_by_script_owned_retry(self) -> None:
        llm = FlakyLLM([FakeRateLimitError("busy")])
        old_retries = llm_call.LLM_RETRIES
        llm_call.LLM_RETRIES = 2
        try:
            with patch.object(llm_call.random, "uniform", return_value=0.0), patch.object(
                llm_call.asyncio, "sleep", new=AsyncMock()
            ) as sleep:
                parsed, _ = await llm_call._llm_call(
                    llm, "system", "user", expect_json=True, where="p/card"
                )
            self.assertEqual(parsed, {"ok": True})
            sleep.assert_awaited_once_with(7.0)
            self.assertEqual(classify_error(FakeRateLimitError()).category, "rate_limit")
        finally:
            llm_call.LLM_RETRIES = old_retries

    async def test_exhausted_timeout_preserves_category_and_context(self) -> None:
        llm = FlakyLLM([asyncio.TimeoutError()])
        old_retries = llm_call.LLM_RETRIES
        llm_call.LLM_RETRIES = 1
        try:
            with self.assertRaises(LLMCallError) as caught:
                await llm_call._llm_call(
                    llm, "system", "user", expect_json=True, where="p/card"
                )
            self.assertEqual(caught.exception.category, "timeout")
            self.assertIn("operation exceeded 600s", str(caught.exception))
        finally:
            llm_call.LLM_RETRIES = old_retries

    async def test_breaker_counts_terminal_papers_not_attempts(self) -> None:
        stop = PipelineStop(window_size=20, min_samples=10, failure_rate_threshold=0.8)
        error = LLMCallError("timeout", "card", 5, "timed out")
        for index in range(9):
            self.assertFalse(
                await stop.record_paper_failure(f"p{index}", error, where="card")
            )
        self.assertFalse(stop.should_stop())
        self.assertTrue(await stop.record_paper_failure("p9", error, where="card"))
        self.assertTrue(stop.should_stop())
        self.assertIn("10/10 recent papers failed", stop.fatal_reason or "")

    async def test_sliding_window_tolerates_isolated_failures(self) -> None:
        stop = PipelineStop(window_size=20, min_samples=10, failure_rate_threshold=0.8)
        error = LLMCallError("timeout", "card", 5, "timed out")
        for index in range(10):
            await stop.record_paper_success(f"ok{index}")
            await stop.record_paper_failure(f"bad{index}", error, where="card")
        self.assertFalse(stop.should_stop())

    async def test_sliding_window_trips_on_sustained_same_error(self) -> None:
        stop = PipelineStop(window_size=20, min_samples=10, failure_rate_threshold=0.8)
        error = LLMCallError("timeout", "card", 5, "timed out")
        for index in range(4):
            await stop.record_paper_success(f"ok{index}")
        for index in range(15):
            self.assertFalse(
                await stop.record_paper_failure(f"bad{index}", error, where="card")
            )
        self.assertTrue(
            await stop.record_paper_failure("bad15", error, where="card")
        )
        self.assertIn("16/20 recent papers failed", stop.fatal_reason or "")


class ProgressAccountingTest(unittest.TestCase):
    def test_requested_runtime_limits_are_packaged(self) -> None:
        live = json.loads(
            (ROOT / "config" / "model_config.fast.json").read_text(encoding="utf-8")
        )
        example = json.loads(
            (ROOT / "config" / "model_config.fast.example.json").read_text(
                encoding="utf-8"
            )
        )
        profile = json.loads(
            (ROOT / "config" / "profiles" / "fast.json").read_text(encoding="utf-8")
        )
        self.assertEqual(live["stages"]["processing"]["timeout"], 600)
        self.assertEqual(example["stages"]["processing"]["timeout"], 600)
        self.assertEqual(live["stages"]["processing"]["max_tokens"], 16000)
        processing = next(stage for stage in profile["stages"] if stage["id"] == "processing")
        command = processing["steps"][0]
        self.assertEqual(command[command.index("--concurrency") + 1], "20")

    def test_all_terminal_states_are_explicit_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "processing_progress.json"
            tracker = ProgressTracker(str(path), total=4)
            tracker.record_success("p1")
            tracker.record_failure("p2", "timeout", category="timeout")
            tracker.record_skipped("p3", "breaker open")
            tracker.record_cancelled("p4", "in-flight cancellation")
            tracker.record_failure("p1", "duplicate must be ignored")
            tracker.finalize("PARTIAL_SUCCESS", {}, fatal_reason="breaker open")

            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["accounted"], data["total"])
            self.assertEqual(
                data["processed"] + data["failed"] + data["skipped"] + data["cancelled"],
                data["total"],
            )
            self.assertEqual(data["fatal_reason"], "breaker open")

    def test_finalize_rejects_unaccounted_papers(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tracker = ProgressTracker(
                str(pathlib.Path(temp_dir) / "processing_progress.json"), total=1
            )
            with self.assertRaisesRegex(RuntimeError, "accounting invariant"):
                tracker.finalize("FAILED", {})

    def test_openai_sdk_retries_are_disabled(self) -> None:
        captured: dict = {}

        class FakeAsyncOpenAI:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        fake_openai = types.SimpleNamespace(AsyncOpenAI=FakeAsyncOpenAI)
        fake_httpx = types.SimpleNamespace(Timeout=lambda *args, **kwargs: (args, kwargs))
        with patch.dict(sys.modules, {"openai": fake_openai, "httpx": fake_httpx}):
            _LightLLM("model", "https://example.invalid/v1", "token")
        self.assertEqual(captured["max_retries"], 0)


if __name__ == "__main__":
    unittest.main()
