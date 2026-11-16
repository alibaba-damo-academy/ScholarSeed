import unittest
import sys
import types
from pathlib import Path
import numpy
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

class NativeTableInputTests(unittest.TestCase):
    def test_native_table_packet_includes_image_for_paddle_postprocessor(self):
        from unittest.mock import patch
        from PIL import Image
        import tempfile
        from cpes_format_converter.paddle_backend import PaddleBackend
        class Model:
            def predict(self,image,**kwargs):
                packet=kwargs['overall_ocr_res']
                assert isinstance(packet['doc_preprocessor_res']['output_img'], numpy.ndarray)
                self_shape=packet['doc_preprocessor_res']['output_img'].shape
                assert self_shape[:2]==(30,40)
                assert kwargs['use_ocr_model'] is False
                return iter([{'table_res_list':[]}])
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'page.png';Image.new('RGB',(40,30),'white').save(p)
            backend=PaddleBackend({});backend.table_model=Model()
            with patch.dict(sys.modules,{'paddleocr':types.SimpleNamespace(TableRecognitionPipelineV2=None)}):
                self.assertEqual(backend.tables(str(p),{'boxes':[]},[]),[])
