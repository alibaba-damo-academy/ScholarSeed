from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / ".agents/skills/fe-work-summary/scripts/meeting_doc_writeback.py"
)
SPEC = importlib.util.spec_from_file_location("meeting_summary", SCRIPT)
SUMMARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUMMARY)


class SummarySafetyTests(unittest.TestCase):
    def test_block_positions_are_not_content(self):
        client = mock.Mock()
        client.read_blocks.return_value = {
            "success": True,
            "blocks": [{"element": {"id": "protected", "index": 3, "paragraph": {"text": "keep"}}}],
        }
        before = SUMMARY._blocks(client, "url")
        client.read_blocks.return_value["blocks"][0]["element"]["index"] = 9
        self.assertEqual(before, SUMMARY._blocks(client, "url"))
        client.read_blocks.return_value["blocks"][0]["element"]["paragraph"] = {"text": "changed"}
        self.assertNotEqual(before, SUMMARY._blocks(client, "url"))

    def test_missing_body_does_not_load_external_client(self):
        with mock.patch.object(
            SUMMARY, "_import_kb", side_effect=AssertionError("external import")
        ):
            with self.assertRaises(SystemExit):
                SUMMARY.main(["--section", "weekly", "--member", "成员"])

    def test_render_preview_does_not_load_external_client(self):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "body.md"
            body.write_text("结果", encoding="utf-8")
            with mock.patch.object(
                SUMMARY, "_import_kb", side_effect=AssertionError("external import")
            ):
                self.assertEqual(
                    SUMMARY.main(["--section", "weekly", "--body-file", str(body), "--dry-run"]), 0
                )

    def test_creation_preview_does_not_load_external_client(self):
        with mock.patch.object(
            SUMMARY, "_import_kb", side_effect=AssertionError("external import")
        ):
            self.assertEqual(SUMMARY.main(["--new-weekly", "--dry-run"]), 0)

    def test_daily_replace_is_rejected_before_client_load(self):
        with mock.patch.object(
            SUMMARY, "_import_kb", side_effect=AssertionError("external import")
        ):
            with self.assertRaises(SystemExit):
                SUMMARY.write_daily("url", "成员", "周二", "内容")

    def test_member_prefix_does_not_select_another_member(self):
        client = mock.Mock()
        client.read_blocks.return_value = {
            "blocks": [
                {
                    "id": "section",
                    "blockType": "heading",
                    "heading": {"text": "成员周报", "level": 2},
                },
                {"id": "other", "blockType": "heading", "heading": {"text": "成员甲", "level": 3}},
            ]
        }
        self.assertEqual(SUMMARY.find_weekly_subsection(client, "url", "成员"), (None, []))

    def test_failed_mutation_is_not_retried(self):
        client = mock.Mock()
        client.write_once.side_effect = TimeoutError("unknown outcome")
        client.read_blocks.return_value = {"blocks": []}
        with mock.patch.object(
            SUMMARY, "find_weekly_subsection", return_value=("heading", ["old"])
        ):
            with self.assertRaises(SystemExit):
                SUMMARY.write_weekly("url", "成员", "内容", client)
        self.assertEqual(client.write_once.call_count, 1)
        client._try_all_servers.assert_not_called()

    def test_legacy_client_is_rejected_before_any_side_effect(self):
        client = mock.Mock(spec=["delete_block", "create_doc", "_try_all_servers", "read_blocks"])
        with self.assertRaises(SystemExit):
            SUMMARY.write_weekly("url", "成员", "内容", client)
        with self.assertRaises(SystemExit):
            SUMMARY.find_or_create_weekly(client, "folder")
        client.delete_block.assert_not_called()
        client.create_doc.assert_not_called()
        client._try_all_servers.assert_not_called()
        client.read_blocks.assert_not_called()

    def test_duplicate_member_headings_are_rejected(self):
        client = mock.Mock()
        client.read_blocks.return_value = {
            "blocks": [
                {
                    "id": "section",
                    "blockType": "heading",
                    "heading": {"text": "成员周报", "level": 2},
                },
                {"id": "first", "blockType": "heading", "heading": {"text": "成员", "level": 3}},
                {"id": "second", "blockType": "heading", "heading": {"text": "成员：", "level": 3}},
            ]
        }
        with self.assertRaises(SystemExit):
            SUMMARY.find_weekly_subsection(client, "url", "成员")

    def test_empty_body_rejected_before_client_load(self):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "body.md"
            body.write_text("\n", encoding="utf-8")
            with mock.patch.object(
                SUMMARY, "_import_kb", side_effect=AssertionError("external import")
            ):
                with self.assertRaises(SystemExit):
                    SUMMARY.main(["--section", "weekly", "--body-file", str(body)])

    def test_conflicting_git_identity_is_rejected(self):
        with mock.patch.object(
            SUMMARY.subprocess,
            "run",
            side_effect=[mock.Mock(stdout="name"), mock.Mock(stdout="email")],
        ):
            with self.assertRaises(SystemExit):
                SUMMARY.resolve_member(None, {"name": "成员甲", "email": "成员乙"})

    def test_changed_document_is_not_mutated(self):
        client = mock.Mock()
        with mock.patch.object(SUMMARY, "_blocks", side_effect=[[], [{"id": "new"}]]):
            with mock.patch.object(
                SUMMARY, "find_weekly_subsection", return_value=("heading", ["old"])
            ):
                with self.assertRaises(SystemExit):
                    SUMMARY.write_weekly("url", "成员", "内容", client)
        client.delete_block.assert_not_called()
        client.write_once.assert_not_called()
        client._try_all_servers.assert_not_called()

    def test_equal_count_wrong_or_unverifiable_text_is_not_success(self):
        heading = {"id": "heading", "blockType": "heading", "heading": {"text": "成员"}}
        for texts in (
            ["第一条", "第二条"],
            ["第二条", "第一条"],
            ["错误", "第二条"],
            [None, "第二条"],
        ):
            with self.subTest(texts=texts):
                client = mock.Mock()
                after = [heading] + [
                    {"id": f"new-{index}", "blockType": "paragraph", "paragraph": {"text": text}}
                    for index, text in enumerate(texts)
                ]
                with mock.patch.object(
                    SUMMARY, "_blocks", side_effect=[[heading], [heading], after]
                ):
                    with mock.patch.object(
                        SUMMARY,
                        "find_weekly_subsection",
                        side_effect=[("heading", []), ("heading", ["new-0", "new-1"])],
                    ):
                        with mock.patch.object(SUMMARY.time, "sleep"):
                            if texts == ["第一条", "第二条"]:
                                SUMMARY.write_weekly("url", "成员", "第一条\n第二条", client)
                            else:
                                with self.assertRaises(SystemExit):
                                    SUMMARY.write_weekly("url", "成员", "第一条\n第二条", client)


if __name__ == "__main__":
    unittest.main()
