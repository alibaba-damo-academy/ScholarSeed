from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

import filesystem
import io_utils
import state
import web_registration
import worker

QUERY = "Attention Is All You Need"
PAPER_URL = "https://arxiv.org/html/1706.03762v1"


class WebEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name) / ("nested-" * 9) / ("papers-" * 9) / ("session-" * 9)
        state.initialize(self.work)

    def record(self, outcomes):
        return web_registration.record(self.work, {"queries": outcomes}, artifact=worker.artifact)

    def test_raw_provider_evidence_and_failure_survive_replay(self):
        failed = {
            "query": QUERY,
            "status": "authentication_error",
            "provider": "official-api",
            "provider_status": "unavailable",
            "raw_result_path": "results/web-q001-official-a001.json",
            "elapsed_seconds": 0,
            "error": "credential_unavailable",
            "papers": [],
        }
        success = {
            "query": QUERY,
            "status": "success",
            "provider": "codex-native",
            "provider_status": "completed",
            "raw_result_path": "results/web-q001-native-a001.json",
            "elapsed_seconds": None,
            "papers": [{"title": QUERY, "url": PAPER_URL}],
        }
        outcomes = [failed, success]
        first = self.record(outcomes)
        second = self.record(copy.deepcopy(outcomes))
        self.assertEqual(first["web_registration"]["query_count"], 2)
        self.assertEqual(second["web_registration"]["batch_count"], 1)
        self.assertEqual(second["web_registration"]["query_count"], 2)
        for outcome in outcomes:
            identity = web_registration.key(web_registration.observations(outcome))
            path = self.work / f"results/web-{identity}.json"
            self.assertGreater(len(str(path)), 260)
            stored = io_utils.read_json(path)
            self.assertEqual(stored["raw_outcome"], outcome)
            self.assertEqual(io_utils.read_json(self.work / stored["attempts"][0]), outcome)
        papers = io_utils.read_json(self.work / "pool.json")["papers"]
        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0]["arxiv_id"], "1706.03762v1")
        self.assertFalse(papers[0].get("abstract"))
        self.assertEqual(len(io_utils.read_json(self.work / "query-log.json")["queries"]), 2)

    def test_successful_empty_outcome_stays_empty_and_idempotent(self):
        empty = {
            "query": QUERY,
            "status": "success",
            "provider": "official-api",
            "provider_status": "empty",
            "raw_result_path": "results/web-q002-official-a001.json",
            "elapsed_seconds": 0.01,
            "papers": [],
        }
        self.record([empty])
        replay = self.record([empty])
        self.assertEqual(replay["web_registration"]["query_count"], 1)
        self.assertEqual(io_utils.read_json(self.work / "pool.json")["papers"], [])
        self.assertTrue(filesystem.path_exists(self.work / "query-log.json"))
