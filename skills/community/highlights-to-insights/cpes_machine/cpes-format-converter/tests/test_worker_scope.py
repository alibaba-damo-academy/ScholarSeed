import importlib.metadata
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_format_converter import cli, worker


class WorkerScopeTests(unittest.TestCase):
    def run_conversion(self, domains, extra_env=None):
        # Run the real CLI and worker, substituting only expensive model inference.
        observed = []
        class FakePipeline:
            def __init__(self, **options):
                self.options = options
                observed.append(options)
            def predict(self, input):
                return [{'parsing_res_list': []}]
        paddleocr = types.SimpleNamespace(PPStructureV3=FakePipeline, __version__='test')
        paddle = types.SimpleNamespace(__version__='test', device=types.SimpleNamespace(get_device=lambda:'cpu'))
        original_version = importlib.metadata.version
        def model_version(name):
            return 'test' if name == 'paddlex' else original_version(name)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);pdf=root/'sample.pdf'
            writer = PdfWriter()
            page = writer.add_blank_page(width=595, height=842)
            content = DecodedStreamObject()
            content.set_data(b'10 812 20 20 re S')
            page[NameObject('/Contents')] = writer._add_object(content)
            writer.write(pdf)
            env={'CPES_DEVICE':'cpu','CPES_PADDLE_LOCK':str(root/'paddle.lock')}
            env.update(extra_env or {})
            def execute_worker(command, **kwargs):
                with patch.object(sys,'argv',command[1:]):
                    try:
                        code=worker.main()
                    except SystemExit as exc:
                        code=exc.code
                envelope=Path(command[command.index('--output')+1])
                if code==0:
                    self.envelope=json.loads(envelope.read_text())
                return types.SimpleNamespace(returncode=code,stderr='')
            with patch.dict(os.environ,env),patch.dict(sys.modules,{'paddleocr':paddleocr,'paddle':paddle}),patch.object(cli.subprocess,'run',execute_worker),patch.object(importlib.metadata,'version',side_effect=model_version):
                result=cli.run(str(pdf),str(root/'output'),domains,root)
            self.assertEqual(len(observed), 1)
            self.assertEqual(self.envelope['engine']['ocr_pages'], [1])
            return observed[0],result

    def test_figure_scope_does_not_enable_table_or_formula_models(self):
        options,result=self.run_conversion(['figure'])
        self.assertFalse(options['use_table_recognition'])
        self.assertFalse(options['use_formula_recognition'])
        self.assertEqual(set(result['domains']),{'figure'})

    def test_default_scope_retains_full_extraction(self):
        options,result=self.run_conversion([])
        self.assertTrue(options['use_table_recognition'])
        self.assertTrue(options['use_formula_recognition'])
        self.assertEqual(set(result['domains']),{'text','figure','table','formula'})

    def test_table_scope_does_not_enable_formula_model(self):
        options,_=self.run_conversion(['table'])
        self.assertTrue(options['use_table_recognition'])
        self.assertFalse(options['use_formula_recognition'])

    def test_explicit_detection_limit_reaches_pipeline(self):
        options,_=self.run_conversion(['figure'],{'CPES_TEXT_DET_MAX_SIDE':'960'})
        self.assertEqual(options.get('text_det_limit_side_len'),960)
        self.assertEqual(options.get('text_det_limit_type'),'max')

if __name__=='__main__':unittest.main()
