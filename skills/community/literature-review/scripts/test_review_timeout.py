"""Five-minute policy gates, user-reply precedence and durable timeout receipts."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import review_timeout as timer
import slr
import test_native_pipeline as fixtures
from citation_styles import style_ids
from manuscript import prepare
from operator_cli import approve, configure_outline, review_packet
from task_contract import atomic_json, configure, read_request, validate_request
from writing_contract import require_approval, digest

ROOT = Path(__file__).resolve().parents[1]

CHOICES = {
    "formats": ["markdown", "latex_pdf"],
    "templates": [{"id": "neurips", "usable": True}, {"id": "ctexart", "usable": True}],
    "citation_styles": [{"id": style_id, "usable": True} for style_id in style_ids()],
}


class ReviewTimeoutTest(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.NativeTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.ws = fixture.ws
        self.outline = fixture.outline
        self.options = patch("publication.publication_options", return_value=CHOICES)
        self.options.start()
        self.addCleanup(self.options.stop)
        self.now = 1000.0
        clock = patch("review_timeout.time.time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        configure(
            self.ws, {"outline_review": "timeout_auto", "publication": {"citation_style": "ieee"}}
        )
        self.packet = review_packet(self.ws)
        self.pid = self.packet["packet_id"]

    def host_receipt(self, decision):
        return {"packet_id": self.pid, "snapshot_id": digest(self.packet["snapshot"]),
                "request_id": "product-question", "started_at": self.now - 300,
                "deadline_at": self.now, "decision": decision}

    def test_every_registered_style_completes_timeout_in_both_languages(self):
        for language in ("CHINESE", "ENGLISH"):
            for style_id in style_ids():
                with self.subTest(language=language, style=style_id):
                    configure(self.ws, {"language": language,
                                        "publication": {"citation_style": style_id}})
                    outline = copy.deepcopy(self.outline)
                    outline["outline_tree"][0]["title"] = "摘要" if language == "CHINESE" else "Abstract"
                    configure_outline(self.ws, outline)
                    self.packet = review_packet(self.ws)
                    self.pid = self.packet["packet_id"]
                    receipt = self.host_receipt({"timed_out": True})
                    result = timer.complete(self.ws, receipt)
                    self.assertEqual(result["state"], "timeout_applied")
                    self.assertTrue(result["can_continue"])
                    self.assertEqual(result["publication"]["citation_style"], style_id)
                    self.assertTrue(result["notice"])
                    if style_id == "gbt7714_2025":
                        self.assertIn("GB/T 7714", result["notice"])
                        self.assertIn("2025", result["notice"])
                    approval = json.loads((self.ws / "04_outline/approval.json").read_text())
                    self.assertEqual(approval["publication"]["citation_style"], style_id)
                    self.assertIsNone(approval["user_response"])
                    self.assertEqual(timer.complete(self.ws, receipt)["decision_id"], result["decision_id"])
                    require_approval(self.ws)

    def test_gbt_manual_confirmation_preserves_style_without_timeout(self):
        configure(self.ws, {"publication": {"citation_style": "gbt7714_2025"}})
        self.packet = review_packet(self.ws)
        self.pid = self.packet["packet_id"]
        result = timer.complete(self.ws, self.host_receipt({"answers": {"product-question": "Confirmed."}}))
        self.assertEqual(result["state"], "responded")
        approve(self.ws, {"packet_id": self.pid, "user_response": "Confirmed."})
        approval = json.loads((self.ws / "04_outline/approval.json").read_text())
        self.assertEqual(approval["publication"]["citation_style"], "gbt7714_2025")
        self.assertFalse(timer.apply_timeout(self.ws, self.pid)["did_apply"])
        require_approval(self.ws)

    def test_internal_key_error_is_not_reported_as_invalid_user_input(self):
        output = StringIO()
        with (
            patch.object(sys, "argv", ["slr", "writing", "review-complete", "--workspace", str(self.ws)]),
            patch.object(slr, "cmd_writing", side_effect=KeyError("gbt7714_2025")),
            redirect_stdout(output),
        ):
            self.assertEqual(slr.main(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["code"], "INTERNAL_ERROR")
        self.assertEqual(result["error_type"], "KeyError")
        self.assertIn("gbt7714_2025", result["message"])
        self.assertNotIn("describe_input", result)
        self.assertIn("Preserve", result["next_action"])

    def test_host_timeout_receipt_applies_once_without_fake_answer(self):
        receipt = self.host_receipt({"timed_out": True})
        result = timer.complete(self.ws, receipt)
        self.assertTrue(result["can_continue"])
        approval = json.loads((self.ws / "04_outline/approval.json").read_text())
        self.assertEqual(approval["decision_source"], "timeout_default")
        self.assertIsNone(approval["user_response"])
        self.assertEqual(timer.complete(self.ws, receipt)["decision_id"], result["decision_id"])
        require_approval(self.ws)

    def test_host_revision_is_not_approval_and_stops_timeout(self):
        receipt = self.host_receipt({"answers": {"product-question": "请增加对比章节"}})
        result = timer.complete(self.ws, receipt)
        self.assertFalse(result["can_continue"])
        self.assertEqual(result["user_response"], "请增加对比章节")
        with self.assertRaises(ValueError):
            require_approval(self.ws)
        with self.assertRaises(ValueError):
            timer.complete(self.ws, self.host_receipt({"timed_out": True}))

    def test_host_new_packet_can_timeout_after_previous_timeout(self):
        timer.complete(self.ws, self.host_receipt({"timed_out": True}))
        outline = copy.deepcopy(self.outline)
        outline["survey_title"] = "Revised title"
        configure_outline(self.ws, outline)
        self.packet = review_packet(self.ws)
        self.pid = self.packet["packet_id"]
        result = timer.complete(self.ws, self.host_receipt({"timed_out": True}))
        self.assertTrue(result["can_continue"])
        require_approval(self.ws)

    def test_host_timeout_recovers_interrupted_approval_write(self):
        receipt = self.host_receipt({"timed_out": True})
        original = timer.atomic_json

        def write(path, value):
            if Path(path).name == "approval.json":
                raise OSError("interrupted write")
            original(path, value)

        with patch.object(timer, "atomic_json", side_effect=write):
            with self.assertRaises(OSError):
                timer.complete(self.ws, receipt)
        result = timer.complete(self.ws, receipt)
        self.assertTrue(result["can_continue"])
        require_approval(self.ws)

    def test_host_receipt_rejects_stale_snapshot_and_early_timeout(self):
        receipt = self.host_receipt({"timed_out": True})
        receipt["snapshot_id"] = "stale"
        with self.assertRaises(ValueError):
            timer.complete(self.ws, receipt)
        receipt = self.host_receipt({"timed_out": True})
        receipt["started_at"] += 1
        receipt["deadline_at"] += 1
        with self.assertRaises(ValueError):
            timer.complete(self.ws, receipt)

    def start(self):
        return timer.start(self.ws, {"packet_id": self.pid, "displayed": True})

    def test_new_tasks_default_to_five_minutes_but_old_policies_stay(self):
        with tempfile.TemporaryDirectory() as folder:
            configure(folder, {"intent": "Write a review."})
            self.assertEqual(read_request(folder)["outline_review"], "timeout_auto")
            self.assertEqual(read_request(folder)["review_timeout_seconds"], 300)
            configure(folder, {"outline_review": "required"})
            configure(folder, {"publication": {"citation_style": "ieee"}})
            self.assertEqual(read_request(folder)["outline_review"], "required")
        self.assertEqual(
            validate_request({"intent": "Legacy task without policy."})["outline_review"],
            "required",
        )
        with self.assertRaisesRegex(ValueError, "300"):
            configure(self.ws, {"review_timeout_seconds": 1})
        with self.assertRaisesRegex(ValueError, "authorization"):
            configure(self.ws, {"outline_review": "auto", "auto_authorization": ""})

    def test_reading_packet_does_not_start_timer_and_redisplay_does_not_reset_it(self):
        self.assertEqual(self.packet["confirmation"]["state"], "awaiting_display")
        self.assertFalse((self.ws / "04_outline/review_wait.json").exists())
        with self.assertRaises(ValueError):
            timer.start(self.ws, {"packet_id": self.pid, "displayed": False})
        state = self.start()
        self.assertEqual(state["deadline_at"], 1300)
        self.now = 1100
        self.assertEqual(review_packet(self.ws)["packet_id"], self.pid)
        self.assertEqual(self.start()["deadline_at"], 1300)
        self.assertEqual(timer.status(self.ws, self.pid)["remaining_seconds"], 200)

    def test_schema_declares_effective_timeout_request(self):
        schema = json.loads((ROOT / "schema/writing_request.schema.json").read_text())
        request = read_request(self.ws)
        self.assertFalse(set(request) - set(schema["properties"]))
        self.assertIn(request["outline_review"], schema["properties"]["outline_review"]["enum"])
        self.assertEqual(
            request["review_timeout_seconds"],
            schema["properties"]["review_timeout_seconds"]["const"],
        )

    def test_expiry_does_not_bypass_gate_until_valid_policy_receipt(self):
        self.start()
        for moment in (1000, 1299.999):
            self.now = moment
            self.assertFalse(timer.apply_timeout(self.ws, self.pid)["did_apply"])
            with self.assertRaises(ValueError):
                require_approval(self.ws)
        self.now = 1300
        self.assertEqual(timer.status(self.ws, self.pid)["state"], "expired")
        with self.assertRaises(ValueError):
            require_approval(self.ws)
        result = timer.apply_timeout(self.ws, self.pid)
        self.assertTrue(result["did_apply"])
        require_approval(self.ws)
        receipt = json.loads((self.ws / "04_outline/approval.json").read_text())
        self.assertIsNone(receipt["user_response"])
        self.assertEqual(receipt["decision_source"], "timeout_default")
        self.assertEqual(receipt["publication"]["citation_style"], "ieee")
        self.assertIn("IEEE", result["notice"])
        repeated = timer.apply_timeout(self.ws, self.pid)
        self.assertFalse(repeated["did_apply"])
        self.assertEqual(result["decision_id"], repeated["decision_id"])
        self.assertEqual(result["notice_id"], repeated["notice_id"])
        self.assertEqual(review_packet(self.ws)["confirmation"]["state"], "timeout_applied")

    def test_timeout_receipt_unlocks_actual_manuscript_preparation(self):
        self.start()
        with self.assertRaises(ValueError):
            prepare(self.ws)
        self.now = 1300
        timer.apply_timeout(self.ws, self.pid)
        result = prepare(self.ws)
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["model_calls"], 0)
        self.assertEqual(result["chapter_jobs"], 3)

    def test_pause_or_revision_reply_cancels_timer_without_approving(self):
        self.start()
        self.now = 1299.999
        timer.response(self.ws, {"packet_id": self.pid, "user_response": "稍等，我要修改大纲。"})
        self.now = 1400
        self.assertEqual(timer.apply_timeout(self.ws, self.pid)["state"], "responded")
        self.assertEqual(self.start()["state"], "responded")
        with self.assertRaises(ValueError):
            require_approval(self.ws)

    def test_reply_between_display_and_start_prevents_countdown(self):
        timer.response(self.ws, {"packet_id": self.pid, "user_response": "稍等。"})
        self.assertEqual(self.start()["state"], "responded")
        self.now = 1500
        self.assertEqual(timer.apply_timeout(self.ws, self.pid)["state"], "responded")
        with self.assertRaises(ValueError):
            require_approval(self.ws)

    def test_human_confirmation_can_change_choice_and_prevents_timeout(self):
        self.start()
        self.now = 1200
        approve(
            self.ws,
            {
                "packet_id": self.pid,
                "user_response": "Confirmed, use Markdown.",
                "publication": {"format": "markdown"},
            },
        )
        require_approval(self.ws)
        self.now = 1400
        self.assertEqual(timer.apply_timeout(self.ws, self.pid)["state"], "approved")
        self.assertEqual(read_request(self.ws)["publication"]["format"], "markdown")

    def test_changed_outline_invalidates_old_timer_and_new_packet_gets_new_window(self):
        self.start()
        self.now = 1400
        outline = copy.deepcopy(self.outline)
        outline["survey_title"] = "Revised scope"
        configure_outline(self.ws, outline)
        self.assertEqual(timer.apply_timeout(self.ws, self.pid)["state"], "stale")
        with self.assertRaises(ValueError):
            require_approval(self.ws)
        new = review_packet(self.ws)
        self.assertNotEqual(new["packet_id"], self.pid)
        state = timer.start(self.ws, {"packet_id": new["packet_id"], "displayed": True})
        self.assertEqual(state["deadline_at"], 1700)
        with self.assertRaisesRegex(ValueError, "superseded"):
            timer.apply_timeout(self.ws, self.pid)

    def test_timeout_record_does_not_authorize_required_mode_or_forged_receipt(self):
        self.start()
        self.now = 1400
        timer.apply_timeout(self.ws, self.pid)
        path = self.ws / "04_outline/review_wait.json"
        record = json.loads(path.read_text())
        record["decided_at"] = 1100
        atomic_json(path, record)
        with self.assertRaises(ValueError):
            require_approval(self.ws)
        configure(self.ws, {"outline_review": "required"})
        with self.assertRaises(ValueError):
            require_approval(self.ws)

    def test_invalid_publication_is_not_silently_replaced(self):
        self.start()
        self.now = 1400
        with patch(
            "publication.publication_options", return_value={**CHOICES, "formats": ["markdown"]}
        ):
            with self.assertRaisesRegex(ValueError, "not available"):
                timer.apply_timeout(self.ws, self.pid)
        self.assertEqual(read_request(self.ws)["publication"]["format"], "latex_pdf")
        with self.assertRaises(ValueError):
            require_approval(self.ws)

    def test_crash_after_configuration_recovers_same_decision(self):
        self.start()
        self.now = 1400
        original = timer.configure

        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("simulated interruption")

        with patch("review_timeout.configure", side_effect=crash):
            with self.assertRaises(RuntimeError):
                timer.apply_timeout(self.ws, self.pid)
        pending = json.loads((self.ws / "04_outline/review_wait.json").read_text())
        with self.assertRaises(ValueError):
            require_approval(self.ws)
        result = timer.apply_timeout(self.ws, self.pid)
        self.assertEqual(result["decision_id"], pending["decision_id"])
        require_approval(self.ws)

    def test_late_reply_is_followup_and_does_not_create_a_second_decision(self):
        self.start()
        self.now = 1400
        result = timer.apply_timeout(self.ws, self.pid)
        reply = timer.response(
            self.ws, {"packet_id": self.pid, "user_response": "请换成 Markdown。"}
        )
        self.assertEqual(reply["state"], "late_response")
        self.assertEqual(timer.status(self.ws, self.pid)["decision_id"], result["decision_id"])

    def test_rereading_packet_recovers_normalized_publication_after_crash(self):
        self.outline["outline_tree"][1]["language"] = "chinese"
        configure_outline(self.ws, self.outline)
        self.packet = review_packet(self.ws)
        self.pid = self.packet["packet_id"]
        self.start()
        self.now = 1400
        original = timer.configure

        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("simulated interruption")

        with patch("review_timeout.configure", side_effect=crash):
            with self.assertRaises(RuntimeError):
                timer.apply_timeout(self.ws, self.pid)
        pending = json.loads((self.ws / "04_outline/review_wait.json").read_text())
        resumed = review_packet(self.ws)
        self.assertEqual(resumed["packet_id"], self.pid)
        self.assertEqual(resumed["confirmation"]["state"], "expired")
        result = timer.apply_timeout(self.ws, self.pid)
        self.assertEqual(result["decision_id"], pending["decision_id"])
        self.assertEqual(result["publication"]["template"], "ctexart")
        require_approval(self.ws)

    def test_cli_status_and_wait_are_bounded_and_resume_saved_deadline(self):
        self.start()
        for command in ("review-status", "review-wait"):
            args = [
                sys.executable,
                str(ROOT / "scripts/slr.py"),
                "writing",
                command,
                "--workspace",
                str(self.ws),
                "--packet-id",
                self.pid,
            ]
            if command == "review-wait":
                args += ["--wait-seconds", "0"]
            result = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            value = json.loads(result.stdout)
            self.assertEqual(value["deadline_at"], 1300)
            self.assertEqual(value["state"], "expired")  # Separate process uses actual wall time.
        with self.assertRaisesRegex(ValueError, "0 to 30"):
            timer.wait(self.ws, self.pid, 31)
        with self.assertRaises(ValueError):
            require_approval(self.ws)

    def test_competing_writer_reports_retry_without_dropping_reply(self):
        self.start()
        request = json.dumps({"packet_id": self.pid, "user_response": "Please wait."})
        args = [
            sys.executable,
            str(ROOT / "scripts/slr.py"),
            "writing",
            "review-response",
            "--workspace",
            str(self.ws),
            "--request",
            "-",
        ]
        with timer.lock(self.ws):
            busy = subprocess.run(args, input=request, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(busy.returncode, 0)
        self.assertEqual(json.loads(busy.stdout)["code"], "STATE_BUSY")
        retried = subprocess.run(args, input=request, capture_output=True, text=True, timeout=10)
        self.assertEqual(retried.returncode, 0, retried.stdout + retried.stderr)
        self.assertEqual(json.loads(retried.stdout)["state"], "responded")
        with self.assertRaises(ValueError):
            require_approval(self.ws)

    def test_new_input_descriptions_are_read_only(self):
        before = {
            path.relative_to(self.ws): path.read_bytes()
            for path in self.ws.rglob("*")
            if path.is_file()
        }
        for action in (
            "review-complete",
            "review-start",
            "review-status",
            "review-wait",
            "review-response",
            "review-timeout",
        ):
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/slr.py"),
                    "writing",
                    action,
                    "--workspace",
                    str(self.ws),
                    "--describe-input",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)["read_only"])
        after = {
            path.relative_to(self.ws): path.read_bytes()
            for path in self.ws.rglob("*")
            if path.is_file()
        }
        self.assertEqual(before, after)

    def test_invalid_host_receipt_returns_actionable_cli_error(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/slr.py"), "writing", "review-complete",
             "--workspace", str(self.ws), "--request", "-"],
            input="{}", capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("unchanged bridge confirmation receipt", result.stdout)
        self.assertIsInstance(json.loads(result.stdout), dict)


if __name__ == "__main__":
    unittest.main()
