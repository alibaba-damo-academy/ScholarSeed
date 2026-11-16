"""Machine extraction/cache/import boundaries; deterministic responses, not E2E."""

import json
import sqlite3
import tempfile
import unittest
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from unittest.mock import AsyncMock

from apps.serve.tests.contract_comprehension import (
    CLASSIFICATION,
    EXTRACTION,
    block_record,
    document,
    record,
)
from service.literature.persistence.analysis import AnalysisStore
from service.literature.persistence.assets import MaterialAssets
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.atomic import material_asset, parse_source
from service.literature.service.comprehension import (
    VALIDATION_ATTEMPTS,
    ComprehensionError,
    ReadingClient,
    prepare_reading,
    project_saved,
    saved_source,
)
from service.literature.service.interpretation import compile_reading
from service.workbench.service.extraction import extract


class MaterialContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.database = Path(self.folder.name) / "literature.sqlite3"
        self.repository = LiteratureRepository(self.database)
        self.payload = document()
        index = extract(self.payload)
        self.source = prepare_reading(
            index,
            doc_id="task-paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )

    async def generate(self):
        invoke = AsyncMock(
            side_effect=[record("classify", CLASSIFICATION), block_record("extract", EXTRACTION)]
        )
        asset = await material_asset(
            self.source,
            ReadingClient(self.source, invoke),
            database=self.database,
            paper={"title": "Paper", "doi": "10.1000/paper"},
            pdf_payload=self.payload,
        )
        return asset, invoke

    async def test_machine_asset_is_reused_without_reading_generation_or_library_insert(self):
        source_file = Path(self.folder.name) / "source.pdf"
        output_dir = Path(self.folder.name) / "not-created"
        source_file.write_bytes(self.payload)
        parsed = parse_source(source_file, output_dir)
        self.assertEqual(parsed["source_sha256"], sha256(self.payload).hexdigest())
        self.assertEqual(parsed["status"], "ok")
        self.assertTrue(parsed["sentences"].strip())
        self.assertEqual(source_file.read_bytes(), self.payload)
        self.assertFalse(output_dir.exists())
        missing = Path(self.folder.name) / "missing.pdf"
        with self.assertRaises(FileNotFoundError):
            parse_source(missing)
        with self.assertRaisesRegex(ValueError, "Original PDF required"):
            parse_source(missing, materialized_text=True)
        asset, invoke = await self.generate()
        self.assertEqual(invoke.await_count, 2)
        self.assertNotIn("modules", asset)
        self.assertIn("card_mapping", asset["source_mapping"])
        self.assertEqual(self.repository.view("").items, ())
        second = AsyncMock(side_effect=AssertionError("valid asset must not be re-extracted"))
        reused = await material_asset(
            self.source, ReadingClient(self.source, second), database=self.database
        )
        self.assertEqual(reused, asset)
        second.assert_not_called()

    async def test_same_asset_supports_framework_reading_projection_without_reextracting(self):
        asset, _ = await self.generate()
        reading = saved_source(asset, "en", 120000)
        plan = compile_reading(asset, reading)
        self.assertIsNotNone(plan)
        projected = project_saved(asset)
        self.assertIn("summary", projected["modules"])
        self.assertEqual(projected["l1"], asset["l1"])
        self.assertEqual(projected["source_mapping"], asset["source_mapping"])

    async def test_explicit_import_can_reuse_source_and_l1_without_overwriting_metadata(self):
        asset, _ = await self.generate()
        store = MaterialAssets(self.database)
        self.assertEqual(store.source_for({"title": "Paper", "doi": "10.1000/paper"}), self.payload)
        self.assertIsNone(store.source_for({"title": "Other", "doi": "10.1000/paper"}))
        self.assertIsNone(store.source_for({"title": "Paper"}))
        linked = AnalysisStore(self.database).reading_l1(
            "explicit-import", asset["revision"], "attachment"
        )
        self.assertIsNone(linked)
        self.assertEqual(self.repository.view("").items, ())

    async def test_failed_extraction_does_not_write_an_asset_or_damage_a_valid_version(self):
        asset, _ = await self.generate()
        store = MaterialAssets(self.database)
        with self.assertRaisesRegex(ValueError, "not_ready"):
            store.save({**asset, "l1": {"extraction_quality": {"status": "DEGRADED"}}})
        self.assertEqual(store.get(asset["revision"]), asset)
        invalid = deepcopy(EXTRACTION)
        invalid["card"]["experiments"]["results"] = [
            {"metric": "accuracy", "value": "12%", "conditions": "fixture", "source_ids": [999]}
        ]
        invoke = AsyncMock(
            side_effect=[record("classify", CLASSIFICATION)]
            + [block_record("extract", invalid), record("repair", invalid)]
        )
        source = replace(self.source, language="zh")
        with self.assertRaises(ComprehensionError) as failure:
            await material_asset(source, ReadingClient(source, invoke), database=self.database)
        self.assertEqual(invoke.await_count, 1 + VALIDATION_ATTEMPTS)
        self.assertIsNone(store.get(asset["revision"], "zh"))
        self.assertEqual(store.get(asset["revision"]), asset)
        self.assertIn("source_map", failure.exception.detail)
        with sqlite3.connect(self.database) as connection:
            rows = connection.execute("SELECT payload FROM literature_material_failures").fetchall()
        self.assertEqual(len(rows), 1)
        diagnostic = json.loads(rows[0][0])
        self.assertEqual(diagnostic["l1"]["extraction_quality"]["status"], "DEGRADED")
        self.assertEqual(len(diagnostic["l1"]["extraction_diagnostics"]), 2)
        self.assertEqual(diagnostic["source_snapshot"], json.loads(json.dumps(source.snapshot)))

    async def test_failed_mixed_recovery_keeps_saved_success_and_partial_diagnostic(self):
        saved, _ = await self.generate()
        store = MaterialAssets(self.database)
        initial = block_record("extract", EXTRACTION)
        initial = replace(
            initial,
            output_text=initial.output_text.replace(
                "<common_fields>{", "<common_fields>{broken,", 1
            ),
        )
        invoke = AsyncMock(
            side_effect=[
                initial,
                record("syntax", {}),
                record("content", {"fields": {}, "source_map": {}}),
            ]
        )
        source = replace(self.source, language="zh")
        with self.assertRaises(ComprehensionError) as failure:
            await material_asset(
                source, ReadingClient(source, invoke), database=self.database, paper_type="method"
            )
        self.assertEqual(invoke.await_count, 3)
        self.assertEqual(store.get(saved["revision"], "en"), saved)
        self.assertIsNone(store.get(saved["revision"], "zh"))
        self.assertEqual(failure.exception.diagnostics["l1"]["card"], EXTRACTION["card"])
        self.assertEqual(
            failure.exception.diagnostics["source_mapping"]["card_mapping"][
                "card.method.description"
            ],
            [1],
        )
        with sqlite3.connect(self.database) as connection:
            rows = connection.execute("SELECT payload FROM literature_material_failures").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0][0])["l1"]["extraction_quality"]["status"], "DEGRADED")

    async def test_compatible_saved_assets_survive_extractor_upgrade(self):
        from service.literature.service.comprehension import COMPATIBLE_EXTRACTOR_VERSIONS

        for version in COMPATIBLE_EXTRACTOR_VERSIONS[1:]:
            database = Path(self.folder.name) / f"legacy-{version}.sqlite3"
            asset, _ = await self.generate()
            asset["metadata"]["extractor_version"] = version
            MaterialAssets(database).save(asset)
            invoke = AsyncMock(side_effect=AssertionError("compatible L1 must not regenerate"))
            reused = await material_asset(
                self.source,
                ReadingClient(self.source, invoke),
                database=database,
                paper_type="method",
            )
            self.assertEqual(reused, asset)
            invoke.assert_not_called()

    async def test_missing_common_recovery_preserves_existing_card_and_mapping(self):
        initial = deepcopy(EXTRACTION)
        common = initial.pop("common_fields")
        # Only keep mappings whose target survived the omitted common block.
        initial["source_map"] = {"card.method.description": [1]}
        repaired = {
            "fields": {"common_fields": common},
            "source_map": {
                "common_fields.claims[0].claim": [1],
                "common_fields.limitations[0]": [1],
            },
        }
        invoke = AsyncMock(
            side_effect=[
                record(
                    "extract",
                    "<card>"
                    + json.dumps(initial["card"])
                    + "</card><source_map>"
                    + json.dumps(initial["source_map"])
                    + "</source_map>",
                ),
                record("repair", repaired),
            ]
        )
        asset = await material_asset(
            self.source,
            ReadingClient(self.source, invoke),
            database=self.database,
            paper_type="method",
        )
        self.assertEqual(invoke.await_count, 2)
        self.assertEqual(asset["l1"]["card"], initial["card"])
        self.assertEqual(asset["l1"]["common_fields"], common)
        self.assertEqual(asset["source_mapping"]["card_mapping"]["card.method.description"], [1])
        self.assertEqual(asset["l1"]["extraction_quality"]["status"], "READY")
        self.assertIn("Repair only", invoke.call_args.args[0].input_text)


if __name__ == "__main__":
    unittest.main()
