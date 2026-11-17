import contextlib
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter import cli, native, worker
from cpes_format_converter.common import ConverterError
from cpes_format_converter.paddle_backend import PaddleBackend


class FigureBackend:
    def __init__(self, options):
        pass

    def layout(self, image):
        return {'boxes': [
            {'label': 'image', 'coordinate': [50, 50, 500, 250]},
            {'label': 'figure_title', 'coordinate': [50, 270, 600, 330]}]}

    def structured(self, *args):
        return {}, []


class DirectOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.pdf = self.root / 'source.pdf'
        self.pdf_pages = [{'texts': [
            {'at': (30, 150), 'text': 'Figure 1: Original caption.'},
            {'at': (30, 400), 'text': 'Body original hyphen-\nated text.'}]}]
        document_pdf(self.pdf, self.pdf_pages)
        self.run_root = self.root / 'run'
        (self.run_root / 'figure-cards').mkdir(parents=True)
        (self.run_root / 'system').mkdir()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ, {'CPES_PADDLE_LOCK': str(self.root / 'paddle.lock')}))
        stack.enter_context(patch.dict(sys.modules, {
            'paddleocr': types.SimpleNamespace(__version__='test'),
            'paddle': types.SimpleNamespace(__version__='test', device=types.SimpleNamespace(get_device=lambda: 'cpu'))}))
        stack.enter_context(patch('cpes_format_converter.paddle_backend.PaddleBackend', FigureBackend))
        stack.enter_context(patch.object(worker.importlib.metadata, 'version', return_value='test'))

    def direct(self, **kwargs):
        return cli.run(str(self.pdf), str(self.run_root), ['figure'], self.root,
                       cpes_direct=True, native_context=True, **kwargs)

    def test_direct_creates_only_final_artifacts_and_matches_standalone(self):
        writes = []
        active = [True]
        def audit(event, args):
            if active[0] and event == 'open' and isinstance(args[0], (str, bytes)):
                path, mode, flags = args
                if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
                    writes.append(Path(os.fsdecode(path)))
        sys.addaudithook(audit)
        try:
            direct = self.direct()
        finally:
            active[0] = False
        allowed = {'figure-cards/figure-1/figure.png', 'figure-cards/figure-1/caption.md', 'system/document.txt'}
        for path in writes:
            if path.name == 'paddle.lock' or (path.name == 'page.png' and path.parent.name.startswith('cpes-pages-')):
                continue
            self.assertTrue(path.is_relative_to(self.run_root), str(path))
            self.assertIn(path.relative_to(self.run_root).as_posix(), allowed)
        self.assertEqual({p.relative_to(self.run_root).as_posix() for p in self.run_root.rglob('*') if p.is_file()}, allowed)
        self.assertEqual(direct['storage'], 'cpes-converter-direct-v1')
        catalog = direct['catalog']
        self.assertEqual(catalog['artifact_base'], 'run')
        self.assertEqual(catalog['layout']['pages'], [{'page_number': 1, 'extraction_method': 'native'}])
        def execute_worker(command, **kwargs):
            with patch.object(sys, 'argv', command[1:]):
                code = worker.main()
            return types.SimpleNamespace(returncode=code, stderr='')
        with patch.object(cli.subprocess, 'run', execute_worker):
            normal = cli.run(str(self.pdf), str(self.root / 'normal'), ['figure'], self.root, native_context=True)
        figure = catalog['domains']['figure']['figures'][0]
        normal_dir = self.root / 'normal/figures/figure-1'
        self.assertEqual(figure['metadata'], json.loads((normal_dir / 'figure.json').read_text()))
        for entry in figure['artifacts']:
            value = (self.run_root / entry['path']).read_bytes()
            self.assertEqual(value, (normal_dir / Path(entry['path']).name).read_bytes())
            self.assertEqual(entry['sha256'], hashlib.sha256(value).hexdigest())
        context = catalog['native_context']
        body = (self.run_root / 'system/document.txt').read_bytes()
        self.assertEqual(body, (self.root / 'normal/native-context/document.txt').read_bytes())
        normal_source = json.loads((self.root / 'normal/native-context/source.json').read_text())
        for row in normal_source['lines']:
            row.pop('text')
        normal_source['text_storage'] = 'document-lines'
        self.assertEqual(context['source'], normal_source)
        self.assertEqual([a['path'] for a in context['artifacts']], ['system/document.txt'])

    def test_missing_target_retains_explicit_partial_result(self):
        result = self.direct(figure_numbers=['1', '99'])['catalog']
        self.assertEqual(result['status'], 'partial')
        self.assertIn({'code': 'requested_figure_not_found', 'figure': '99'}, result['domains']['figure']['issues'])
        self.assertEqual(result['figure_index']['requested_figures'], ['1', '99'])

    def test_unknown_boundary_creates_no_artifacts(self):
        with self.assertRaises(ConverterError) as raised:
            self.direct(figure_scope='main')
        self.assertEqual(raised.exception.code, 'body_boundary_unknown')
        self.assertFalse(any(p.is_file() for p in self.run_root.rglob('*')))

    def test_worker_failure_creates_no_artifacts(self):
        with patch.object(FigureBackend, 'layout', side_effect=RuntimeError('backend failed')):
            with self.assertRaises(ConverterError) as raised:
                self.direct()
        self.assertEqual(raised.exception.code, 'paddle_failed')
        self.assertFalse(any(p.is_file() for p in self.run_root.rglob('*')))

    def test_preexisting_figure_or_document_is_never_overwritten(self):
        for target in ('figure-cards/figure-1', 'system/document.txt'):
            with self.subTest(target=target):
                path = self.run_root / target
                if target.endswith('.txt'):
                    path.write_bytes(b'keep me')
                else:
                    path.mkdir()
                    (path / 'keep.txt').write_bytes(b'keep me')
                with self.assertRaises(ConverterError) as raised:
                    self.direct()
                self.assertEqual(raised.exception.code, 'output_exists')
                self.assertEqual((path if path.is_file() else path / 'keep.txt').read_bytes(), b'keep me')
                if path.is_dir():
                    (path / 'keep.txt').unlink()
                    path.rmdir()
                else:
                    path.unlink()
                self.assertFalse(any(p.is_file() for p in self.run_root.rglob('*')))

    def test_direct_requires_existing_run_directories_and_figure_domain(self):
        (self.run_root / 'system').rmdir()
        with self.assertRaises(ConverterError):
            self.direct()
        with self.assertRaises(ConverterError):
            cli.run(str(self.pdf), str(self.run_root), ['text'], self.root, cpes_direct=True)
        self.assertFalse(any(p.is_file() for p in self.run_root.rglob('*')))

    def test_native_control_glyphs_keep_frozen_line_numbers_and_bytes(self):
        original = native.native_lines
        def control_lines(*args):
            rows = original(*args)
            rows[1]['text'] = 'before\rafter\fmath'
            return rows
        with patch.object(native, 'native_lines', control_lines):
            context = self.direct()['catalog']['native_context']
        self.assertEqual(context['line_count'], 3)
        self.assertEqual((self.run_root / 'system/document.txt').read_bytes(),
                         b'Figure 1: Original caption.\nbefore\rafter\fmath\nated text.\n')
        self.assertEqual([r['line_number'] for r in context['source']['lines']], [1, 2, 3])
        self.assertTrue(all('text' not in r and 'bbox_pixels' in r for r in context['source']['lines']))

    def test_native_library_stdout_cannot_corrupt_cli_json(self):
        original = FigureBackend.layout
        def noisy_layout(*args):
            os.write(1, b'native model log\n')
            ctypes.CDLL(None).printf(b'buffered native diagnostic')
            return original(*args)
        read_out, write_out = os.pipe()
        read_err, write_err = os.pipe()
        saved_out, saved_err = os.dup(1), os.dup(2)
        stdout = io.StringIO()
        try:
            os.dup2(write_out, 1)
            os.dup2(write_err, 2)
            with patch.object(FigureBackend, 'layout', noisy_layout), contextlib.redirect_stdout(stdout):
                code = cli.main(['--input', str(self.pdf), '--output', str(self.run_root), '--domain', 'figure', '--cpes-direct'])
        finally:
            ctypes.CDLL(None).fflush(None)
            os.dup2(saved_out, 1)
            os.dup2(saved_err, 2)
            for fd in (saved_out, saved_err, write_out, write_err):
                os.close(fd)
        try:
            self.assertEqual(os.read(read_out, 4096), b'')
            native_logs = os.read(read_err, 4096)
            self.assertIn(b'native model log', native_logs)
            self.assertIn(b'buffered native diagnostic', native_logs)
        finally:
            os.close(read_out)
            os.close(read_err)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())['catalog']['status'], 'success')

    def test_main_scope_excludes_later_figures_but_keeps_all_native_lines(self):
        self.pdf_pages[0]['texts'].extend([
            {'at': (30, 500), 'text': 'References', 'bold': True, 'size': 14},
            {'at': (30, 550), 'text': 'Smith, A. 2021. First paper. Journal of Tests.\nJones, B. 2022. Second paper. Test Press.\nLee, C. 2023. Third paper. Proceedings of Tests.'}])
        self.pdf_pages.append({'texts': [{'at': (30, 150), 'text': 'Figure 2: Appendix caption.'}]})
        document_pdf(self.pdf, self.pdf_pages)
        result = self.direct(figure_scope='main')['catalog']
        self.assertEqual(result['figure_scope']['status'], 'identified')
        self.assertEqual([f['figure_number'] for f in result['domains']['figure']['figures']], ['1'])
        source = result['native_context']['source']
        self.assertEqual(source['lines'][-1]['page_number'], 2)
        self.assertFalse(source['lines'][-1]['in_figure_scope'])
        self.assertIn(b'Figure 2: Appendix caption.', (self.run_root / 'system/document.txt').read_bytes())

    def test_source_change_during_models_fails_before_publication(self):
        original = FigureBackend.layout
        def change_source(*args):
            with self.pdf.open('ab') as stream:
                stream.write(b'\n% changed\n')
            return original(*args)
        with patch.object(FigureBackend, 'layout', change_source):
            with self.assertRaises(ConverterError) as raised:
                self.direct()
        self.assertEqual(raised.exception.code, 'source_changed')
        self.assertFalse(any(p.is_file() for p in self.run_root.rglob('*')))

    def test_cli_emits_one_json_payload_with_model_logging_on_stderr(self):
        original = FigureBackend.layout
        def noisy_layout(*args):
            print('model startup message')
            return original(*args)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(FigureBackend, 'layout', noisy_layout), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(['--input', str(self.pdf), '--output', str(self.run_root), '--domain', 'figure', '--cpes-direct', '--native-context'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())['storage'], 'cpes-converter-direct-v1')
        self.assertIn('model startup message', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
