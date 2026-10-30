import os
import sys
from pathlib import Path
import unittest
from unittest.mock import mock_open, patch


TOOLS = Path(__file__).resolve().parents[1]
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import localconf  # noqa: E402
import paperhub  # noqa: E402
import web_fallback  # noqa: E402


class ProductEndpointTests(unittest.TestCase):
    def test_scholarseed_api_key_is_the_only_supported_credential_name(self):
        with patch.dict(
            os.environ,
            {"SCHOLARSEED_API_KEY": "current", "SHUSHEN_API_KEY": "legacy"},
            clear=True,
        ):
            self.assertEqual(paperhub._api_key(), "current")
        with patch.dict(os.environ, {"SHUSHEN_API_KEY": "legacy"}, clear=True):
            self.assertEqual(paperhub._api_key(), "")

    def test_scholarseed_base_expands_to_papersearch(self):
        self.assertEqual(
            paperhub._papersearch_url("https://scholarseed.damo.alibaba.com/paperhub"),
            "https://scholarseed.damo.alibaba.com/paperhub/papersearch/",
        )
        self.assertEqual(
            paperhub._papersearch_url(""),
            "https://scholarseed.damo.alibaba.com/paperhub/papersearch/",
        )

    def test_scholarseed_http_is_upgraded_but_custom_http_is_preserved(self):
        self.assertEqual(
            paperhub._papersearch_url("http://scholarseed.damo.alibaba.com/paperhub"),
            "https://scholarseed.damo.alibaba.com/paperhub/papersearch/",
        )
        self.assertEqual(
            paperhub._papersearch_url("http://localhost:18000"),
            "http://localhost:18000/papersearch/",
        )

    def test_custom_endpoint_is_preserved_and_environment_wins(self):
        configured = "http://localhost:18000"
        override = "http://localhost:18001"
        for environment, expected in (
            ({}, configured),
            ({"PAPERHUB_URL": override}, override),
        ):
            with (
                self.subTest(environment=environment),
                patch.dict(os.environ, environment, clear=True),
                patch.object(localconf, "_applied", False),
                patch(
                    "builtins.open",
                    mock_open(read_data='{"paperhub_url":"' + configured + '"}'),
                ),
            ):
                localconf.apply()
                self.assertEqual(os.environ["PAPERHUB_URL"], expected)

    def test_default_paperhub_route_preserves_proxy(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(
            localconf, "config_source", return_value=localconf._BUNDLED_CFG_PATH
        ), patch.object(localconf, "_applied", False):
            localconf.apply()
            self.assertNotIn("scholarseed.damo.alibaba.com", os.environ.get("no_proxy", ""))
            self.assertNotIn("scholarseed.damo.alibaba.com", os.environ.get("NO_PROXY", ""))

    def test_web_fallback_provenance_names_the_skill(self):
        paper, warning = web_fallback._normalize_paper(
            {"title": "Example", "url": "https://example.test/paper"}
        )
        self.assertIsNone(warning)
        self.assertEqual(paper["found_by"], ["web_search_skill"])

    def test_web_search_native_contract_matches_v1(self):
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("<scholarseed_web_search_results>", skill)
        self.assertIn("</scholarseed_web_search_results>", skill)
        self.assertIn("`schema` = `scholarseed.web_search.v1`", skill)
        for relative in ("SKILL.md", "README.md", "references/balanced-quality-workflow.md"):
            self.assertNotIn("shushen.web_search", (ROOT / relative).read_text(encoding="utf-8"))
        producer = ROOT.parent / "web-search" / "scripts"
        for name in ("official.py", "browser.py"):
            self.assertIn('SCHEMA = "scholarseed.web_search.v1"', (producer / name).read_text())
        self.assertIn("`provider` = `codex-native`", skill)
        self.assertNotIn("WEB_SEARCH_RESULT_BEGIN", skill)
        self.assertNotIn("`provider` = `native`", skill)

    def test_all_workflows_name_the_same_provider_route(self):
        expected = "`official-api` → `codex-native`"
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        balanced = (
            ROOT / "references" / "balanced-quality-workflow.md"
        ).read_text(encoding="utf-8")
        self.assertIn(expected, skill)
        self.assertIn(expected, balanced)
        self.assertNotIn("visible-browser", skill)
        self.assertNotIn("visible-browser", balanced)


if __name__ == "__main__":
    unittest.main()
