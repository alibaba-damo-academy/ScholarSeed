"""PDF layout filtering contracts; generated PDFs are not product acceptance."""

from __future__ import annotations

import unittest
from dataclasses import asdict
from io import BytesIO

from PIL import Image

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.service.citations import evidence_windows
from service.platform.citations import (
    PDF_CAPTION,
    PDF_FIGURE,
    PDF_FORMULA,
    PDF_TABLE,
    CitationDocument,
    CitationPage,
    PdfFragment,
    PdfPageContent,
)
from service.workbench.service.extraction import decode_index, extract
from service.workbench.service.regions import crop, manifest, region
from service.workbench.service.sentences import SentenceBlock, assemble


class PdfLayoutContracts(unittest.TestCase):
    def test_client_geometry_is_the_crop_authority_and_malformed_bounds_are_rejected(self):
        class IndexFixture:
            def page_count(self, _document):
                return 1

            def pages(self, *_args):
                raise AssertionError("Client geometry must not resolve an old index region")

        with pdf_fixture.open() as pdf:
            pdf.new_page(width=600, height=800)
            payload = pdf.tobytes()
        document = CitationDocument("project", "paper.pdf", "Paper", "revision", payload)
        selected = region(IndexFixture(), document, 1, "pdfjs-1-0", [0.1, 0.2, 0.8, 0.6])
        self.assertEqual(selected.quad, (0.1, 0.2, 0.8, 0.6))
        with Image.open(BytesIO(crop(payload, selected))) as image:
            self.assertEqual(image.size, (840, 640))
        for invalid in ([0, 0, 1], [0, 0, float("nan"), 1], [-0.1, 0, 1, 1], [0.5, 0, 0.4, 1]):
            with (
                self.subTest(quad=invalid),
                self.assertRaisesRegex(ValueError, "pdf_region_invalid"),
            ):
                region(IndexFixture(), document, 1, "pdfjs-1-0", invalid)
        with self.assertRaisesRegex(ValueError, "pdf_region_invalid"):
            region(IndexFixture(), document, 2, "pdfjs-2-0", [0, 0, 1, 1])

    def test_region_manifest_and_crop_share_the_index_identity(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((170, 100), "L(theta) = E[r] - beta * D_KL(pi || pi_ref)", fontsize=13)
            payload = pdf.tobytes()
        index = extract(payload)
        document = CitationDocument("project", "paper.pdf", "Paper", index.revision, payload)

        class IndexFixture:
            def page_count(self, _document):
                return index.page_count

            def pages(self, _document, start_page, end_page):
                return tuple(
                    PdfPageContent(
                        page_number,
                        tuple(
                            fragment
                            for fragment in index.fragments
                            if any(anchor.page == page_number for anchor in fragment.pages)
                        ),
                        regions=tuple(item for item in index.regions if item.page == page_number),
                    )
                    for page_number in range(start_page, end_page + 1)
                )

        indexes = IndexFixture()
        projected = manifest(indexes, document, 1, 1)
        selected = index.regions[0]
        self.assertEqual(projected["pages"][0]["regions"][0]["region_id"], selected.region_id)
        self.assertEqual(region(indexes, document, 1, selected.region_id), selected)
        with Image.open(BytesIO(crop(payload, selected))) as image:
            self.assertEqual(image.format, "PNG")
            self.assertGreater(min(image.size), 20)

    def test_visual_regions_roundtrip_and_formula_text_remains_searchable(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((170, 100), "L(theta) = E[r] - beta * D_KL(pi || pi_ref)", fontsize=13)
            page.insert_text((60, 145), "The objective above remains part of the searchable text.")
            page = pdf.new_page(width=600, height=800)
            page.draw_rect(pdf_fixture.Rect(70, 210, 330, 360))
            page.insert_text((70, 390), "Figure 1: Training objective over time.")
            page = pdf.new_page(width=600, height=800)
            page.insert_text((60, 110), "Table 1: Scores")
            for y, name, score in (
                (145, "Alpha", "81.2"),
                (165, "Beta", "93.4"),
                (185, "Gamma", "88.0"),
            ):
                page.insert_text((60, y), name)
                page.insert_text((230, y), score)
            index = extract(pdf.tobytes())

        kinds = {region.kind for region in index.regions}
        self.assertTrue({PDF_FORMULA, PDF_FIGURE, PDF_TABLE}.issubset(kinds))
        self.assertEqual(
            len(index.regions),
            len({(region.page, region.kind, region.quad) for region in index.regions}),
        )
        formula = next(region for region in index.regions if region.kind == PDF_FORMULA)
        self.assertEqual(formula.text_policy, "retain")
        self.assertIn("L(theta)", " ".join(fragment.text for fragment in index.fragments))
        self.assertFalse(any(item.kind == PDF_FORMULA for item in index.omissions))
        self.assertEqual(index, decode_index(asdict(index)))

    def test_prose_with_hyphens_and_parentheses_is_not_a_formula(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text(
                (60, 100),
                "participants in AIME (2024) - DeepSeek-R1-Zero learns.",
                fontsize=11,
            )
            index = extract(pdf.tobytes())

        self.assertFalse(any(region.kind == PDF_FORMULA for region in index.regions))

    def test_sequential_numbered_equations_form_independent_regions(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((135, 100), "J(theta) = E[r] - beta * D(pi || ref)        (1)")
            page.insert_text((175, 135), "D(pi || ref) = ratio - log(ratio) - 1        (2)")
            page.insert_text(
                (80, 165),
                "where beta is a hyper-parameter and A is the normalized advantage.",
            )
            page.insert_text((190, 200), "A_i = (r_i - mean(r)) / std(r)        (3)")
            index = extract(pdf.tobytes())

        formulas = [region for region in index.regions if region.kind == PDF_FORMULA]
        self.assertEqual(len(formulas), 3)
        self.assertTrue(all(formula.quad[3] - formula.quad[1] < 0.05 for formula in formulas))
        self.assertLess(formulas[0].quad[1], formulas[1].quad[1])
        self.assertLess(formulas[1].quad[1], formulas[2].quad[1])

    def test_number_only_anchors_do_not_capture_neighboring_equation_lines(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((145, 100), "J(theta) = E[r] - beta * D(pi || ref)")
            page.insert_text((180, 116), "+ clipped advantage")
            page.insert_text((535, 108), "(1)")
            page.insert_text((175, 145), "D(pi || ref) = ratio - log(ratio) - 1")
            page.insert_text((535, 145), "(2)")
            page.insert_text((70, 170), "where beta is the regularization coefficient.")
            index = extract(pdf.tobytes())

        formulas = [region for region in index.regions if region.kind == PDF_FORMULA]
        self.assertEqual(len(formulas), 2)
        self.assertLess(formulas[0].quad[3], formulas[1].quad[1])
        self.assertLess(formulas[1].quad[3], 0.21)

    def test_numbered_formula_anchor_does_not_absorb_adjacent_column(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((50, 120), "The left column explains the model configuration.")
            page.insert_text((50, 140), "It must remain outside the formula selection region.")
            page.insert_text((335, 140), "P_i = exp(c_i) / sum(exp(c_j))")
            page.insert_text((535, 140), "(1)")
            page.insert_text((50, 180), "More prose continues in the adjacent column.")
            page.insert_text((350, 180), "L = - sum(t_i log(P_i))")
            page.insert_text((535, 180), "(2)")
            index = extract(pdf.tobytes())

        formulas = [region for region in index.regions if region.kind == PDF_FORMULA]
        self.assertEqual(len(formulas), 2)
        self.assertTrue(all(formula.quad[0] > 0.5 for formula in formulas))
        self.assertTrue(all(formula.quad[2] > 0.85 for formula in formulas))

    def test_shared_caption_merges_adjacent_plot_panels(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.draw_rect(pdf_fixture.Rect(60, 120, 275, 300))
            page.draw_rect(pdf_fixture.Rect(325, 120, 540, 300))
            page.insert_text((60, 330), "Figure 1: Accuracy and response length during training.")
            index = extract(pdf.tobytes())

        figures = [region for region in index.regions if region.kind == PDF_FIGURE]
        self.assertEqual(len(figures), 1)
        self.assertLess(figures[0].quad[0], 0.11)
        self.assertGreater(figures[0].quad[2], 0.89)

    def test_caption_clips_page_spanning_graphic_candidate(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.draw_rect(pdf_fixture.Rect(45, 55, 555, 520))
            page.draw_rect(pdf_fixture.Rect(100, 90, 500, 270))
            page.insert_text((95, 310), "Figure 3: Demonstration of the training architecture.")
            page.insert_text((120, 390), "J(theta) = E[r] - beta * D(pi || ref)        (11)")
            index = extract(pdf.tobytes())

        figure = next(region for region in index.regions if region.kind == PDF_FIGURE)
        formula = next(region for region in index.regions if region.kind == PDF_FORMULA)
        self.assertLessEqual(figure.quad[3], 0.39)
        self.assertGreater(formula.quad[1], figure.quad[3])

    def test_figure_caption_recovers_plot_without_image_or_connected_frame(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((60, 80), "The following experiment compares all methods.")
            page.insert_text((80, 150), "0.56")
            page.insert_text((80, 235), "0.42")
            page.insert_text((270, 275), "Steps")
            page.insert_text((390, 250), "PPO and GRPO")
            page.insert_text((100, 310), "Figure 4: Performance on the MATH task.")
            page.insert_text((60, 355), "The comparison improves throughout training.")
            index = extract(pdf.tobytes())

        figures = [region for region in index.regions if region.kind == PDF_FIGURE]
        self.assertEqual(len(figures), 1)
        self.assertLess(figures[0].quad[1], 0.19)
        self.assertGreater(figures[0].quad[3], 0.34)

    def test_caption_filter_preserves_word_anchors_after_index_roundtrip(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.draw_rect(pdf_fixture.Rect(60, 100, 280, 250))
            page.insert_text((100, 180), "INTERNAL LABEL")
            page.insert_text((60, 280), "Figure 1: The measured result remains available.")
            index = decode_index(asdict(extract(pdf.tobytes())))
        self.assertTrue(index.omissions)
        self.assertNotIn("INTERNAL LABEL", " ".join(f.text for f in index.fragments))
        caption = next(f for f in index.fragments if f.kind == PDF_CAPTION)
        self.assertTrue(caption.spans)
        self.assertEqual(
            [caption.text[span.start : span.end] for span in caption.spans],
            caption.text.split(),
        )
        self.assertTrue(all(span.page == 1 and span.quad[1] > 0.3 for span in caption.spans))

    def test_form_text_has_layout_and_preserves_columns(self):
        with pdf_fixture.open() as content, pdf_fixture.open() as wrapper:
            page = content.new_page(width=600, height=800)
            page.insert_text((60, 80), "Left column contains the first result.")
            page.insert_text((320, 80), "Right column contains another result.")
            target = wrapper.new_page(width=600, height=800)
            target.show_pdf_page(target.rect, content, 0)
            index = extract(wrapper.tobytes())
        self.assertEqual(
            [fragment.text for fragment in index.fragments],
            ["Left column contains the first result.", "Right column contains another result."],
        )
        self.assertFalse(index.unavailable_pages)

    def test_clipped_image_does_not_erase_caption_continuation_or_body(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            pixmap = pdf_fixture.Pixmap(pdf_fixture.csRGB, (0, 0, 100, 100), False)
            pixmap.clear_with(120)
            page.insert_image(pdf_fixture.Rect(60, 100, 350, 180), pixmap=pixmap)
            page.insert_text((60, 205), "Figure 1: A clipped illustration.")
            page.insert_text((60, 219), "This complete second caption line must survive.")
            page.insert_text((60, 270), "The body beneath the visible image must remain intact.")
            index = extract(pdf.tobytes())
        text = " ".join(fragment.text for fragment in index.fragments)
        self.assertIn("This complete second caption line must survive.", text)
        self.assertIn("The body beneath the visible image must remain intact.", text)
        self.assertTrue(index.omissions)
        self.assertTrue(all(q[3] < 0.25 for o in index.omissions for p in o.pages for q in p.quads))

    def test_nearby_column_heading_does_not_expand_figure_region(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.draw_rect(pdf_fixture.Rect(60, 100, 280, 250))
            page.insert_text((60, 280), "Figure 1: Chart.")
            page.insert_text((310, 140), "3 Results")
            page.insert_text((310, 175), "This adjacent column contains essential prose.")
            page.insert_text((310, 189), "We must preserve the complete paragraph here.")
            index = extract(pdf.tobytes())
        text = " ".join(f.text for f in index.fragments)
        self.assertIn("3 Results", text)
        self.assertIn("This adjacent column contains essential prose.", text)
        self.assertIn("We must preserve the complete paragraph here.", text)

    def test_inline_formula_near_plot_is_not_an_exterior_label(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text(
                (60, 105), "This prose explains the error calculated from observations."
            )
            page.insert_text((60, 133), "The remaining terms describe the measured result clearly.")
            page.insert_text((180, 120), "x - y", fontsize=8)
            page.draw_rect(pdf_fixture.Rect(120, 150, 400, 280))
            page.insert_text((60, 315), "Figure 1: Error over time.")
            index = extract(pdf.tobytes())
        text = " ".join(fragment.text for fragment in index.fragments)
        self.assertIn("x - y", text)
        self.assertIn("This prose explains", text)

    def test_boxed_prose_is_not_a_figure(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.draw_rect(pdf_fixture.Rect(60, 100, 520, 200))
            page.insert_text(
                (80, 130), "Theorem 1. Every bounded sequence has a convergent subsequence."
            )
            page.insert_text(
                (80, 155), "Proof. We first establish the required compactness condition."
            )
            index = extract(pdf.tobytes())
        text = " ".join(f.text for f in index.fragments)
        self.assertIn("Every bounded sequence", text)
        self.assertIn("compactness condition", text)
        self.assertFalse(index.omissions)

    def test_axes_labels_outside_plot_bounds_are_omitted(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.draw_line((120, 150), (120, 290))
            page.draw_line((120, 290), (350, 290))
            page.insert_text((60, 210), "Accuracy")
            page.insert_text((180, 310), "Reverse process steps (T - t)")
            page.insert_text((160, 180), "Legend 987")
            page.insert_text((60, 345), "Figure 1: Validation results.")
            page.insert_text((60, 380), "Results remain in the surrounding prose.")
            index = extract(pdf.tobytes())
        text = " ".join(f.text for f in index.fragments)
        for label in ("Accuracy", "Reverse process steps", "Legend 987"):
            self.assertNotIn(label, text)
        self.assertIn("surrounding prose", text)

    def test_adjacent_table_caption_does_not_split_header_rules(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((60, 85), "Table 1: Scores", fontsize=9)
            page.insert_text((300, 110), "Table 2: Adjacent results", fontsize=9)
            for y in (95, 120, 160, 200):
                page.draw_line((60, y), (301, y))
            for x, label in ((65, "Method"), (220, "Score")):
                page.insert_text((x, 110), label, fontsize=9)
            for y, value in ((145, "42"), (185, "85")):
                page.insert_text((65, y), "Variant", fontsize=9)
                page.insert_text((220, y), value, fontsize=9)
            page.insert_text((60, 250), "Body text following both tables must remain.")
            index = extract(pdf.tobytes())
        text = " ".join(fragment.text for fragment in index.fragments)
        self.assertNotIn("Method", text)
        self.assertNotIn("Variant", text)
        self.assertIn("Table 2: Adjacent results", text)
        self.assertIn("Body text following both tables must remain.", text)

    def test_caption_at_top_does_not_protect_graphic_labels(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.draw_rect(pdf_fixture.Rect(60, 100, 400, 250))
            for y, text in (
                (120, "Figure 1: Comparison"),
                (134, "TRAINING LABEL 987"),
                (148, "TEST LABEL 654"),
            ):
                page.insert_text((60, y), text)
            index = extract(pdf.tobytes())
        self.assertEqual([f.text for f in index.fragments], ["Figure 1: Comparison"])

    def test_short_caption_does_not_limit_table_width(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.insert_text((60, 110), "Table 1: Scores")
            for y, label, value in (
                (145, "Alpha", "42.5"),
                (165, "Beta", "73.2"),
                (185, "Gamma", "95.7"),
            ):
                page.insert_text((60, y), label)
                page.insert_text((230, y), value)
            index = extract(pdf.tobytes())
        self.assertEqual([f.text for f in index.fragments], ["Table 1: Scores"])
        self.assertTrue(index.omissions)

    def test_vector_interior_removed_caption_and_prose_preserved(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text((60, 80), "The experiment uses Figure 1 as a reference.")
            page.draw_rect(pdf_fixture.Rect(80, 150, 350, 290))
            page.insert_text((100, 180), "INTERNAL 98765")
            page.insert_text((60, 320), "Figure 1: Model architecture. The arrows show direction.")
            page.insert_text((60, 334), "The decoder is displayed on the right.")
            page.insert_text((60, 390), "The surrounding prose remains available.")
            payload = pdf.tobytes()
        index = extract(payload)
        text = "\n".join(fragment.text for fragment in index.fragments)
        self.assertNotIn("INTERNAL", text)
        self.assertNotIn("98765", text)
        self.assertIn("The experiment uses Figure 1 as a reference.", text)
        self.assertIn("The surrounding prose remains available.", text)
        captions = [fragment for fragment in index.fragments if fragment.kind == PDF_CAPTION]
        self.assertEqual(len(captions), 1)
        self.assertEqual(
            captions[0].text,
            "Figure 1: Model architecture. The arrows show direction.\n"
            "The decoder is displayed on the right.",
        )
        self.assertTrue(all(quad[1] > 0.38 for quad in captions[0].pages[0].quads))
        self.assertEqual(index.unavailable_pages, ())
        self.assertTrue(index.omissions)
        self.assertEqual(index, decode_index(asdict(index)))
        self.assertEqual(index, extract(payload))

    def test_caption_overlapping_detected_graphics_is_not_truncated(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.draw_rect(pdf_fixture.Rect(60, 100, 500, 300))
            page.insert_text((80, 140), "Graph labels")
            page.insert_text((60, 270), "Figure 4: First caption sentence.")
            page.insert_text((60, 284), "A second caption sentence inside the drawing boundary.")
            index = extract(pdf.tobytes())
        captions = [f for f in index.fragments if f.kind == PDF_CAPTION]
        self.assertEqual(len(captions), 1)
        self.assertIn("second caption sentence", captions[0].text)
        self.assertNotIn("Graph labels", " ".join(f.text for f in index.fragments))

    def test_body_table_reference_does_not_start_caption(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.insert_text((60, 100), "Results are reported in")
            page.insert_text((60, 114), "Table 6. In this table we report average scores.")
            page.insert_text((60, 128), "The remaining paragraph is ordinary prose.")
            index = extract(pdf.tobytes())
        self.assertFalse(any(f.kind == PDF_CAPTION for f in index.fragments))
        self.assertFalse(index.omissions)
        self.assertIn("ordinary prose", " ".join(f.text for f in index.fragments))

    def test_horizontal_rule_table_with_bottom_caption(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            for top in (100, 125, 200):
                page.draw_line((60, top), (280, top))
            for top, cells in (
                (115, ("Model", "Score")),
                (150, ("Alpha", "84.4")),
                (180, ("Beta", "88.5")),
            ):
                page.insert_text((70, top), cells[0])
                page.insert_text((220, top), cells[1])
            page.insert_text((60, 230), "Table 5: Model performance on validation tasks.")
            page.insert_text((60, 300), "Body below the caption remains intact.")
            page.insert_text((350, 150), "Adjacent column remains intact.")
            index = extract(pdf.tobytes())
        text = "\n".join(f.text for f in index.fragments)
        for value in ("Alpha", "Beta", "84.4", "88.5"):
            self.assertNotIn(value, text)
        self.assertIn("Adjacent column remains intact.", text)
        self.assertIn("Body below the caption remains intact.", text)
        self.assertTrue(any(f.kind == PDF_CAPTION and "Table 5" in f.text for f in index.fragments))

    def test_borderless_table_does_not_consume_nearby_prose(self):
        for caption_above in (True, False):
            with self.subTest(caption_above=caption_above), pdf_fixture.open() as pdf:
                page = pdf.new_page(width=600, height=800)
                page.insert_text(
                    (60, 110 if caption_above else 215),
                    "Table 1: Measurements of the validation experiments",
                )
                for y, name, score in (
                    (145, "Alpha", "42.5"),
                    (165, "Beta", "73.2"),
                    (185, "Gamma", "95.7"),
                ):
                    page.insert_text((60, y), name)
                    page.insert_text((230, y), score)
                    page.insert_text((310, y), "100")
                page.insert_text((60, 270), "The experiment used 100 samples with 3 random seeds.")
                page.insert_text(
                    (60, 284), "The discussion of these numerical results must remain."
                )
                index = extract(pdf.tobytes())
            text = "\n".join(f.text for f in index.fragments)
            self.assertNotIn("42.5", text)
            self.assertNotIn("95.7", text)
            self.assertIn("100 samples with 3 random seeds", text)
            self.assertIn("numerical results must remain", text)

    def test_image_overlay_removed_but_full_page_ocr_kept(self):
        with pdf_fixture.open() as source:
            source.new_page().insert_text((50, 100), "Raster graphic")
            image = source[0].get_pixmap().tobytes("png")
        for background in (False, True):
            with self.subTest(background=background), pdf_fixture.open() as pdf:
                page = pdf.new_page()
                area = page.rect if background else pdf_fixture.Rect(60, 80, 320, 260)
                page.insert_image(area, stream=image, keep_proportion=False)
                page.insert_text((80, 140), "OCR or overlaid 515", render_mode=3)
                page.insert_text((60, 290), "Figure 2: Image caption.")
                index = extract(pdf.tobytes())
            text = " ".join(f.text for f in index.fragments)
            self.assertEqual("515" in text, background)
            self.assertIn("Figure 2: Image caption.", text)

    def test_only_graphics_is_explicit_omission_not_missing_text_layer(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.draw_rect(pdf_fixture.Rect(60, 100, 400, 300))
            page.insert_text((100, 150), "Only interior text")
            index = extract(pdf.tobytes())
        self.assertEqual(index.fragments, ())
        self.assertTrue(index.omissions)
        self.assertEqual(index.unavailable_pages, ())

    def test_rotated_crop_keeps_caption_and_omission_geometry(self):
        indexes = []
        for rotation in (0, 90, 180, 270):
            with pdf_fixture.open() as pdf:
                page = pdf.new_page(width=600, height=800)
                page.draw_rect(pdf_fixture.Rect(90, 150, 350, 290))
                pixmap = pdf_fixture.Pixmap(pdf_fixture.csRGB, (0, 0, 40, 40), False)
                pixmap.clear_with(120)
                page.insert_image(
                    pdf_fixture.Rect(90, 150, 350, 290), pixmap=pixmap, keep_proportion=False
                )
                page.insert_text((100, 180), "INTERIOR")
                page.insert_text((70, 320), "Figure 3: Caption after rotation.")
                page.set_cropbox(pdf_fixture.Rect(50, 100, 550, 700))
                page.set_rotation(rotation)
                indexes.append(extract(pdf.tobytes()))
        for steps, index in enumerate(indexes):
            self.assertNotIn("INTERIOR", " ".join(f.text for f in index.fragments))
            self.assertEqual(index.fragments[0].kind, PDF_CAPTION)
            for base, rotated in (
                (indexes[0].omissions[0].pages[0], index.omissions[0].pages[0]),
                (indexes[0].fragments[0].pages[0], index.fragments[0].pages[0]),
            ):
                x0, y0, x1, y1 = base.quads[0]
                for _ in range(steps):
                    x0, y0, x1, y1 = 1 - y1, x0, 1 - y0, x1
                for actual, expected in zip(rotated.quads[0], (x0, y0, x1, y1)):
                    self.assertAlmostEqual(actual, expected, places=6)

    def test_omission_breaks_sentence_and_window_continuity(self):
        left_bounds, right_bounds = (0.1, 0.1, 0.8, 0.2), (0.1, 0.3, 0.8, 0.4)
        blocks = [
            SentenceBlock(
                (
                    PdfFragment(
                        "a", "The trial enrolled a group of", (CitationPage(1, (left_bounds,)),)
                    ),
                ),
                1,
                left_bounds,
                "Times",
                10,
                0.05,
                2,
                0,
            ),
            SentenceBlock(
                (
                    PdfFragment(
                        "b",
                        "participants who completed the tasks.",
                        (CitationPage(1, (right_bounds,)),),
                    ),
                ),
                1,
                right_bounds,
                "Times",
                10,
                0.05,
                2,
                0,
            ),
        ]
        self.assertEqual(len(assemble(blocks)), 1)
        fragments = assemble(blocks, omitted_regions=(CitationPage(1, ((0.1, 0.22, 0.8, 0.28),)),))
        self.assertEqual(len(fragments), 2)
        self.assertNotEqual(fragments[0].continuity, fragments[1].continuity)
        self.assertEqual(evidence_windows([asdict(f) for f in fragments], 2), [])

    def test_caption_cannot_join_prose_window(self):
        fragments = [
            asdict(
                PdfFragment(
                    "a",
                    "Figure 1: Title.",
                    (CitationPage(1, ((0.1, 0.1, 0.8, 0.2),)),),
                    PDF_CAPTION,
                )
            ),
            asdict(PdfFragment("b", "Body sentence.", (CitationPage(1, ((0.1, 0.3, 0.8, 0.4),)),))),
        ]
        self.assertEqual(evidence_windows(fragments, 2), [])
        self.assertEqual(evidence_windows(fragments, 1), fragments)


if __name__ == "__main__":
    unittest.main()
