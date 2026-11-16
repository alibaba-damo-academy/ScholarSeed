import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.oxml.ns import qn
from lxml import etree
from equations import equation
from word import export
from word import image_box
from PIL import Image


class WordTest(unittest.TestCase):
    def test_tall_image_fits_document_box_without_cropping_or_aspect_change(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Image.new('RGB', (20, 400), 'white').save(root / 'tall.png')
            destination = root / 'figures.docx'
            export('![Complete figure](tall.png)', root, destination)
            result = Document(destination)
            picture = result.inline_shapes[0]
            width, height = image_box(result)
            self.assertLessEqual(picture.width, width)
            self.assertLessEqual(picture.height, height)
            self.assertAlmostEqual(picture.height / picture.width, 20, places=4)

    def test_accents_and_combining_forms_preserve_base_before_subscript(self):
        for explicit, combining_form, mark in (
                (r'\tilde{h}_t', 'h\u0303_t', '\u0303'),
                (r'\bar{h}_s', 'h\u0304_s', '\u0305'),
                (r'\hat{x}_i', 'x\u0302_i', '\u0302')):
            with self.subTest(source=explicit):
                left, right = equation(explicit), equation(combining_form)
                self.assertEqual(etree.tostring(left), etree.tostring(right))
                script = left.find(qn('m:sSub'))
                self.assertIsNotNone(script)
                base = script.find(qn('m:e')).find(qn('m:acc'))
                self.assertIsNotNone(base)
                self.assertEqual(base.find(qn('m:accPr')).find(qn('m:chr')).get(qn('m:val')), mark)
                self.assertEqual(len(script.findall('.//' + qn('m:acc'))), 1)
                self.assertIsNone(script.find(qn('m:sub')).find(qn('m:acc')))
        self.assertEqual(etree.tostring(equation('x_h\u0303')),
                         etree.tostring(equation(r'x_{\tilde{h}}')))
        group = equation(r'\hat{x+y}_{k}')
        self.assertEqual(group.xpath('.//m:acc/m:e/m:r/m:t/text()', namespaces=group.nsmap), ['x+y'])

    def test_accented_equations_remain_editable_in_exported_docx(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'accents.docx'
            export(r'$\tilde{h}_t=\tanh(\bar{h}_s)$ and $h̃_t=h̄_s$.', root, path)
            result = Document(path)
            self.assertEqual(len(result.element.xpath('//m:oMath')), 2)
            self.assertEqual(len(result.element.xpath('//m:acc')), 4)
            self.assertEqual(result.element.xpath('//m:sSub/m:sub/m:r/m:t/text()'), ['t', 's', 't', 's'])
        with self.assertRaisesRegex(ValueError, 'requires a base'):
            equation('\u0303x')
        with self.assertRaisesRegex(ValueError, 'unsupported DOCX combining accent'):
            equation('x\u0338')

    def test_math_is_preserved_before_markdown_and_text_subscripts_are_single_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            destination=root/'math.docx'
            export(r'$\mathcal{F}_{\text{MP-GNN}}$, $\|x\|$, $x*y*z$, $\left\{x\right\}$',root,destination)
            document=Document(destination)
            self.assertEqual(len(document.element.xpath('//m:oMath')),4)
            self.assertEqual(document.element.xpath('//m:sub/m:r/m:t/text()'),['MP-GNN'])
            math_text=''.join(document.element.xpath('//m:oMath//m:t/text()'))
            self.assertIn('‖x‖',math_text)
            self.assertIn('x*y*z',math_text)
            self.assertIn('{x}',math_text)
            export(r'Literal \$not math$ and `$\frac{a}{b}$`.',root,destination)
            document=Document(destination)
            self.assertEqual(len(document.element.xpath('//m:oMath')),0)
            self.assertIn(r'$\frac{a}{b}$',document.paragraphs[0].text)

    def test_heading_identifiers_are_bookmarks_not_visible_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            destination = root / 'review.docx'
            export('## **Method** {#sec:s1_1}\n\nLiteral {#sec:body}.\n\n'
                   '## Literal `{#sec:code}`\n\n### Findings {#sec:s1_2}', root, destination)
            result = Document(destination)
            self.assertEqual(result.paragraphs[0].text, 'Method')
            self.assertEqual(result.paragraphs[1].text, 'Literal {#sec:body}.')
            self.assertEqual(result.paragraphs[2].text, 'Literal {#sec:code}')
            self.assertEqual(result.paragraphs[3].text, 'Findings')
            self.assertEqual(len(result.element.xpath('//w:bookmarkStart')), 2)
            self.assertEqual(len(result.element.xpath('//w:bookmarkEnd')), 2)
            with self.assertRaisesRegex(ValueError, 'duplicate heading identifier'):
                export('## First {#same}\n\n## Second {#same}', root, destination)

    def test_semantic_document_and_editable_math(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            destination = root / 'review.docx'
            export('# 比较\n\nA **supported** result $x_i^2=\\frac{a}{b}$.\n\n'
                   '| Source | Finding |\n| --- | --- |\n| A | B |\n\n'
                   '## References\n\nAuthor. Title. 2024.', root, destination)
            result = Document(destination)
            self.assertEqual(result.paragraphs[0].text, '比较')
            self.assertEqual(result.tables[0].cell(1, 1).text, 'B')
            with ZipFile(destination) as archive:
                xml = archive.read('word/document.xml').decode()
            self.assertIn('<m:sSubSup>', xml)
            self.assertIn('<m:f>', xml)
            self.assertIn('Author. Title. 2024.', xml)

    def test_asymmetric_uncertainty_retains_base_and_upper_lower_roles(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            destination = root / 'uncertainty.docx'
            export(r'Estimate ${8.2}^{+0.6}_{-0.4}$ units.', root, destination)
            result = Document(destination)
            scripts = result.element.xpath('//m:sSubSup')
            self.assertEqual(len(scripts), 1)
            element = scripts[0]
            self.assertEqual(''.join(element.xpath('./m:e//m:t/text()', namespaces=element.nsmap)), '8.2')
            self.assertEqual(''.join(element.xpath('./m:sup//m:t/text()', namespaces=element.nsmap)), '+0.6')
            self.assertEqual(''.join(element.xpath('./m:sub//m:t/text()', namespaces=element.nsmap)), '-0.4')
            self.assertIn('units.', result.paragraphs[0].text)

    def test_unsupported_equation_is_not_silently_lost(self):
        with self.assertRaises(ValueError):
            equation(r'\unknown{x}')
        with self.assertRaises(ValueError):
            equation(r'\frac{a}')
        self.assertEqual(etree.tostring(equation(r'\frac {a} {b}')),etree.tostring(equation(r'\frac{a}{b}')))
        with self.assertRaises(ValueError):
            equation(r'\sqrt[3]{x}')

    def test_nested_math_fonts_preserve_inner_style_and_argument_text(self):
        result=equation(r'\mathbf{\mathcal{F}}_{ij}')
        self.assertEqual(result.xpath('.//m:sub/m:r/m:t/text()',namespaces=result.nsmap),['ij'])
        self.assertEqual(len(result.xpath('.//m:rPr[m:scr and m:sty]',namespaces=result.nsmap)),1)
        result=equation(r'\mathrm{a\mathbf{b}c}')
        self.assertEqual(result.xpath('.//m:sty/@m:val',namespaces=result.nsmap),['p','b','p'])
        result=equation(r'\mathrm{H_2O}')
        self.assertEqual(result.xpath('.//m:sSub/m:e/m:r/m:t/text()',namespaces=result.nsmap),['H'])
        self.assertEqual(result.xpath('.//m:sSub/m:sub/m:r/m:t/text()',namespaces=result.nsmap),['2'])
        self.assertEqual(result.xpath('.//m:sty/@m:val',namespaces=result.nsmap),['p','p','p'])
        result=equation(r'\mathbf{\tilde{h}_t}')
        self.assertEqual(len(result.xpath('.//m:sSub/m:e/m:acc',namespaces=result.nsmap)),1)
        self.assertEqual(result.xpath('.//m:sty/@m:val',namespaces=result.nsmap),['b','b'])


if __name__ == '__main__':
    unittest.main()
