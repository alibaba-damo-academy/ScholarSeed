"""Lazy Paddle adapters. Native pages never initialize general OCR."""
from __future__ import annotations

from importlib.resources import files

from .extract import iou


def result_dict(result):
    value = getattr(result, 'json', result)
    value = value() if callable(value) else value
    return value['res'] if isinstance(value, dict) and set(value) == {'res'} else value


class PaddleBackend:
    def __init__(self, options):
        self.options = options
        self.device = {'device': options.get('device', 'cpu')}
        self.layout_model = self.scan_model = self.table_model = self.formula_model = None

    def layout(self, image):
        if self.layout_model is None:
            import yaml
            from paddleocr import LayoutDetection
            config = yaml.safe_load(files('paddlex').joinpath('configs/pipelines/PP-StructureV3.yaml').read_text())
            config = config['SubModules']['LayoutDetection']
            self.layout_settings = {k: config[k] for k in
                                    ('threshold', 'layout_nms', 'layout_unclip_ratio', 'layout_merge_bboxes_mode')}
            self.layout_model = LayoutDetection(model_name='PP-DocLayout_plus-L', **self.device)
        return result_dict(next(iter(self.layout_model.predict(image, batch_size=1, **self.layout_settings))))

    def scan(self, image):
        if self.scan_model is None:
            from paddleocr import PPStructureV3
            self.scan_model = PPStructureV3(**self.options)
        return result_dict(next(iter(self.scan_model.predict(input=image))))

    def structured(self, image, layout, lines, domains):
        replacements, issues = {}, []
        boxes = layout.get('boxes', [])
        for domain, labels in (('table', {'table'}), ('formula', {'formula', 'display_formula'})):
            selected = [(i, b) for i, b in enumerate(boxes) if b['label'] in labels]
            if domain not in domains or not selected:
                continue
            # Native printed math/table text is evidence, not an HTML/LaTeX transcription.
            replacements.update({i: '' for i, _ in selected})
            try:
                if domain == 'table':
                    values = self.tables(image, layout, lines)
                    if len(values) != len(selected):
                        raise ValueError('Table recognizer returned a different number of regions')
                    for (i, _), value in zip(selected, values):
                        replacements[i] = value['pred_html']
                else:
                    values = self.formulas(image, layout)
                    for i, box in selected:
                        candidates = [v for v in values if iou(box['coordinate'], v['dt_polys']) > .9]
                        if len(candidates) != 1 or not candidates[0].get('rec_formula'):
                            raise ValueError('Formula transcription missing or ambiguous')
                        replacements[i] = candidates[0]['rec_formula']
            except Exception as exc:
                issues.append({'domain': domain, 'code': 'structured_recognition_failed',
                               'message': f'{type(exc).__name__}: {exc}',
                               'block_ids': [i for i, _ in selected]})
        return replacements, issues

    def tables(self, image, layout, lines):
        import numpy as np
        if self.table_model is None:
            from paddleocr import TableRecognitionPipelineV2
            self.table_model = TableRecognitionPipelineV2(
                use_doc_orientation_classify=False, use_doc_unwarping=False,
                use_layout_detection=False, use_ocr_model=False, **self.device)
        boxes = np.asarray([l['bbox_pixels'] for l in lines], dtype=np.float32).reshape(-1, 4)
        polys = [np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float32)
                 for x0, y0, x1, y1 in boxes]
        from PIL import Image
        with Image.open(image) as source_image:
            image_array = np.asarray(source_image.convert('RGB'))[:, :, ::-1].copy()
        native_ocr = {'doc_preprocessor_res': {'output_img': image_array}, 'rec_boxes': boxes, 'rec_polys': polys, 'dt_polys': polys,
                      'rec_texts': [l['text'] for l in lines], 'rec_scores': [1.0] * len(lines)}
        result = self.table_model.predict(
            image, use_ocr_model=False, use_layout_detection=False,
            overall_ocr_res=native_ocr, layout_det_res=layout,
            use_table_orientation_classify=False, use_ocr_results_with_table_cells=False)
        return next(iter(result))['table_res_list']

    def formulas(self, image, layout):
        from paddleocr import FormulaRecognitionPipeline
        if self.formula_model is None:
            self.formula_model = FormulaRecognitionPipeline(
                use_doc_orientation_classify=False, use_doc_unwarping=False,
                use_layout_detection=False,
                formula_recognition_model_name=self.options['formula_recognition_model_name'], **self.device)
        result = self.formula_model.predict(image, use_layout_detection=False, layout_det_res=layout)
        return next(iter(result))['formula_res_list']
