"""Native PDF worker contracts; fixtures do not replace Desktop acceptance."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from unittest.mock import Mock, patch

from reportlab.pdfgen.canvas import Canvas

from service.platform.pdf import (
    PdfDocumentError,
    PdfNativeOperation,
    _native_pdf,
    pdf_document_info,
    pdf_document_text,
    pdf_image_bounds,
    render_pdf_page,
)
from service.workbench.service.extraction import extract


class PdfWorkerContracts(unittest.TestCase):
    def setUp(self):
        output = BytesIO()
        document = Canvas(output, pagesize=(200, 300))
        for text in ("First page", "Second page", "Third page"):
            document.drawString(20, 200, text)
            document.showPage()
        document.save()
        self.payload = output.getvalue()

    def test_parent_import_does_not_load_pdfium(self):
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; import service.platform.pdf; "
                "import service.workbench.service.indexing; "
                "assert 'pypdfium2' not in sys.modules",
            ],
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_worker_does_not_import_workbench(self):
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; import service.platform.pdfium; "
                "assert not any(name.startswith('service.workbench') for name in sys.modules)",
            ],
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_concurrent_entrypoints_return_detached_values(self):
        operations = (
            lambda: pdf_document_info(self.payload).page_count,
            lambda: pdf_document_text(self.payload, (3, 1)),
            lambda: pdf_image_bounds(self.payload, (2,)),
            lambda: render_pdf_page(self.payload, 2, scale=1),
        )
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda operation: operation(), operations))
        self.assertEqual(results[0], 3)
        self.assertEqual(tuple(text.strip() for text in results[1]), ("Third page", "First page"))
        self.assertEqual(results[2], ((),))
        with results[3] as image:
            self.assertEqual(image.size, (200, 300))
            self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))

    def test_invalid_page_is_structured_failure_without_retry(self):
        original = subprocess.Popen
        with patch("service.platform.pdf.subprocess.Popen", wraps=original) as spawn:
            with self.assertRaisesRegex(PdfDocumentError, "pdf_page_invalid"):
                pdf_document_text(self.payload, (4,))
        self.assertEqual(spawn.call_count, 1)
        self.assertIn("-B", spawn.call_args.args[0])

    def test_timeout_kills_and_reaps_actual_process(self):
        original = subprocess.Popen
        processes = []

        def spawn(_command, **kwargs):
            process = original([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
            processes.append(process)
            return process

        with (
            patch("service.platform.pdf.subprocess.Popen", side_effect=spawn),
            patch("service.platform.pdf.PDF_WORKER_TIMEOUT_SECONDS", 0.1),
        ):
            with self.assertRaisesRegex(PdfDocumentError, "pdf_worker_timeout"):
                _native_pdf(b"input", PdfNativeOperation.INFO)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdin.closed)

    def test_native_crashes_have_exactly_one_retry(self):
        for code in (-11, 0xC0000005):
            process = Mock()
            process.__enter__ = Mock(return_value=process)
            process.__exit__ = Mock(return_value=False)
            process.returncode = code
            process.poll.return_value = code
            with patch("service.platform.pdf.subprocess.Popen", return_value=process) as spawn:
                with self.assertRaisesRegex(PdfDocumentError, "pdf_worker_crashed"):
                    _native_pdf(b"input", PdfNativeOperation.INFO)
            self.assertEqual(spawn.call_count, 2)

    def test_protocol_failure_does_not_retry(self):
        original = subprocess.Popen

        def spawn(_command, **kwargs):
            return original([sys.executable, "-c", "print('not-json')"], **kwargs)

        with patch("service.platform.pdf.subprocess.Popen", side_effect=spawn) as started:
            with self.assertRaisesRegex(PdfDocumentError, "pdf_worker_invalid_output"):
                _native_pdf(b"input", PdfNativeOperation.INFO)
        self.assertEqual(started.call_count, 1)

    def test_successful_retry_returns_only_complete_new_result(self):
        attempts = []

        def spawn(_command, **kwargs):
            process = Mock()
            process.__enter__ = Mock(return_value=process)
            process.__exit__ = Mock(return_value=False)
            process.returncode = -11 if not attempts else 0
            process.poll.return_value = process.returncode
            kwargs["stdout"].write(b"partial" if not attempts else b'{"ok":true,"result":3}')
            attempts.append(process)
            return process

        with patch("service.platform.pdf.subprocess.Popen", side_effect=spawn):
            self.assertEqual(_native_pdf(b"input", PdfNativeOperation.INFO), 3)
        self.assertEqual(len(attempts), 2)

    def test_output_limit_is_enforced(self):
        with patch("service.platform.pdf.PDF_WORKER_MAXIMUM_OUTPUT_BYTES", 4):
            with self.assertRaisesRegex(PdfDocumentError, "pdf_worker_output_too_large"):
                pdf_document_text(self.payload, (1,))

    def test_partial_index_only_requests_selected_image_pages(self):
        images = Mock(return_value=((),))
        index = extract(self.payload, 2, 2, image_bounds=images)
        images.assert_called_once_with(self.payload, (2,))
        self.assertEqual(index.page_count, 3)

    def test_index_worker_runs_without_spawning_descendants(self):
        program = (
            "import subprocess,sys; "
            "from service.workbench.service.parser import main; "
            "subprocess.Popen=lambda *a,**k: (_ for _ in ()).throw(AssertionError('nested worker')); "
            "sys.exit(main())"
        )
        result = subprocess.run(
            [sys.executable, "-c", program, "--start-page", "2", "--end-page", "2"],
            input=self.payload,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertTrue(response["ok"])
        self.assertEqual(response["index"]["page_count"], 3)


if __name__ == "__main__":
    unittest.main()
