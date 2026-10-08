"""PDF parser subprocess contracts."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from apps.serve.tests import contract_citations as fixtures
from service.workbench.service import indexing
from service.workbench.service.indexing import PdfIndexService

PYTHONPATH_ENV = "PYTHONPATH"
PRIVATE_ENV = "SCHOLARSEED_TEST_PRIVATE"
PROCESS_TIMEOUT = 30


class PdfParserContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.source = fixtures.SourceFixture(Path(self.temp.name))
        self.document = self.source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        self.indexes = PdfIndexService(self.source)

    def tearDown(self) -> None:
        self.indexes.close()
        self.temp.cleanup()

    def test_parser_receives_product_pythonpath_without_private_environment(self) -> None:
        process = Mock(returncode=0)
        process.communicate.return_value = (None, b"")
        with (
            patch.dict(
                os.environ,
                {PYTHONPATH_ENV: "product-libraries", PRIVATE_ENV: "private"},
            ),
            patch.object(indexing.subprocess, "Popen", return_value=process) as launch,
        ):
            self.indexes._run_parser(b"", (), PROCESS_TIMEOUT)
        environment = launch.call_args.kwargs["env"]
        self.assertEqual(environment[PYTHONPATH_ENV], "product-libraries")
        self.assertNotIn(PRIVATE_ENV, environment)

    def test_parser_success_protocol_is_decoded(self) -> None:
        returncode, output = self.indexes._run_parser(self.document.payload, (), PROCESS_TIMEOUT)
        self.assertEqual(returncode, 0)
        result = self.indexes._parser_result(returncode, output)
        self.assertTrue(result["ok"])
        self.assertEqual(result["index"]["page_count"], 2)

    def test_empty_and_malformed_output_have_named_errors(self) -> None:
        cases = (
            (0, b"", indexing.PARSER_INVALID_OUTPUT),
            (0, b"not json", indexing.PARSER_INVALID_OUTPUT),
            (1, b"", indexing.PARSER_FAILED),
            (1, b"not json", indexing.PARSER_FAILED),
            (0, b'{"ok":true}', indexing.PARSER_INVALID_OUTPUT),
            (
                0,
                b'{"ok":false,"error":"pdf_parse_failed:ValueError"}',
                indexing.PARSER_INVALID_OUTPUT,
            ),
            (
                1,
                b'{"ok":false,"error":"pdf_parse_failed:ValueError"}',
                "pdf_parse_failed:ValueError",
            ),
        )
        for returncode, output, expected in cases:
            with self.subTest(returncode=returncode, output=output):
                with self.assertRaisesRegex(ValueError, f"^{expected}$"):
                    self.indexes._parser_result(returncode, output)

    def test_import_failure_logs_bounded_stderr(self) -> None:
        with (
            patch.object(indexing, "PARSER_MODULE", "scholarseed_missing_pdf_parser"),
            self.assertLogs(indexing.LOGGER, level="WARNING") as logs,
        ):
            returncode, output = self.indexes._run_parser(b"", (), PROCESS_TIMEOUT)
        self.assertNotEqual(returncode, 0)
        self.assertEqual(output, b"")
        self.assertIn("scholarseed_missing_pdf_parser", logs.records[0].parser_stderr)


if __name__ == "__main__":
    unittest.main()
