"""Evidence diagnostics preserve attempts without exposing credentials."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from diagnostics import EvidenceLog


class DiagnosticsTests(unittest.TestCase):
    def test_runs_are_separate_and_results_are_not_truncated(self):
        with tempfile.TemporaryDirectory() as folder:
            first = EvidenceLog(folder, 'processing')
            second = EvidenceLog(folder, 'processing')
            self.assertNotEqual(first.directory, second.directory)
            payload = {'fields': {'common_fields': {'tldr': 'value' * 10000}}}
            reference = first.result('../paper', 'response', payload)
            self.assertEqual(json.loads((Path(folder) / reference).read_text()), payload)
            self.assertTrue((Path(folder).resolve() / reference).is_relative_to(first.directory))

    def test_failure_is_recorded_and_original_error_propagates(self):
        with tempfile.TemporaryDirectory() as folder:
            diagnostic = EvidenceLog(folder, 'fulltext')
            with self.assertRaisesRegex(ValueError, 'bad PDF'):
                with diagnostic.measure('parse', 'paper', source='local_pdf'):
                    raise ValueError('bad PDF')
            events = [json.loads(line) for line in diagnostic.events.read_text().splitlines()]
            self.assertEqual(events[-1]['status'], 'failed')
            self.assertGreaterEqual(events[-1]['elapsed_seconds'], 0)
            self.assertEqual(events[-1]['source'], 'local_pdf')

    def test_credentials_and_signed_urls_are_redacted(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'SCHOLARSEED_API_KEY': 'private-test-token'}):
            diagnostic = EvidenceLog(folder, 'processing')
            reference = diagnostic.result('paper', 'failed', {
                'Authorization': 'Bearer secret',
                'error': 'private-test-token https://example.com/pdf?Signature=secret&Expires=123',
                'card': {'method': 'ordinary scientific content'},
                'response': '{"api_key":"unknown-private-value"}',
                'url': 'https://user:private-password@example.com/pdf',
            })
            content = (Path(folder) / reference).read_text()
            self.assertNotIn('private-test-token', content)
            self.assertNotIn('Signature=secret', content)
            self.assertNotIn('Bearer secret', content)
            self.assertNotIn('unknown-private-value', content)
            self.assertNotIn('private-password', content)
            self.assertIn('ordinary scientific content', content)
