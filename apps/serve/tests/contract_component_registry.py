from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.ui import public_snapshot
from service.persistence.project import transaction


def snapshot(name="comparison", revision="one", slot="research.comparison"):
    return {
        "descriptor": {
            "id": name,
            "version": "1.0.0",
            "capabilities": ["interaction.answer"],
            "components": [{"id": "card", "slot": slot, "entry": "card.js", "actions": []}],
        },
        "fingerprint": revision,
        "files": {"card.js": "Y29kZQ=="},
        "scenarios": {},
    }


class ComponentRegistryContract(unittest.TestCase):
    def test_reads_observe_committed_state_while_an_independent_writer_is_active(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        pending = snapshot("pending", "two", "research.pending")
        reopened = ComponentRegistry(self.path)
        with transaction(self.path, immediate=True) as writer:
            self.registry._retain(writer, pending)
            writer.execute(
                "INSERT INTO component_slots(slot,plugin,component,fingerprint) VALUES(?,?,?,?)",
                ("research.pending", "pending", "card", "two"),
            )
            for registry in (self.registry, reopened):
                self.assertTrue(registry.has_claim("comparison"))
                self.assertFalse(registry.has_claim("pending"))
                self.assertIsNone(registry.active_ui())
                self.assertEqual(len(registry.enabled_snapshots()), 1)
                self.assertEqual(registry.answer_markdown("session", "turn"), ())
                self.assertEqual(registry.snapshot(reference, user_id="user")["fingerprint"], "one")
                registry.validate(reference, session_id="session", user_id="user")
                self.assertIsNone(
                    registry.copy_content(reference, session_id="session", user_id="user")[
                        "content"
                    ]
                )
            self.assertTrue(self.registry.preflight(["research.pending"])["slots"][0]["available"])
            self.assertNotIn(
                "pending", {row["plugin"] for row in self.registry.catalog(user_id="user")}
            )
            self.assertTrue(writer.in_transaction)
        self.assertTrue(self.registry.has_claim("pending"))
        self.assertTrue(reopened.has_claim("pending"))

    def test_first_read_prepares_a_missing_registry_and_preserves_legacy_bindings(self):
        self.assertFalse(self.registry.has_claim("comparison"))
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        self.registry.bind_data(reference, {"preserved": "legacy"})
        with transaction(self.path, immediate=True) as connection:
            connection.execute("ALTER TABLE component_bindings DROP COLUMN content_revision")
        reopened = ComponentRegistry(self.path)
        self.assertTrue(reopened.has_claim("comparison"))
        restored = reopened.snapshot(reference, user_id="user")["interaction"]
        self.assertEqual(restored["data"], {"preserved": "legacy"})
        self.assertEqual(restored["content_revision"], 0)

    def test_large_copy_content_is_preserved_without_byte_truncation(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        content = {"text": "x" * 300000, "markdown": "y" * 300000}
        self.registry.copy_content(
            reference, session_id="session", user_id="user", expected_revision=0, content=content
        )
        self.assertEqual(self.registry.answer_markdown("session", "turn"), (content["markdown"],))

    def test_answer_markdown_is_session_turn_and_revision_bound(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        self.registry.copy_content(
            reference,
            session_id="session",
            user_id="user",
            expected_revision=0,
            content={"text": "table", "markdown": "| value | [1](https://example.org) |"},
        )
        self.assertEqual(
            self.registry.answer_markdown("session", "turn"),
            ("| value | [1](https://example.org) |",),
        )
        self.assertEqual(self.registry.answer_markdown("other", "turn"), ())
        self.assertEqual(self.registry.answer_markdown("session", "other"), ())
        self.registry.draft(
            reference,
            session_id="session",
            user_id="user",
            values={"changed": True},
            expected_revision=0,
        )
        self.assertEqual(self.registry.answer_markdown("session", "turn"), ())

    def test_new_display_contract_coexists_with_the_previous_immutable_host_revision(self):
        old = public_snapshot("conversation.ui")
        old["fingerprint"] = "host-v2"
        old["descriptor"]["version"] = "host-v2"
        old["descriptor"]["components"] = [
            item for item in old["descriptor"]["components"] if item["slot"] != "literature.outline"
        ]
        next(item for item in old["descriptor"]["components"] if item["slot"] == "conversation.ui")[
            "actions"
        ] = [{"id": "choose", "capability": "interaction.answer"}]
        with patch("service.capabilities.service.components.public_snapshot", return_value=old):
            previous = self.registry.resolve(
                "conversation.ui", session_id="session", turn_id="old", user_id="user"
            )
        self.registry.bind_data(previous, {"retained": "old content"})
        current = self.registry.resolve(
            "conversation.ui", session_id="session", turn_id="new", user_id="user"
        )
        self.assertNotEqual(current["fingerprint"], previous["fingerprint"])
        self.assertEqual(
            self.registry.snapshot(previous, user_id="user")["interaction"]["data"],
            {"retained": "old content"},
        )
        descriptor = self.registry.snapshot(current, user_id="user")["descriptor"]
        self.assertEqual(
            next(item for item in descriptor["components"] if item["slot"] == "conversation.ui")[
                "actions"
            ],
            [],
        )

    def test_declarative_public_surface_needs_no_executable_resource(self):
        reference = self.registry.resolve(
            "conversation.ui", session_id="session", turn_id="turn", user_id="user"
        )
        self.assertIsNotNone(reference)
        mounted = self.registry.snapshot(reference, user_id="user")
        self.assertNotIn("ui", mounted)
        self.assertEqual(mounted["files"], {})
        self.assertTrue(
            all("entry" not in component for component in mounted["descriptor"]["components"])
        )

    def test_document_updates_preserve_draft_and_require_separate_ordered_revision(self):
        reference = self.registry.resolve(
            "conversation.ui", session_id="session", turn_id="turn", user_id="user"
        )
        first = {
            "format": "openui-lang",
            "version": 1,
            "source": 'root = Conversation([TextContent("one")])',
        }
        second = {**first, "source": 'root = Conversation([TextContent("two")])'}
        publish = lambda data, revision: self.registry.publish_document(
            reference, session_id="session", user_id="user", data=data, content_revision=revision
        )
        publish(first, 0)
        self.registry.draft(
            reference,
            session_id="session",
            user_id="user",
            values={"name": "draft"},
            expected_revision=0,
        )
        publish(second, 1)
        publish(second, 1)
        restored = self.registry.snapshot(reference, user_id="user")["interaction"]
        self.assertEqual(restored["data"], second)
        self.assertEqual(restored["state"], {"name": "draft"})
        self.assertEqual((restored["revision"], restored["content_revision"]), (1, 1))
        for data, revision in [(first, 1), (first, 0), (second, 3)]:
            with self.assertRaisesRegex(ValueError, "component_content_changed"):
                publish(data, revision)
        self.registry.finish(reference)
        with self.assertRaisesRegex(ValueError, "component_interaction_finished"):
            publish(first, 2)

    def test_preflight_observes_occupied_and_reserved_slots_without_granting_access(self):
        self.registry.publish([snapshot()])
        self.registry.authorize = lambda _plugin, _user: False
        result = self.registry.preflight(
            ["research.comparison", "interaction.question", "example.fresh", "example.fresh"]
        )
        self.assertEqual(
            result["slots"],
            [
                {"slot": "research.comparison", "available": False, "reason": "occupied"},
                {"slot": "interaction.question", "available": False, "reason": "reserved"},
                {"slot": "example.fresh", "available": True, "reason": None},
            ],
        )
        self.assertFalse(result["authorized"])
        self.assertFalse(result["reserved"])
        self.assertTrue(self.registry.has_claim("comparison"))
        with self.assertRaisesRegex(ValueError, "component_registry_unavailable"):
            ComponentRegistry(self.path).preflight(["example.fresh"])
        self.registry.invalidate()
        with self.assertRaisesRegex(ValueError, "component_registry_updating"):
            self.registry.preflight(["example.fresh"])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "components.sqlite3"
        self.registry = ComponentRegistry(self.path)

    def test_enabled_slot_resolves_without_skill_selection(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        self.assertEqual(reference["plugin"], "comparison")
        self.assertEqual(self.registry.snapshot(reference, user_id="user")["fingerprint"], "one")

    def test_conflict_leaves_previous_registry_unchanged(self):
        self.registry.publish([snapshot()])
        with self.assertRaisesRegex(ValueError, "component_slot_conflict"):
            self.registry.publish([snapshot(), snapshot("other")])
        self.assertEqual(self.registry.catalog(user_id="user")[0]["plugin"], "comparison")

    def test_public_slots_cannot_be_claimed_by_packages(self):
        with self.assertRaisesRegex(ValueError, "component_slot_reserved"):
            self.registry.publish([snapshot(slot="interaction.question")])

    def test_disable_keeps_bound_code_data_and_draft(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        self.registry.bind_data(reference, {"papers": ["one", "two"]})
        self.registry.draft(
            reference,
            session_id="session",
            user_id="user",
            values={"selected": ["two"]},
            expected_revision=0,
        )
        self.registry.publish([])
        self.assertIsNone(
            self.registry.resolve(
                "research.comparison", session_id="session", turn_id="next", user_id="user"
            )
        )
        self.registry.validate(reference, session_id="session", user_id="user")
        reopened = ComponentRegistry(self.path).snapshot(reference, user_id="user")
        self.assertEqual(reopened["interaction"]["state"], {"selected": ["two"]})
        self.assertEqual(reopened["interaction"]["data"], {"papers": ["one", "two"]})

    def test_update_pins_previous_revision_and_binds_new_requests_to_new_code(self):
        self.registry.publish([snapshot()])
        previous = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        self.registry.publish([snapshot(revision="two")])
        current = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="next", user_id="user"
        )
        self.assertEqual(self.registry.snapshot(previous, user_id="user")["fingerprint"], "one")
        self.assertEqual(self.registry.snapshot(current, user_id="user")["fingerprint"], "two")

    def test_binding_cannot_be_forged_or_cross_session(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        for changed in ({**reference, "fingerprint": "two"}, {**reference, "component": "other"}):
            with self.assertRaises(ValueError):
                self.registry.validate(changed, session_id="session", user_id="user")
        with self.assertRaises(ValueError):
            self.registry.validate(reference, session_id="other", user_id="user")
        with self.assertRaises(ValueError):
            self.registry.snapshot(reference, user_id="other")

    def test_draft_compare_and_swap_and_completed_actions_rejected(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        self.registry.draft(
            reference,
            session_id="session",
            user_id="user",
            values={"selection": "one"},
            expected_revision=0,
        )
        with self.assertRaisesRegex(ValueError, "component_state_changed"):
            self.registry.draft(
                reference, session_id="session", user_id="user", values={}, expected_revision=0
            )
        self.registry.finish(reference)
        with self.assertRaisesRegex(ValueError, "component_interaction_finished"):
            self.registry.validate(reference, session_id="session", user_id="user")

    def test_reopened_registry_cannot_bind_until_enablement_is_reconciled(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        reopened = ComponentRegistry(self.path)
        self.assertEqual(reopened.snapshot(reference, user_id="user")["fingerprint"], "one")
        with self.assertRaisesRegex(ValueError, "component_registry_unavailable"):
            reopened.resolve(
                "research.comparison", session_id="session", turn_id="next", user_id="user"
            )
        reopened.publish([])
        self.assertIsNone(
            reopened.resolve(
                "research.comparison", session_id="session", turn_id="next", user_id="user"
            )
        )

    def test_revoked_permission_rejects_old_snapshot_draft_and_rebind(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison",
            session_id="session",
            turn_id="turn",
            user_id="user",
            interaction_id="question",
        )
        self.registry.publish([])
        self.registry.authorize = lambda _plugin, _user: False
        with self.assertRaisesRegex(ValueError, "component_permission_denied"):
            self.registry.snapshot(reference, user_id="user")
        with self.assertRaisesRegex(ValueError, "component_permission_denied"):
            self.registry.draft(
                reference, session_id="session", user_id="user", values={}, expected_revision=0
            )
        with self.assertRaisesRegex(ValueError, "component_permission_denied"):
            self.registry.resolve(
                "research.comparison",
                session_id="session",
                turn_id="turn",
                user_id="user",
                interaction_id="question",
            )

    def test_public_binding_data_and_draft_survive_reopen(self):
        reference = self.registry.resolve(
            "interaction.question",
            session_id="session",
            turn_id="turn",
            user_id="user",
            interaction_id="question",
        )
        self.registry.bind_data(reference, {"options": ["continue", "stop"]})
        self.registry.draft(
            reference,
            session_id="session",
            user_id="user",
            values={"answers": ["continue"]},
            expected_revision=0,
        )
        self.registry.publish([])
        reopened = ComponentRegistry(self.path)
        self.assertEqual(
            reopened.resolve(
                "interaction.question",
                session_id="session",
                turn_id="turn",
                user_id="user",
                interaction_id="question",
            ),
            reference,
        )
        self.assertEqual(
            reopened.snapshot(reference, user_id="user")["interaction"]["state"],
            {"answers": ["continue"]},
        )

    def test_data_write_rejects_forged_reference(self):
        self.registry.publish([snapshot()])
        reference = self.registry.resolve(
            "research.comparison", session_id="session", turn_id="turn", user_id="user"
        )
        with self.assertRaisesRegex(ValueError, "component_data_changed"):
            self.registry.bind_data({**reference, "component": "other"}, {})


if __name__ == "__main__":
    unittest.main()
