"""Initial scope admission for the precise literature workflow."""

import tempfile
import unittest
from pathlib import Path

import run_state
import stage
from io_utils import atomic_write_json, read_json


class IntentAdmissionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        request = root / "request.txt"
        request.write_text(
            "Find three controlled studies on position effects in long context.\n", encoding="utf-8"
        )
        self.started = stage.start(root, request)
        self.run = Path(self.started["run_dir"])
        self.intent_file = Path(self.started["intent_file"])
        self.intent = read_json(self.intent_file)

    def prepare(self):
        atomic_write_json(self.intent_file, self.intent)
        return stage.prepare_search(self.run, self.intent_file, "balance", None, None, None)

    def test_clear_initial_request_dispatches_without_user_confirmation(self):
        self.assertIn("confirmation_source=request_clear", self.started["intent_instructions"])
        self.assertIn("user-visible scope statement", self.started["intent_instructions"])
        self.intent.update(confirmed=True, confirmation_source="request_clear", max_results=3)
        self.assertEqual(self.prepare()["status"], "dispatch_required")
        self.assertEqual(read_json(self.run / "intent.json"), self.intent)
        self.assertFalse(read_json(self.run / "workflow.json")["auto_delegated"])

    def test_unresolved_initial_scope_cannot_dispatch(self):
        with self.assertRaisesRegex(ValueError, "intent is not confirmed"):
            self.prepare()
        self.assertEqual(run_state.read_state(self.run)["status"], "INITIALIZED")

    def test_clear_scope_must_preserve_original_request(self):
        self.intent.update(
            confirmed=True, confirmation_source="request_clear", original_request="Different topic"
        )
        with self.assertRaisesRegex(ValueError, "original request"):
            self.prepare()
        self.assertEqual(run_state.read_state(self.run)["status"], "INITIALIZED")
