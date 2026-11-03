"""Actual JSON owners on private startup projections, not update acceptance."""

from __future__ import annotations

import base64
import json
import tempfile
import unittest
from contextlib import nullcontext
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from service.bootstrap import startup_document_sources
from service.chat.persistence.projects import ProjectRegistry
from service.chat.service.settings import SettingsService
from service.identity.persistence.store import decode_auth_data
from service.persistence.documents import DocumentSource, check_documents, preview_documents
from service.settings.config import decode_config_object, decode_config_seed
from service.settings.connections import ModelProfileStore


class DocumentPreviewContracts(unittest.TestCase):
    def test_deferred_directory_batch_preserves_project_document_until_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            removed = root / "removed"
            raw = json.dumps(
                {"projects": [{"path": str(removed), "name": "Kept until commit"}]}
            ).encode()
            creation = SimpleNamespace(directory_identity=None)
            snapshot = SimpleNamespace(
                config_data=b"{}",
                config_seed=None,
                settings_data=None,
                projects_data=raw,
                profiles_data=None,
                auth_data=None,
                legacy_seeds=(),
                catalog=SimpleNamespace(
                    projects=(("old", removed),),
                    has_project_removals=True,
                    project_creation_plans=(creation,),
                ),
            )
            with patch(
                "service.bootstrap.startup_removal_plans",
                side_effect=AssertionError("removal ran before deferred creation"),
            ):
                sources = startup_document_sources(snapshot)
            projected = next(row for row in preview_documents(sources) if row.name == "projects")
            self.assertEqual(base64.b64decode(projected.payload), raw)
            self.assertEqual(snapshot.projects_data, raw)
            # A recorded directory identity keeps the existing precommit path;
            # it must still require qualified removal rules and project bytes.
            creation.directory_identity = "recorded-native-directory"
            with self.assertRaises(ValueError):
                startup_document_sources(snapshot)
            with patch(
                "service.bootstrap.startup_removal_plans",
                return_value=nullcontext((SimpleNamespace(root=removed),)),
            ):
                sources = startup_document_sources(snapshot, domains=object())
            projected = next(row for row in preview_documents(sources) if row.name == "projects")
            self.assertEqual(
                base64.b64decode(projected.payload),
                ProjectRegistry.preview_removals(raw, (removed,)),
            )

    def test_project_removal_projection_matches_live_bytes_and_preserves_unrelated_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / "project"
            registry = ProjectRegistry(root / "projects.json")
            value = {
                "custom": "kept",
                "projects": [
                    {"path": str(target), "name": "项目", "added_at": 123},
                    {"path": str(root / "other"), "name": "Other", "custom": True},
                ],
            }
            raw = json.dumps(value, ensure_ascii=False).encode()
            registry.path.write_bytes(raw)
            projected = registry.preview_removals(raw, (target,))
            self.assertEqual(registry.path.read_bytes(), raw)
            self.assertTrue(registry.remove(target))
            self.assertEqual(registry.path.read_bytes(), projected)
            self.assertEqual(
                registry.decode(projected), {"custom": "kept", "projects": [value["projects"][1]]}
            )
            self.assertEqual(registry.preview_removals(projected, (target,)), projected)
            self.assertIsNone(registry.preview_removals(None, (target,)))

    def sources(self):
        settings = b'{"custom":"private-value"}'
        return (
            DocumentSource(
                "config",
                b'{"model_name":"private-model"}',
                b'{"model_name":"private-model"}',
                decode_config_object,
            ),
            DocumentSource(
                "settings",
                settings,
                SettingsService.preview_initialization(settings, existing_projects=True),
                SettingsService.decode,
            ),
            DocumentSource("profiles", None, None, ModelProfileStore.decode),
            DocumentSource(
                "auth", b'{"users":[],"tokens":[]}', b'{"users":[],"tokens":[]}', decode_auth_data
            ),
            DocumentSource(
                "projects", b'{"projects":[]}', b'{"projects":[]}', ProjectRegistry.decode
            ),
        )

    def test_owner_readers_accept_actual_projections_without_exposing_repr(self):
        sources = self.sources()
        previews = preview_documents(sources)
        checks = check_documents([asdict(row) for row in previews], sources)
        self.assertEqual([row.name for row in checks], [row.name for row in previews])
        self.assertNotIn("private-model", repr(sources) + repr(previews) + repr(checks))
        self.assertNotIn("private-value", repr(sources) + repr(previews) + repr(checks))
        self.assertNotIn(previews[0].payload, repr(previews))

    def test_settings_preview_matches_actual_publication_bytes(self):
        with tempfile.TemporaryDirectory() as area:
            target = Path(area) / "settings.json"
            for existing in (False, True):
                target.unlink(missing_ok=True)
                expected = SettingsService.preview_initialization(None, existing_projects=existing)
                with patch("service.chat.service.settings.SERVE_SETTINGS_FILE", target):
                    SettingsService().initialize(existing_projects=existing)
                self.assertEqual(target.read_bytes(), expected)
                self.assertEqual(
                    SettingsService.preview_initialization(expected, existing_projects=existing),
                    expected,
                )

    def test_config_seed_projection_is_sanitized_before_old_reader(self):
        seed = decode_config_seed(
            b'{"model_name":"model","api_key":"private-key"}', source=Path("packaged.json")
        )
        source = DocumentSource("config", None, seed.payload, decode_config_object)
        preview = preview_documents((source,))[0]
        self.assertNotIn(b"private-key", base64.b64decode(preview.payload))
        check_documents([asdict(preview)], (source,))

    def test_source_bytes_presence_and_coverage_cannot_be_substituted(self):
        sources = self.sources()
        entries = [asdict(row) for row in preview_documents(sources)]
        changed_sources = (
            replace(sources[0], observed=b'{ "model_name": "private-model" }'),
            *sources[1:],
        )
        with self.assertRaisesRegex(ValueError, "source changed"):
            check_documents(entries, changed_sources)
        invalid = [dict(row) for row in entries]
        invalid[2]["source_present"] = True
        for value in (
            entries[:-1],
            [entries[0], *entries[:-1]],
            invalid,
            [{**entries[0], "path": "/untrusted"}, *entries[1:]],
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                check_documents(value, sources)

    def test_source_owner_rejects_candidate_document_it_cannot_read(self):
        sources = self.sources()
        entries = [asdict(row) for row in preview_documents(sources)]
        for index in range(len(sources)):
            invalid = [dict(row) for row in entries]
            invalid[index]["payload"] = base64.b64encode(b"[]").decode("ascii")
            with self.subTest(owner=sources[index].name), self.assertRaises(ValueError):
                check_documents(invalid, sources)

    def test_payload_encoding_and_size_are_bounded(self):
        sources = self.sources()
        entries = [asdict(row) for row in preview_documents(sources)]
        for payload in ("not-base64", "e30=\n", 0, {}, "雪"):
            invalid = [dict(row) for row in entries]
            invalid[0]["payload"] = payload
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                check_documents(invalid, sources)
        with patch("service.persistence.documents.MAX_DOCUMENT_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "budget"):
                preview_documents(sources)


if __name__ == "__main__":
    unittest.main()
