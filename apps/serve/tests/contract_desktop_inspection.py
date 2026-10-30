"""Private Desktop reader transport contracts, not signed Electron acceptance."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from service.cli.desktop_history import HISTORY_NAME, split_history_candidates
from service.cli.desktop_inspection import (
    OWNERS,
    check_report,
    decode_documents,
    desktop_document_sources,
    inspect_desktop_records,
)
from service.persistence.documents import check_documents, preview_documents
from service.persistence.preview import DatabasePreview, decode_previews


class DesktopInspectionContracts(unittest.TestCase):
    def test_history_partition_keeps_core_wire_types_for_source_decoder(self):
        core = DatabasePreview(
            "sessions", True, "a" * 64, ("sessions",), (), "b" * 64, ("sessions",)
        )
        history = DatabasePreview(
            HISTORY_NAME, False, "c" * 64, (HISTORY_NAME,), (), "d" * 64, (HISTORY_NAME,)
        )
        wire = json.loads(json.dumps([asdict(core), asdict(history)]))
        original = json.dumps(wire, sort_keys=True)
        selected, remaining = split_history_candidates(wire)
        self.assertEqual(selected, (history,))
        self.assertEqual(decode_previews(remaining), (core,))
        self.assertEqual(json.dumps(wire, sort_keys=True), original)
        with self.assertRaises(ValueError):
            split_history_candidates(wire[:1])
        with self.assertRaises(ValueError):
            split_history_candidates([*wire, wire[1]])

    def documents(self) -> list[dict[str, str | None]]:
        return [
            {"owner": owner, "bytes": base64.b64encode(b"{}").decode("ascii")}
            for owner in sorted(OWNERS)
        ]

    def report(self, documents):
        return {
            "version": 1,
            "records": [
                {
                    "owner": owner,
                    "present": data is not None,
                    "sourceDigest": hashlib.sha256(b"absent" if data is None else data).hexdigest(),
                    "projectionDigest": "a" * 64,
                }
                for owner, data in decode_documents(documents)
            ],
        }

    def test_complete_byte_bound_report_and_absence(self):
        documents = self.documents()
        documents[0]["bytes"] = None
        report = self.report(documents)
        raw = (json.dumps(report) + "\n").encode()
        self.assertEqual(check_report(raw, decode_documents(documents)), report)
        for field, value in (
            ("present", 1),
            ("sourceDigest", "b" * 64),
            ("projectionDigest", "future"),
            ("owner", "unknown"),
        ):
            changed = json.loads(raw)
            changed["records"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                check_report((json.dumps(changed) + "\n").encode(), decode_documents(documents))
        with self.assertRaises(ValueError):
            check_report(raw.rstrip(), decode_documents(documents))

    def test_unknown_duplicate_and_incomplete_inputs_are_rejected(self):
        for value in (None, [], self.documents()[:-1], self.documents() + self.documents()[:1]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                decode_documents(value)
        for mutation in (
            {"owner": "future"},
            {"bytes": "@@@"},
            {"bytes": "e30"},
            {"path": "/private"},
        ):
            documents = self.documents()
            documents[0].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                decode_documents(documents)
        duplicate = self.documents()
        duplicate[1] = duplicate[0]
        with self.assertRaises(ValueError):
            decode_documents(duplicate)

    def test_desktop_projection_reuses_document_preimage_and_source_reader_checks(self):
        documents = self.documents()
        marker = b'{"schema":1,"appVersion":"0.2.0-202610080900"}\n'
        report = {
            **self.report(documents),
            "preparedMarker": base64.b64encode(marker).decode("ascii"),
        }
        with patch(
            "service.cli.desktop_inspection.inspect_desktop_records", return_value=report
        ) as reader:
            _, sources = desktop_document_sources(documents)
            previews = preview_documents(sources)
            self.assertEqual(reader.call_count, 1)
            candidate = [asdict(item) for item in previews]
            proposed_marker = b'{"schema":1,"appVersion":"0.2.1-202610091215"}\n'
            next(row for row in candidate if row["name"] == "desktop.startup-marker")["payload"] = (
                base64.b64encode(proposed_marker).decode("ascii")
            )
            checks = check_documents(candidate, sources)
            self.assertEqual(len(checks), len(OWNERS))
            self.assertEqual(reader.call_count, 2)
            delivered = reader.call_args.args[0]
            self.assertEqual(
                base64.b64decode(
                    next(row for row in delivered if row["owner"] == "startup-marker")["bytes"]
                ),
                proposed_marker,
            )
            # The source read is cached only for these exact bytes.
            check_documents(candidate, sources)
            self.assertEqual(reader.call_count, 2)
            candidate[0]["source_digest"] = "0" * 64
            with self.assertRaises(ValueError):
                check_documents(candidate, sources)

    def test_projection_report_requires_a_bounded_canonical_marker(self):
        documents = self.documents()
        report = self.report(documents)
        for payload in (None, "@@@", "", "e30", "A" * (128 * 1024 + 1)):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                check_report(
                    (json.dumps({**report, "preparedMarker": payload}) + "\n").encode(),
                    decode_documents(documents),
                    project=True,
                )

    def invoke(self, script, **changes):
        # Python is a real subprocess fixture for the transport only. It neither
        # stands in for the packaged Electron codecs nor proves native Job drain.
        with tempfile.TemporaryDirectory() as directory:
            entry = Path(directory) / "reader.py"
            entry.write_text(script)
            with patch.dict(
                os.environ,
                {
                    "SCHOLARSEED_DESKTOP_INSPECTION_EXECUTABLE": sys.executable,
                    "SCHOLARSEED_DESKTOP_INSPECTION_SCRIPT": str(entry),
                    "NODE_OPTIONS": "--require=untrusted",
                    "NODE_COMPILE_CACHE": str(Path(directory) / "unwanted-cache"),
                    **changes,
                },
            ):
                result = inspect_desktop_records(self.documents())
            self.assertFalse((Path(directory) / "unwanted-cache").exists())
            return result

    def test_child_receives_only_the_frozen_reader_environment_and_exact_bytes(self):
        script = """
import base64, hashlib, json, os, sys
assert os.environ['ELECTRON_RUN_AS_NODE'] == '1'
assert 'NODE_OPTIONS' not in os.environ and 'NODE_COMPILE_CACHE' not in os.environ
request = json.load(sys.stdin)
rows = []
for row in request['documents']:
    data = base64.b64decode(row['bytes'])
    rows.append(dict(owner=row['owner'], present=True, sourceDigest=hashlib.sha256(data).hexdigest(), projectionDigest='a'*64))
print(json.dumps(dict(version=1, records=rows)))
"""
        self.assertEqual(self.invoke(script), self.report(self.documents()))

    def test_failed_or_oversized_child_does_not_return_partial_evidence(self):
        for script in (
            "import sys; sys.stderr.write('private-secret'); sys.exit(2)",
            "print('x' * 20000)",
        ):
            with self.subTest(script=script), self.assertRaises((ValueError, OSError)) as failure:
                self.invoke(script)
            self.assertNotIn("private-secret", str(failure.exception))

    def test_timeout_kills_and_joins_the_direct_reader(self):
        with patch("service.cli.desktop_inspection.INSPECTION_SECONDS", 0.1):
            with self.assertRaises(TimeoutError):
                self.invoke("import time; time.sleep(60)")


if __name__ == "__main__":
    unittest.main()
