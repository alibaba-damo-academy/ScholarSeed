"""Receipt consumers preserve identity, decisions and replay without copied JSON."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import planning
import receipts
from task_contract import configure, digest, read_request

SCRIPT = Path(__file__).with_name('slr.py')


class ReceiptTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.ws = self.root / 'survey'
        self.ws.mkdir()
        self.old_cwd = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.old_cwd)
        (self.ws / '.slr-binding.json').write_text(json.dumps({'run_id': 'receipt-run'}))
        configure(self.ws, {'intent': 'Review the supplied evidence.', 'execution': {'mode': 'quick'},
                           'sources': {'policy': 'discover'}, 'publication': {'format': 'markdown'}})

    def save(self, response, operation=receipts.PLAN, **overrides):
        envelope = {'schema': receipts.SCHEMA, 'workspace': 'survey', 'run_id': 'receipt-run',
                    'operation': operation, 'response': response, **overrides}
        payload = (json.dumps(envelope, ensure_ascii=False, sort_keys=True) + '\n').encode()
        path = self.ws / receipts.DIRECTORY / (hashlib.sha256(payload).hexdigest() + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path.relative_to(self.root).as_posix()

    def response(self, decision):
        packet = planning.packet(self.ws)
        return {'ok': True, 'next_action': 'Use the saved reference.', 'confirmation': {
            'packet_id': packet['packet_id'], 'snapshot_id': digest(packet['snapshot']),
            'request_id': 'product-question', 'started_at': 0, 'deadline_at': 300, 'decision': decision}}

    def cli(self, *arguments):
        return subprocess.run([sys.executable, str(SCRIPT), *arguments, '--workspace', str(self.ws)],
                              cwd=self.root, capture_output=True, text=True, timeout=30)

    def test_plan_reference_preserves_answer_patch_and_idempotent_resolution(self):
        answer = 'Use English; preserve the scientific scope.'
        response = self.response({'answers': {'product-question': answer}})
        reference = self.save(response)
        patch = self.root / 'amendments.json'
        patch.write_text(json.dumps({'language': 'ENGLISH', 'user_requests': [answer],
                                     'effective_requirements': answer}))
        original = (self.root / reference).read_bytes()
        for _ in range(2):
            result = self.cli('writing', 'plan-resolve', '--receipt', reference,
                              '--action', 'proceed', '--patch', str(patch))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)['can_continue'])
        self.assertEqual((self.root / reference).read_bytes(), original)
        self.assertFalse((self.ws / planning.PLAN_RESPONSES).exists())
        self.assertEqual(read_request(self.ws)['user_requests'], [answer])
        configure(self.ws, {'publication': {'citation_style': 'ieee'}})
        stale = self.cli('writing', 'plan-resolve', '--receipt', reference, '--action', 'proceed')
        self.assertNotEqual(stale.returncode, 0)

    def test_cancelled_receipt_cannot_be_overridden_and_timeout_uses_actual_policy(self):
        cancelled = self.save(self.response({'cancelled': True}))
        invalid = self.cli('writing', 'plan-resolve', '--receipt', cancelled, '--action', 'proceed')
        self.assertNotEqual(invalid.returncode, 0)
        result = self.cli('writing', 'plan-resolve', '--receipt', cancelled)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse(json.loads(result.stdout)['can_continue'])
        with self.assertRaisesRegex(ValueError, 'actual answer'):
            receipts.approval({'confirmation': {'decision': {'timed_out': True}}})

    def test_wrong_operation_run_workspace_and_corrupted_bytes_are_rejected(self):
        response = {'ok': True}
        reference = self.save(response)
        self.assertEqual(receipts.read(self.ws, reference, receipts.PLAN), response)
        with self.assertRaisesRegex(ValueError, 'operation'):
            receipts.read(self.ws, reference, receipts.OUTLINE)
        for overrides in ({'run_id': 'another-run'}, {'workspace': 'another-task'}, {'schema': 'unknown'}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                receipts.read(self.ws, self.save(response, **overrides), receipts.PLAN)
        (self.root / reference).write_text('{"ok":true}')
        with self.assertRaisesRegex(ValueError, 'digest'):
            receipts.read(self.ws, reference, receipts.PLAN)

    def test_foreign_paths_and_links_are_rejected(self):
        reference = self.save({'ok': True})
        for invalid in ('../' + reference, '/' + reference, 'C:\\receipt.json', 'other/' + reference):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                receipts.read(self.ws, invalid, receipts.PLAN)
        source = self.root / reference
        copy = self.root / 'original.json'
        copy.write_bytes(source.read_bytes())
        source.unlink()
        source.symlink_to(copy)
        with self.assertRaisesRegex(ValueError, 'linked'):
            receipts.read(self.ws, reference, receipts.PLAN)

    def test_cli_rejects_legacy_items_without_replacing_existing_materials(self):
        path = self.ws / '02_retrieval/material_papers.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"refs":[],"papers":{}}')
        original = path.read_bytes()
        request = self.root / 'old-input.json'
        request.write_text('{"items":[]}')
        result = self.cli('papers', 'import-selected', '--request', str(request))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('legacy per-paper receipt import is retired', result.stdout)
        self.assertEqual(path.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
