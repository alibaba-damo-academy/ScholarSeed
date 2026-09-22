"""Resource transition evidence is queryable without owning resource state."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.resources.service.events import ResourceVersionEvent, emit


class ResourceEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.trace = self.home / "logs" / "trace"
        evidence_path = patch("service.resources.service.events.TRACE_DIR", self.trace)
        evidence_path.start()
        self.addCleanup(evidence_path.stop)
        self.logger = logging.getLogger("test.resources.evidence")

    def test_committed_review_is_queryable_with_exact_correlation(self) -> None:
        emit(
            self.logger,
            ResourceVersionEvent.REVIEW_ACCEPT,
            project_id="../../outside",
            file_id="file-one",
            review_id="review-one",
            session_id="session-one",
            turn_id="turn-one",
            pending_revision=4,
            revision="sha256:current",
            version_id="version-two",
            result_code="committed",
        )
        result = subprocess.run(
            [sys.executable, "-m", "damoatrace", "events", "--session", "session-one", "--full"],
            env={**os.environ, "DAMOATRACE_HOME": str(self.home)},
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        envelope = json.loads(result.stdout)
        self.assertEqual(envelope["total"], 1)
        event = envelope["rows"][0]
        self.assertEqual(event["name"], ResourceVersionEvent.REVIEW_ACCEPT.value)
        self.assertEqual(event["attributes"]["pending_revision"], 4)
        self.assertEqual(event["attributes"]["file_id"], "file-one")
        self.assertEqual(event["attributes"]["review_id"], "review-one")
        self.assertEqual(event["attributes"]["turn_id"], "turn-one")
        self.assertEqual(event["attributes"]["version_id"], "version-two")
        replay = subprocess.run(
            [sys.executable, "-m", "damoatrace", "span", event["span_id"]],
            env={**os.environ, "DAMOATRACE_HOME": str(self.home)},
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        self.assertTrue(json.loads(replay.stdout)["evidence"])
        self.assertEqual(len(tuple(self.trace.glob("*.jsonl"))), 1)
        self.assertFalse((self.home / "outside").exists())

    def test_trace_write_failure_is_visible_but_does_not_fail_committed_operation(self) -> None:
        with (
            patch("service.resources.service.events.EvidenceWriter", side_effect=OSError("full")),
            self.assertLogs(self.logger, level="WARNING") as logs,
        ):
            emit(
                self.logger,
                ResourceVersionEvent.REVIEW_REJECT,
                project_id="project-one",
                review_id="review-one",
                file_id="file-one",
            )
        self.assertIn("resources evidence write failed", logs.output[0])

    def test_scan_progress_does_not_write_a_transition_trace(self) -> None:
        with patch("service.resources.service.events.EvidenceWriter") as writer:
            emit(self.logger, ResourceVersionEvent.SCAN_PROGRESS, project_id="project-one")
        writer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
