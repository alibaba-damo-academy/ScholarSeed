"""PDF parser subprocess contracts."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from dataclasses import asdict, replace
from io import BytesIO, TextIOWrapper
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import reportlab
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from apps.serve.tests import contract_citations as fixtures
from apps.serve.tests import pdf as pdf_fixture
from service.platform.activity import Activities
from service.workbench.service import extraction, indexing, parser
from service.workbench.service.indexing import PdfIndexService

PYTHONPATH_ENV = "PYTHONPATH"
PRIVATE_ENV = "SCHOLARSEED_TEST_PRIVATE"
PROCESS_TIMEOUT = 30
TEST_ENCODING = "utf-8"
LEGACY_ENCODINGS = ("gbk", "cp1252", "ascii")
UNICODE_TEXT = "中文研究结果：é ﬁ ∑."
PDF_UNICODE_TEXT = "Résumé: ﬁ ∑. The measured concentration is 37.25 mg/L."
UNPAIRED_SURROGATE = "\ud800"
TEST_FONT_NAME = "PdfParserUnicode"
TEST_FONT_PATH = ("fonts", "Vera.ttf")
STDOUT_ENCODING_ENV = "PYTHONIOENCODING"
UTF8_MODE_ENV = "PYTHONUTF8"
PARSER_ERROR = "pdf_parse_failed:ValueError"


def unicode_pdf() -> bytes:
    pdfmetrics.registerFont(
        TTFont(TEST_FONT_NAME, str(Path(reportlab.__file__).parent.joinpath(*TEST_FONT_PATH)))
    )
    output = BytesIO()
    canvas = Canvas(output)
    canvas.setFont(TEST_FONT_NAME, pdf_fixture.DEFAULT_FONT_SIZE)
    canvas.drawString(100, 700, PDF_UNICODE_TEXT)
    canvas.save()
    return output.getvalue()


class PdfParserContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.source = fixtures.SourceFixture(Path(self.temp.name))
        self.document = self.source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        self.indexes = PdfIndexService(self.source, activities=Activities())

    def tearDown(self) -> None:
        self.indexes.close()
        self.temp.cleanup()

    def test_parser_receives_product_pythonpath_without_private_environment(self) -> None:
        process = MagicMock(spec=indexing.subprocess.Popen, returncode=0)
        process.poll.return_value = 0
        process.communicate.return_value = (None, b"")
        with (
            patch.dict(
                os.environ,
                {PYTHONPATH_ENV: "product-libraries", PRIVATE_ENV: "private"},
            ),
            patch.object(indexing.subprocess, "Popen", return_value=process) as launch,
        ):
            self.indexes._run_parser(b"", (), PROCESS_TIMEOUT)
        self.assertIn("-B", launch.call_args.args[0])
        environment = launch.call_args.kwargs["env"]
        self.assertEqual(environment[PYTHONPATH_ENV], "product-libraries")
        self.assertNotIn(PRIVATE_ENV, environment)
        process.__enter__.assert_called_once_with()
        process.__exit__.assert_called_once_with(None, None, None)
        process.kill.assert_not_called()

    def test_parser_success_protocol_is_decoded(self) -> None:
        returncode, output = self.indexes._run_parser(self.document.payload, (), PROCESS_TIMEOUT)
        self.assertEqual(returncode, 0)
        result = self.indexes._parser_result(returncode, output)
        self.assertTrue(result["ok"])
        self.assertEqual(result["index"]["page_count"], 2)

    def test_main_writes_unicode_success_as_utf8_under_legacy_stdout(self) -> None:
        index = extraction.extract(self.document.payload)
        index = replace(index, fragments=(replace(index.fragments[0], text=UNICODE_TEXT),))
        for encoding in LEGACY_ENCODINGS:
            with self.subTest(encoding=encoding):
                output = BytesIO()
                with (
                    TextIOWrapper(output, encoding=encoding) as stdout,
                    patch.object(parser.sys, "stdout", stdout),
                    patch.object(parser.sys, "stdin", Mock(buffer=BytesIO(b""))),
                    patch.object(parser.sys, "argv", [indexing.PARSER_MODULE]),
                    patch.object(parser, "extract", return_value=index),
                ):
                    returncode = parser.main()
                    stdout.flush()
                    result = json.loads(output.getvalue().decode(TEST_ENCODING))
                    self.assertEqual(returncode, 0)
                    self.assertEqual(result["index"], json.loads(json.dumps(asdict(index))))

    def test_main_writes_failure_protocol_under_legacy_stdout(self) -> None:
        for encoding in LEGACY_ENCODINGS:
            with self.subTest(encoding=encoding):
                output = BytesIO()
                with (
                    TextIOWrapper(output, encoding=encoding) as stdout,
                    patch.object(parser.sys, "stdout", stdout),
                    patch.object(parser.sys, "stdin", Mock(buffer=BytesIO(b""))),
                    patch.object(parser.sys, "argv", [indexing.PARSER_MODULE]),
                    patch.object(parser, "extract", side_effect=ValueError("invalid PDF")),
                ):
                    returncode = parser.main()
                    stdout.flush()
                    self.assertEqual(returncode, 1)
                    self.assertEqual(
                        json.loads(output.getvalue().decode(TEST_ENCODING)),
                        {"ok": False, "error": PARSER_ERROR},
                    )

    def test_main_serialization_failure_emits_no_partial_index(self) -> None:
        index = extraction.extract(self.document.payload)
        index = replace(index, fragments=(replace(index.fragments[0], text=UNPAIRED_SURROGATE),))
        output = BytesIO()
        with (
            TextIOWrapper(output, encoding=TEST_ENCODING) as stdout,
            patch.object(parser.sys, "stdout", stdout),
            patch.object(parser.sys, "stdin", Mock(buffer=BytesIO(b""))),
            patch.object(parser.sys, "argv", [indexing.PARSER_MODULE]),
            patch.object(parser, "extract", return_value=index),
        ):
            returncode = parser.main()
            stdout.flush()
            self.assertEqual(returncode, 1)
            self.assertEqual(
                json.loads(output.getvalue().decode(TEST_ENCODING)),
                {"ok": False, "error": "pdf_parse_failed:UnicodeEncodeError"},
            )

    def test_real_parser_preserves_unicode_with_legacy_stream_encodings(self) -> None:
        payload = unicode_pdf()
        expected = extraction.extract(payload)
        self.assertIn(PDF_UNICODE_TEXT, " ".join(fragment.text for fragment in expected.fragments))
        for encoding in LEGACY_ENCODINGS:
            with (
                self.subTest(encoding=encoding),
                patch.dict(os.environ, {STDOUT_ENCODING_ENV: encoding, UTF8_MODE_ENV: "0"}),
                patch.object(
                    indexing,
                    "PARSER_ENV_KEYS",
                    (*indexing.PARSER_ENV_KEYS, STDOUT_ENCODING_ENV, UTF8_MODE_ENV),
                ),
            ):
                returncode, output = self.indexes._run_parser(payload, (), PROCESS_TIMEOUT)
                self.assertEqual(returncode, 0)
                result = self.indexes._parser_result(returncode, output)
                self.assertEqual(result["index"], json.loads(json.dumps(asdict(expected))))

    def test_parser_rejects_non_utf8_protocol_with_visible_diagnostics(self) -> None:
        payload = {"ok": True, "index": {"text": UNICODE_TEXT}}
        for encoding in ("utf-16", "gbk"):
            output = json.dumps(payload, ensure_ascii=False).encode(encoding, errors="replace")
            with self.subTest(encoding=encoding), self.assertLogs(indexing.LOGGER) as logs:
                with self.assertRaisesRegex(ValueError, indexing.PARSER_INVALID_OUTPUT):
                    self.indexes._parser_result(0, output)
                self.assertIn(indexing.PARSER_INVALID_OUTPUT, logs.output[0])
                self.assertIn("UnicodeDecodeError", logs.output[0])
                self.assertNotIn(UNICODE_TEXT, logs.output[0])

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
        self.assertIn("scholarseed_missing_pdf_parser", logs.output[0])
        self.assertIn(str(returncode), logs.output[0])

    def test_parser_error_code_is_visible_in_formatted_logs(self) -> None:
        output = json.dumps({"ok": False, "error": PARSER_ERROR}).encode(TEST_ENCODING)
        with self.assertLogs(indexing.LOGGER) as logs:
            with self.assertRaisesRegex(ValueError, PARSER_ERROR):
                self.indexes._parser_result(1, output)
        self.assertIn(PARSER_ERROR, logs.output[0])

    def test_failed_index_requires_explicit_retry_and_then_recovers(self) -> None:
        output = json.dumps({"ok": False, "error": PARSER_ERROR}).encode(TEST_ENCODING)
        with patch.object(self.indexes, "_run_parser", return_value=(1, output)) as parser:
            self.assertIsNone(self.indexes.index(self.document, wait=True))
            status = self.indexes.status(self.document)
            self.assertEqual(status["state"], indexing.FAILED)
            self.assertEqual(status["error"], PARSER_ERROR)
            self.assertEqual(self.indexes.prepare(self.document)["state"], indexing.FAILED)
            self.assertEqual(parser.call_count, 1)
        self.indexes.prepare(self.document, retry=True)
        self.assertIsNotNone(self.indexes.index(self.document, wait=True))
        status = self.indexes.status(self.document)
        self.assertEqual(status["state"], indexing.READY)
        self.assertEqual(status["error"], "")


if __name__ == "__main__":
    unittest.main()
