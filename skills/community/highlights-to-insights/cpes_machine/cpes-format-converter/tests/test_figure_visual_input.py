from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from pdf_fixture import document_pdf
from cpes_format_converter.visual_input import extract_figure_image


class VisualInputTests(unittest.TestCase):
    def make(self, bitmap=True, label=False, vector=False, rotate=False, scan=False, mask=False, colorbar=False):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        root = Path(tmp.name); pdf = root/'paper.pdf'
        page = {'texts': [{'at': (50, 235), 'text': 'Figure 1: Caption excluded'}]}
        if bitmap:
            page['images'] = [{'bounds': (0, 0, 300, 400) if scan else (50, 50, 250, 200),
                               'size': (800, 600), 'mode': 'RGBA' if mask else 'RGB',
                               'color': (20, 40, 80, 180) if mask else (20, 40, 80), 'rotate': rotate}]
        if label:
            page['texts'].append({'at': (110, 210), 'text': 'Frequency'})
        if vector:
            page['lines'] = [(55, 55, 240, 190)]
            page['texts'].append({'at': (90, 100), 'text': 'Optimal'})
        if colorbar:
            page.setdefault('images', []).append({'bounds': (255, 50, 270, 200), 'size': (30, 300), 'color': 'red'})
        document_pdf(pdf, [page], size=(300, 400))
        info = {'page_number':1, 'width':600, 'height':800, 'regions':[
            {'region_id':'c','raw_label':'figure_title','bbox_pixels':[100,448,530,480]}]}
        return pdf, info, root/'figure.png'

    def test_complete_bitmap_exports_original_dimensions_and_whole_bounds(self):
        pdf, info, out = self.make(mask=True)
        meta = extract_figure_image(pdf,info,[103,102,496,394],out)
        self.assertEqual(meta['route'],'bitmap-original')
        with Image.open(out) as image:
            self.assertEqual(image.size,(800,600))
            self.assertEqual(image.mode,'RGBA')
        self.assertEqual(meta['bbox_pixels'],[100.,100.,500.,400.])
        self.assertEqual(meta['native_text'],[])

    def test_independent_labels_force_complete_composite_and_native_text(self):
        pdf, info, out = self.make(label=True)
        meta = extract_figure_image(pdf,info,[100,100,500,422],out)
        self.assertEqual(meta['route'],'mixed-render-native-text')
        self.assertIn('Frequency',' '.join(x['text'] for x in meta['native_text']))
        self.assertNotIn('Caption',' '.join(x['text'] for x in meta['native_text']))
        with Image.open(out) as image: self.assertGreater(image.width,800)
        self.assertLess(meta['bbox_pixels'][3],448)

    def test_vector_render_keeps_native_labels(self):
        pdf, info, out = self.make(bitmap=False,vector=True)
        meta = extract_figure_image(pdf,info,[100,100,500,400],out)
        self.assertEqual(meta['route'],'vector-render-native-text')
        self.assertIn('Optimal',' '.join(x['text'] for x in meta['native_text']))

    def test_overlay_drawings_and_rotated_bitmap_are_never_exported_alone(self):
        for kwargs in ({'vector':True},{'rotate':True}):
            pdf, info, out = self.make(**kwargs)
            self.assertNotEqual(extract_figure_image(pdf,info,[100,100,500,400],out)['route'],'bitmap-original')

    def test_whole_page_scan_does_not_replace_a_small_figure(self):
        pdf, info, out = self.make(scan=True)
        meta = extract_figure_image(pdf,info,[100,100,500,400],out)
        self.assertNotEqual(meta['route'],'bitmap-original')
        self.assertEqual(meta['native_text'],[])
        self.assertLess(meta['bbox_pixels'][3],448)

    def test_bitmap_export_failure_falls_back_to_page_composite(self):
        pdf, info, out = self.make()
        with patch('cpes_format_converter.visual_input._export_bitmap',side_effect=ValueError('unsupported image')):
            meta = extract_figure_image(pdf,info,[100,100,500,400],out)
        self.assertNotEqual(meta['route'],'bitmap-original')
        self.assertEqual(meta['fallback_reason'],'bitmap_export_failed')
        self.assertTrue(out.is_file())

    def test_multiple_images_are_composited_not_largest_image_selected(self):
        pdf, info, out = self.make(colorbar=True)
        meta=extract_figure_image(pdf,info,[100,100,540,400],out)
        self.assertNotEqual(meta['route'],'bitmap-original')
        with Image.open(out) as image:
            # Both blue body and red colorbar survive the composite.
            colors=image.convert('RGB').getcolors(image.width*image.height)
            self.assertTrue(any(rgb==(255,0,0) for _,rgb in colors))
            self.assertTrue(any(rgb==(20,40,80) for _,rgb in colors))

    def test_native_caption_bounds_do_not_clip_neighboring_axis_label(self):
        pdf,info,out=self.make(label=True)
        caption=info['regions'][0]
        caption['bbox_pixels']=[100,424,530,480]
        caption['source_lines']=[{'bbox_pixels':[100,448,530,480],
            'extraction_method':'native','coordinate_precision':'line'}]
        meta=extract_figure_image(pdf,info,[100,100,500,422],out)
        row=next(x for x in meta['native_text'] if 'Frequency' in x['text'])
        self.assertGreaterEqual(meta['bbox_pdf_points'][3],row['bbox_pdf_points'][3])
        self.assertLess(meta['bbox_pixels'][3],448)

    def test_render_padding_stops_at_caption_and_neighbor(self):
        pdf, info, out = self.make(bitmap=False,vector=True)
        info['regions'].append({'region_id':'near','raw_label':'text',
                                'bbox_pixels':[100,404,500,440]})
        meta=extract_figure_image(pdf,info,[100,100,500,400],out)
        self.assertLess(meta['bbox_pixels'][3],404)
        self.assertGreaterEqual(meta['bbox_pixels'][3],400)

    def test_render_pixel_limits_include_rounding_of_clip_bounds(self):
        pdf,info,out=self.make(bitmap=False,vector=True)
        with patch('cpes_format_converter.visual_input.MAX_EDGE',100), \
             patch('cpes_format_converter.visual_input.MAX_PIXELS',5000):
            meta=extract_figure_image(pdf,info,[100,100,500,400],out)
        self.assertLessEqual(max(meta['width'],meta['height']),100)
        self.assertLessEqual(meta['width']*meta['height'],5000)
        self.assertTrue(meta['resolution_limited'])

    def test_nonuniform_detector_scale_maps_back_to_same_pdf_bounds(self):
        pdf, info, out = self.make()
        info.update(width=900,height=800)
        meta = extract_figure_image(pdf,info,[150,100,750,400],out)
        self.assertEqual(meta['route'],'bitmap-original')
        self.assertEqual(meta['bbox_pixels'],[150.,100.,750.,400.])

if __name__=='__main__': unittest.main()
