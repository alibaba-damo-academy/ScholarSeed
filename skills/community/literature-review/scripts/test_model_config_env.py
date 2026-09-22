#!/usr/bin/env scholarseed-skill-python
"""Regression checks for the ScholarSeed model environment contract."""
from __future__ import annotations

import os
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

import load_model_config  # noqa: E402


FIXTURE = {
    "providers": {
        "qwen": {
            "backend": "openai",
            "base_url": "https://config-text.invalid/v1",
            "api_key": "legacy-config-token",
        },
        "idealab": {
            "backend": "openai_image",
            "base_url": "https://config-image.invalid/v1",
            "api_key": "legacy-image-token",
        },
    },
    "stages": {
        "processing": {"provider": "qwen", "model": "text-model"},
        "figures_image": {"provider": "idealab", "model": "image-model"},
    },
}


class ModelEnvironmentContractTest(unittest.TestCase):
    def _load(self, stage: str, env: dict[str, str]) -> dict:
        with patch.object(load_model_config, "_load_raw", return_value=FIXTURE), \
             patch.dict(os.environ, env, clear=True):
            result = load_model_config.load_stage_config(stage)
        self.assertIsNotNone(result)
        return result or {}

    def test_environment_urls_override_provider_defaults(self) -> None:
        env = {
            "SCHOLARSEED_ACCOUNT_TOKEN": "text-token",
            "IMAGE_API_KEY": "image-token",
            "TEXT_BASE_URL": "https://env-text.invalid/v1",
            "IMAGE_BASE_URL": "https://env-image.invalid/v1",
        }
        text = self._load("processing", env)
        image = self._load("figures_image", env)
        self.assertEqual(text["base_url"], env["TEXT_BASE_URL"])
        self.assertEqual(image["base_url"], env["IMAGE_BASE_URL"])
        self.assertEqual(text["api_key"], "text-token")
        self.assertEqual(image["api_key"], "image-token")

    def test_config_urls_are_fallbacks_but_config_tokens_are_ignored(self) -> None:
        text = self._load("processing", {"SCHOLARSEED_ACCOUNT_TOKEN": "runtime-token"})
        image = self._load("figures_image", {"IMAGE_API_KEY": "runtime-image-token"})
        self.assertEqual(text["base_url"], "https://config-text.invalid/v1")
        self.assertEqual(image["base_url"], "https://config-image.invalid/v1")
        self.assertEqual(text["api_key"], "runtime-token")
        self.assertEqual(image["api_key"], "runtime-image-token")

    def test_image_falls_back_to_text_but_text_never_uses_image_key(self) -> None:
        image = self._load("figures_image", {"SCHOLARSEED_ACCOUNT_TOKEN": "text-only"})
        text = self._load("processing", {"IMAGE_API_KEY": "image-only"})
        self.assertEqual(image["api_key"], "text-only")
        self.assertEqual(text["api_key"], "")

    def test_empty_image_key_falls_back_to_text_key(self) -> None:
        image = self._load("figures_image", {
            "IMAGE_API_KEY": "  ",
            "SCHOLARSEED_ACCOUNT_TOKEN": "text-fallback",
        })
        self.assertEqual(image["api_key"], "text-fallback")

    def test_image_key_remains_stable_when_text_key_changes(self) -> None:
        first = self._load("figures_image", {"IMAGE_API_KEY": "original-image-key", "SCHOLARSEED_ACCOUNT_TOKEN": "old-text-key"})
        second = self._load("figures_image", {"IMAGE_API_KEY": "original-image-key", "SCHOLARSEED_ACCOUNT_TOKEN": "new-text-key"})
        self.assertEqual(first["api_key"], "original-image-key")
        self.assertEqual(second["api_key"], first["api_key"])

    def test_missing_token_does_not_resurrect_legacy_config_key(self) -> None:
        text = self._load("processing", {})
        image = self._load("figures_image", {})
        self.assertEqual(text["api_key"], "")
        self.assertEqual(image["api_key"], "")


if __name__ == "__main__":
    unittest.main()
