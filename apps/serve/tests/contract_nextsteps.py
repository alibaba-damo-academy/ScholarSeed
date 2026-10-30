"""Next-turn suggestions are display data, never pending HIL requests."""

import unittest

from service.assistant.service.nextsteps import validate_next_steps_card


class NextStepsContracts(unittest.TestCase):
    def payload(self):
        return {
            "title": "接下来你希望做什么？",
            "options": [
                {"label": "Deep · 文献支撑", "description": "检索相关工作。"},
                {"label": "Validation · 验证方案", "description": "设计验证方案。"},
            ],
            "free_text_label": "其他需求",
            "submit_label": "发送",
        }

    def test_preserves_context_language_without_executable_actions(self):
        payload = self.payload()
        self.assertEqual(validate_next_steps_card(payload), payload)

    def test_rejects_empty_choices_and_hidden_action_fields(self):
        for change in ({"options": []}, {"action": "execute"}, {"title": " "}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_next_steps_card({**self.payload(), **change})
        payload = self.payload()
        payload["options"][0]["command"] = "hidden command"
        with self.assertRaises(ValueError):
            validate_next_steps_card(payload)

    def test_rejects_duplicate_options_and_oversized_text(self):
        payload = self.payload()
        payload["options"][1] = payload["options"][0]
        with self.assertRaises(ValueError):
            validate_next_steps_card(payload)
        with self.assertRaises(ValueError):
            validate_next_steps_card({**self.payload(), "title": "x" * 10000})
