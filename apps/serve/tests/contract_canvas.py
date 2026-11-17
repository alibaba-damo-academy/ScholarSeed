from __future__ import annotations

import unittest

from pydantic import ValidationError

from service.capabilities.service.canvas import CanvasDocument, validate_canvas_submission
from service.capabilities.service.descriptor import ComponentValidationError
from service.capabilities.service.ui import public_snapshot


class CanvasContract(unittest.TestCase):
    def test_display_and_interactive_contracts_are_distinct(self):
        display = {"format": "openui-lang", "version": 1, "source": "root = Stack([])"}
        self.assertIsNone(CanvasDocument.model_validate(display).interaction)
        for actions in ([], ["rollback"], ["submit", "submit"]):
            with self.subTest(actions=actions), self.assertRaises(ValidationError):
                CanvasDocument.model_validate({**display, "interaction": {"actions": actions}})

    def test_submission_uses_the_immutable_canvas_output_contract(self):
        document = {
            "format": "html",
            "version": 1,
            "source": "<main>Canvas</main>",
            "interaction": {
                "actions": ["rollback", "cancel", "submit"],
                "output_schema": {
                    "type": "object",
                    "properties": {"threshold": {"type": "number"}},
                    "required": ["threshold"],
                    "additionalProperties": False,
                },
            },
        }
        validate_canvas_submission(document, "submit", {"threshold": 0.8})
        validate_canvas_submission(document, "cancel", {})
        with self.assertRaises(ComponentValidationError):
            validate_canvas_submission(document, "submit", {"threshold": "old value"})
        with self.assertRaisesRegex(ValueError, "canvas_action_unavailable"):
            validate_canvas_submission(document, "rollback", {})

    def test_canvas_has_its_own_host_revision_and_answer_actions(self):
        snapshot = public_snapshot("canvas.ui")
        self.assertNotEqual(
            snapshot["fingerprint"], public_snapshot("conversation.ui")["fingerprint"]
        )
        component = next(
            item for item in snapshot["descriptor"]["components"] if item["slot"] == "canvas.ui"
        )
        self.assertEqual([action["id"] for action in component["actions"]], ["submit", "cancel"])


if __name__ == "__main__":
    unittest.main()
