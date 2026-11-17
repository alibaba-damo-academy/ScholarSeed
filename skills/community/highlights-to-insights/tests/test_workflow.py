"""The offline client entry point preserves real PDF material and request bindings."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cpes_machine.writer import load_request
from pdf_fixture import simple_pdf
from reading_pipeline import load_index, scope_summary


class WorkflowTests(unittest.TestCase):
    def test_full_cli_keeps_goal_notes_scope_and_frozen_request_with_no_model_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            pdf = root / 'paper with spaces.pdf'
            notes = root / 'notes.txt'
            simple_pdf(pdf, annotations=True)
            notes.write_text('Reader asks about forecast calibration.', encoding='utf-8')
            out = root / 'workflow'
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/workflow.py'), 'prepare',
                '--pdf', str(pdf), '--out-dir', str(out), '--language', 'zh-CN',
                '--goal', 'Explain forecast uncertainty', '--notes', str(notes),
                '--requirements', '约1500字，最多4个小标题'],
                env={**os.environ, 'PATH': '', 'SCHOLARSEED_SKILL_PYTHON': sys.executable},
                text=True, capture_output=True, timeout=15, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout)
            request = load_request(summary['request'])
            index = load_index(summary['index'])
            self.assertEqual(index['goal'], 'Explain forecast uncertainty')
            self.assertIn('Reader asks about forecast calibration.', request['prompt'])
            self.assertEqual(request['language'], 'zh-CN')
            self.assertEqual(request['writing_requirements'], '约1500字，最多4个小标题')
            self.assertIn('约1500字，最多4个小标题', request['prompt'])
            self.assertNotIn('约1500字，最多4个小标题', Path(summary['packet']).read_text())
            details = json.loads(Path(summary['details']).read_text())
            self.assertEqual(details['coverage'], index['coverage'])
            self.assertEqual(details['scope'], scope_summary(summary['index']))
            self.assertNotIn('boundary_candidates', summary['scope'])
            self.assertEqual(summary['coverage']['record_count'], index['coverage']['record_count'])
            self.assertEqual(summary['generation']['request']['input_path'], summary['request'])
            self.assertEqual(summary['generation']['request']['request_id'], request['fingerprint'])
            self.assertEqual(summary['accept']['request'], summary['request'])
            self.assertEqual(summary['model_calls'], 0)
            for name in ('reading_seconds', 'scope_seconds', 'request_seconds', 'total_seconds'):
                self.assertGreaterEqual(summary['timings'][name], 0)
            self.assertGreaterEqual(summary['timings']['total_seconds'], sum(
                summary['timings'][name] for name in ('reading_seconds', 'scope_seconds', 'request_seconds')))
            self.assertFalse(Path(summary['generation']['request']['output_path']).exists())


if __name__ == '__main__':
    unittest.main()
