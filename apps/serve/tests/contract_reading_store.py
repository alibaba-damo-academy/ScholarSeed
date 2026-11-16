"""L1 persistence and eligibility contracts; no model or product startup."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from service.literature.domain.cards import ReadingState, reading_result, reading_state
from service.literature.persistence.analysis import SEGMENT_TABLE, TABLE, AnalysisStore
from service.literature.persistence.store import connect


def asset(version: str = "0.2.5") -> dict:
    return {
        "literature_id": "paper",
        "attachment_id": "attachment",
        "revision": "bytes-v1",
        "kind": "interpretation",
        "modules": {"summary": {"text": "Saved interpretation"}},
        "l1": {"paper_type": "method", "reading_depth": "full", "card": {"result": "value"}},
        "metadata": {
            "schema_version": "l1-reading/v2",
            "extractor_version": version,
            "prompt_version": "l1/v2.4",
            "coverage": {"complete": False},
        },
        "source_mapping": {"card_mapping": {"card.result": [1]}},
        "source_snapshot": {
            "source_revision": "sha256:bytes-v1",
            "fragments": {"1": {"text": "Original evidence", "quads": [[0.1, 0.2, 0.3, 0.4]]}},
        },
    }


class ReadingStoreContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="reading-store-")
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "literature.sqlite3"
        self.store = AnalysisStore(self.database)

    def test_checkpoint_reopens_with_complete_evidence_and_attachment_revision_scope(self):
        saved = asset()
        self.store.save_l1("paper", "sha256:bytes-v1", "attachment", saved, "extraction")
        reopened = AnalysisStore(self.database)
        self.assertEqual(reopened.reading_l1("paper", "bytes-v1", "attachment"), saved)
        for paper, revision, attachment in (
            ("other", "bytes-v1", "attachment"),
            ("paper", "bytes-v2", "attachment"),
            ("paper", "bytes-v1", "other"),
        ):
            self.assertIsNone(reopened.reading_l1(paper, revision, attachment))
        self.assertIsNone(reopened.summary("paper", "bytes-v1"))

    def test_summary_precedence_and_failed_writer_do_not_remove_checkpoint(self):
        saved = asset()
        self.store.save_l1("paper", "bytes-v1", "attachment", saved, "extraction")
        # A legacy text-only summary must not hide a usable extraction checkpoint.
        legacy = {k: saved[k] for k in ("literature_id", "revision", "kind", "modules")}
        self.store.publish(legacy, "legacy")
        self.assertEqual(self.store.reading_l1("paper", "bytes-v1", "attachment"), saved)
        self.store.publish(saved, "writer")
        result = self.store.reading_l1("paper", "bytes-v1", "attachment")
        self.assertEqual(result["source_snapshot"], saved["source_snapshot"])
        self.assertEqual(result["content"], saved["modules"]["summary"])

    def test_metadata_is_a_light_projection_for_both_checkpoint_and_summary(self):
        saved = asset()
        self.store.save_l1("paper", "bytes-v1", "attachment", saved, "extraction")
        for summary in (False, True):
            if summary:
                self.store.publish(saved, "writer")
            metadata = self.store.reading_metadata("paper", "sha256:bytes-v1", "attachment")
            self.assertEqual(reading_state(metadata, "bytes-v1"), ReadingState.READY)
            self.assertNotIn("Original evidence", json.dumps(metadata))
            self.assertNotIn("source_mapping", metadata)
            self.assertNotIn("card", metadata["l1"])

    def test_old_depth_projection_never_rewrites_checkpoint_or_saved_summary(self):
        saved = asset("0.2.4")
        saved["l1"]["reading_depth"] = "partial"
        self.store.save_l1("paper", "bytes-v1", "attachment", saved, "extraction")
        self.assertEqual(
            self.store.reading_l1("paper", "bytes-v1", "attachment")["l1"]["reading_depth"], "full"
        )
        self.store.publish(saved, "writer")
        self.assertEqual(
            self.store.read("paper", "bytes-v1")["summary"]["l1"]["reading_depth"], "full"
        )
        with closing(connect(self.database)) as connection:
            for table in (TABLE, SEGMENT_TABLE):
                raw = json.loads(connection.execute(f"SELECT result FROM {table}").fetchone()[0])
                self.assertEqual(raw["l1"]["reading_depth"], "partial")
                self.assertEqual(raw["source_snapshot"], saved["source_snapshot"])
        self.assertEqual(saved["l1"]["reading_depth"], "partial")
        for version in ("0.2.3", "0.2.5", "future"):
            other = asset(version)
            other["l1"]["reading_depth"] = "partial"
            self.assertIs(reading_result(other), other)

    def test_existing_extra_columns_and_unrelated_records_survive_writes(self):
        with closing(connect(self.database)) as connection, connection:
            for table in (TABLE, SEGMENT_TABLE):
                connection.execute(f"ALTER TABLE {table} ADD COLUMN retained TEXT DEFAULT 'keep'")
        saved = asset()
        self.store.publish_segment(
            "paper",
            "bytes-v1",
            "translation-v1",
            "model",
            "page",
            {"text": "translation"},
            "translation",
        )
        self.store.save_l1("paper", "bytes-v1", "attachment", saved, "extract")
        self.store.publish(saved, "writer")
        reopened = AnalysisStore(self.database)
        reopened.save_l1("paper", "bytes-v1", "attachment", saved, "extract-again")
        reopened.publish(saved, "writer-again")
        self.assertEqual(
            reopened.read_segment("paper", "bytes-v1", "translation-v1", "model", "page"),
            {"text": "translation"},
        )
        with closing(connect(self.database)) as connection:
            for table in (TABLE, SEGMENT_TABLE):
                self.assertTrue(
                    all(
                        row[0] == "keep"
                        for row in connection.execute(f"SELECT retained FROM {table}")
                    )
                )

    def test_eligibility_fails_closed_without_claiming_complete_quality(self):
        saved = asset()
        original = copy.deepcopy(saved)
        self.assertEqual(reading_state(None, "bytes-v1"), ReadingState.MISSING)
        for malformed in ({}, [], {"l1": []}):
            self.assertEqual(reading_state(malformed, "bytes-v1"), ReadingState.INCOMPATIBLE)
        self.assertEqual(reading_state(saved, "sha256:bytes-v1"), ReadingState.READY)
        self.assertEqual(reading_state(saved, "bytes-v2"), ReadingState.STALE)
        self.assertEqual(reading_state(saved, ""), ReadingState.STALE)
        for key in ("revision", "source_revision"):
            stale = copy.deepcopy(saved)
            (stale if key == "revision" else stale["source_snapshot"])[key] = "other"
            self.assertEqual(reading_state(stale, "bytes-v1"), ReadingState.STALE)
        invalid = copy.deepcopy(saved)
        invalid["metadata"]["schema_version"] = "future"
        self.assertEqual(reading_state(invalid, "bytes-v1"), ReadingState.INCOMPATIBLE)
        self.assertEqual(saved, original)


if __name__ == "__main__":
    unittest.main()
