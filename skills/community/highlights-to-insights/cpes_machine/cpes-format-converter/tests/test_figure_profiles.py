"""Real PDF tests: Fast is always a page-region bitmap, never a raw image export."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter.visual_input import extract_figure_image

class ProfilesTests(unittest.TestCase):
    def sample(self,kind):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        root=Path(tmp.name);pdf=root/'paper.pdf'
        page = {'texts': [{'at': (50, 240), 'text': 'Figure 1: A complete caption.'}]}
        if kind in ('bitmap', 'mixed'):
            page['images'] = [{'bounds': (50, 50, 450, 200), 'size': (1600, 600), 'color': 'navy'}]
        if kind in ('vector', 'mixed'):
            page['lines'] = [(55, 60, 440, 195)]
            page['texts'].append({'at': (100, 90), 'text': 'Native legend'})
        document_pdf(pdf, [page], size=(600, 400))
        info={'page_number':1,'width':1200,'height':800,'regions':[
            {'raw_label':'figure_title','bbox_pixels':[100,455,1000,490]}]}
        return root,pdf,info

    def test_fast_never_exports_original_or_sends_visual_native_text(self):
        for kind in ('bitmap','vector','mixed'):
            root,pdf,info=self.sample(kind)
            with patch('cpes_format_converter.visual_input._export_bitmap',side_effect=AssertionError('Fast must render')):
                fast=extract_figure_image(pdf,info,[100,100,900,400],root/'fast.png',profile='fast')
            deep=extract_figure_image(pdf,info,[100,100,900,400],root/'deep.png',profile='deep')
            self.assertEqual(fast['profile'],'fast')
            self.assertEqual(fast['route'],'bitmap-crop')
            self.assertEqual(fast['native_text'],[])
            self.assertEqual(fast['bbox_pdf_points'],deep['bbox_pdf_points'])
            self.assertLessEqual(max(fast['width'],fast['height']),1024)
            self.assertNotEqual(fast['config_sha256'],deep['config_sha256'])
            with Image.open(root/'fast.png') as image: self.assertEqual(image.mode,'RGB')
            if kind=='bitmap':self.assertEqual(deep['route'],'bitmap-original')
            else:self.assertTrue(deep['native_text'])

    def test_fast_long_edge_cap_keeps_whole_region(self):
        root,pdf,info=self.sample('vector')
        fast=extract_figure_image(pdf,info,[0,0,1200,800],root/'fast.png',profile='fast')
        self.assertLessEqual(max(fast['width'],fast['height']),1024)
        self.assertEqual(fast['bbox_pdf_points'],[0,0,600,400])
        self.assertTrue(fast['resolution_limited'])

    def test_unknown_profile_fails_without_output(self):
        root,pdf,info=self.sample('bitmap')
        with self.assertRaises(ValueError):extract_figure_image(pdf,info,[100,100,900,400],root/'bad.png',profile='turbo')
        self.assertFalse((root/'bad.png').exists())

if __name__=='__main__':unittest.main()
