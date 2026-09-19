import copy
import unittest
from writing import render_table, validate_draft
from asset_wrappers import normalize


class AssetWrappersTest(unittest.TestCase):
    def test_identical_row_evidence_survives_plain_layout_and_citation_movement(self):
        from asset_wrappers import same_evidence_grid
        actual=('ll',[[r'\hline Method','Finding'],['A',r'Conditional result \citep{First2024}']])
        expected=('XX',[['Method','Finding'],[r'A \citep{First2024}','Conditional result']])
        self.assertTrue(same_evidence_grid(actual,expected))
        self.assertTrue(same_evidence_grid((actual[0],actual[1]+[[r'\hline']]),expected))
        changed=copy.deepcopy(actual);changed[1][1][1]=r'Different result \citep{First2024}'
        self.assertFalse(same_evidence_grid(changed,expected))
        self.assertFalse(same_evidence_grid(('l@{important}l',actual[1]),expected))
        styled=(actual[0],[[r'\textbf{Method}',r'\textbf{Finding}'],*actual[1][1:]])
        self.assertTrue(same_evidence_grid(styled,expected))

    def test_literal_box_placeholder_is_externalized_but_real_box_content_is_kept(self):
        layout=r'\fbox{\parbox{0.9\textwidth}{\centering\vspace{2cm}\textbf{[Cartoon Illustration]}\vspace{2cm}}}'
        body=r'\begin{figure}[t]\centering'+layout+r'\caption{A supported relation.}\label{fig:F1}\end{figure}'
        value,notes=normalize(self.draft(body),self.context('figure'),render_table)
        self.assertTrue(notes);self.assertNotIn(r'\begin{figure}',value['body_md'])
        self.assertNotIn('A supported relation.',value['body_md'])
        self.assertTrue(any(n.get('caption_preserved')=='A supported relation.' for n in notes))
        meaningful=body.replace('[Cartoon Illustration]',r'$g_1^Tg_2<0$')
        original=self.draft(meaningful)
        self.assertEqual(normalize(original,self.context('figure'),render_table),(original,[]))
    def context(self, kind):
        item = {"section_id": "2", "section_kind": "technique", "language": "english",
                "allowed_cite_keys": ["First2024", "Second2024"], "subsections": [],
                "length_unit": "words", "length_min": 20, "insight_requirement": "required",
                "planned_figures": [], "planned_tables": []}
        if kind == "figure":
            item["planned_figures"] = [{"figure_id": "F1", "label": "fig:F1"}]
        else:
            item["planned_tables"] = [{"table_id": "T1", "label": "tab:T1", "caption": "Planned comparison",
                                       "allowed_cite_keys": ["First2024", "Second2024"]}]
        return {"item": item, "output_format": "latex_pdf"}

    def draft(self, body, tables=None):
        return {"section_id": "2", "title": "Methods",
                "body_md": "The conditions determine this comparison \\citep{First2024}.\n\n" + body + "\n\nThe evidence has limits.",
                "claims": [{"text": "A claim", "cite_keys": ["First2024"]}],
                "insights": [{"text": "The conditions differ."}], "tables": tables or []}

    def test_known_image_wrapper_keeps_expanded_caption_and_surrounding_prose(self):
        caption = r"The condition $g_1^\top g_2<0$ applies to \textbf{two} arrows."
        body = r"\begin{figure}[t]\centering\includegraphics{alternate.png}\caption{" + caption + r"}\label{fig:F1}\end{figure}"
        original = self.draft(body)
        value, notes = normalize(original, self.context("figure"), render_table)
        self.assertEqual(len(notes), 1)
        self.assertNotIn(caption, value["body_md"])
        self.assertEqual(notes[0]["caption_preserved"],caption)
        self.assertIn(r"\ref{fig:F1}", value["body_md"])
        self.assertTrue(value["body_md"].endswith("The evidence has limits."))
        self.assertEqual(value["claims"], original["claims"])
        self.assertIn(r"\begin{figure}", original["body_md"])
        self.assertFalse(validate_draft(value, self.context("figure")))

    def table(self):
        return {"table_id": "T1", "columns": ["Method", "Finding"],
                "rows": [[r"First \citep{First2024}", "A bound"], [r"Second \citep{Second2024}", "Other conditions"]]}

    def test_duplicate_table_keeps_every_structured_row(self):
        context = self.context("table")
        table = self.table()
        body = render_table(table, context["item"]["planned_tables"][0], False)
        value, notes = normalize(self.draft(body, [table]), context, render_table)
        self.assertEqual(len(notes), 1)
        self.assertEqual(value["tables"], [table])
        self.assertFalse(validate_draft(value, context))

    def test_unique_column_annotation_and_short_caption_are_not_removed(self):
        context = self.context("table")
        table = self.table()
        rendered = render_table(table, context["item"]["planned_tables"][0], False)
        from table_checks import _extract_env
        colspec = _extract_env(rendered, "tabularx")[0]
        for body in [rendered.replace("{" + colspec + "}", "{" + colspec + r"@{(95\% CI)}}"),
                     rendered.replace(r"\caption{", r"\caption[Only observational evidence]{")]:
            original = self.draft(body, [table])
            self.assertNotEqual(body, rendered)
            self.assertEqual(normalize(original, context, render_table), (original, []))

    def test_conflicting_grid_is_not_silently_removed(self):
        context = self.context("table")
        table = self.table()
        other = copy.deepcopy(table)
        other["rows"][0][1] = "Conflicting result"
        original = self.draft(render_table(other, context["item"]["planned_tables"][0], False), [table])
        value, notes = normalize(original, context, render_table)
        self.assertFalse(notes)
        self.assertEqual(value, original)
        self.assertTrue(validate_draft(value, context))

    def test_unplanned_and_complex_figures_remain_for_explicit_repair(self):
        for body in [r"\begin{figure}\includegraphics{x.png}\caption{Other}\label{fig:F9}\end{figure}",
                     r"\begin{figure}\includegraphics{F2.png}\caption{Other}\label{fig:F1}\end{figure}",
                     r"\begin{figure}\begin{tikzpicture}unique drawing\end{tikzpicture}\caption{Other}\label{fig:F1}\end{figure}"]:
            original = self.draft(body)
            value, notes = normalize(original, self.context("figure"), render_table)
            self.assertFalse(notes)
            self.assertEqual(value, original)

    def test_citation_escaping_is_repaired_without_destroying_real_line_breaks(self):
        context = self.context("figure")
        context["item"]["planned_figures"] = []
        original = self.draft(r"Evidence \\citet{First2024}. A line break\\\citep{Second2024}.")
        value, notes = normalize(original, context, render_table)
        self.assertEqual(notes[0]["kind"], "citation_escape")
        self.assertEqual(notes[0]["count"], 1)
        self.assertIn(r"Evidence \citet{First2024}", value["body_md"])
        self.assertIn(r"break\\\citep{Second2024}", value["body_md"])
        literal = self.draft(r"\verb|\\citet{First2024}|")
        self.assertEqual(normalize(literal, context, render_table), (literal, []))

if __name__ == "__main__":
    unittest.main()
