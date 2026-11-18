import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import layouts as renderer
import manuscript_publication
from compilation import CompilationRun, layout


class CompileDiagnosticsTest(unittest.TestCase):
    def test_compile_origin_keeps_each_run_and_pass_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "main.tex"
            source.write_text("first source", encoding="utf-8")
            engine_log = root / "main.log"
            first = CompilationRun(root, source, "publish")

            def compile_pass():
                engine_log.write_text("same overflow", encoding="utf-8")
                return subprocess.CompletedProcess([], 0, "compiler output", "")

            first.run("latex", ["latex", "main.tex"], compile_pass, engine_log)
            first.run("latex", ["latex", "main.tex"], compile_pass, engine_log)
            original = first.origin()
            original_log = Path(original["passes"][-1]["engine_log_path"])
            source.write_text("second source", encoding="utf-8")
            second = CompilationRun(root, source, "publish")
            second.run("latex", ["latex", "main.tex"], compile_pass, engine_log)
            current = second.origin()
            self.assertNotEqual(original["invocation_id"], current["invocation_id"])
            self.assertNotEqual(original["main_source_sha256"], current["main_source_sha256"])
            self.assertEqual([item["pass_index"] for item in original["passes"]], [1, 2])
            self.assertEqual(original_log.read_text(), "same overflow")
            self.assertNotEqual(str(original_log), current["passes"][-1]["engine_log_path"])
            self.assertTrue(Path(original["manifest_path"]).is_file())

    def test_compile_origin_preserves_launch_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "main.tex"
            source.write_text("source", encoding="utf-8")
            run = CompilationRun(root, source, "publish")
            error = manuscript_publication.GenerationError("COMPILER_TIMEOUT", "timeout")
            with self.assertRaises(type(error)):
                run.run("latex", ["latex"], lambda: (_ for _ in ()).throw(error))
            self.assertEqual(
                error.context["compile"]["origin"]["invocation_id"], run.origin()["invocation_id"]
            )
            self.assertEqual(run.origin()["passes"][0]["error_type"], type(error).__name__)

    def test_compile_origin_identifies_an_unchanged_engine_log(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "main.tex"
            source.write_text("source", encoding="utf-8")
            engine_log = root / "main.log"
            engine_log.write_text("previous log", encoding="utf-8")
            run = CompilationRun(root, source, "publish")
            run.run(
                "latex",
                ["latex"],
                lambda: subprocess.CompletedProcess([], 1, "launch failed", ""),
                engine_log,
            )
            self.assertFalse(run.origin()["passes"][0]["engine_log_changed"])

    def test_layout_diagnostics_distinguish_material_overflow_from_other_warnings(self):
        self.assertEqual(
            layout(
                "LaTeX Warning: Label may have changed.\n"
                "Overfull \\hbox (0.2pt too wide) in paragraph"
            )["status"],
            "SUCCESS",
        )
        value = layout(
            "Overfull \\hbox (12.5pt too wide) in paragraph at lines 7--8\n"
            "A formula and its cell.\n"
            "LaTeX Warning: Float too large for page by 400.0pt on input line 9."
        )
        self.assertEqual(value["status"], "FAILED")
        self.assertEqual(
            [item["kind"] for item in value["issues"]], ["overfull_hbox", "float_too_large"]
        )
        self.assertIn("lines 7--8", value["issues"][0]["context"])

    def test_successful_tex_exit_with_overflow_does_not_publish_a_pdf(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            generation = root / "05_generation"
            generation.mkdir()
            source = generation / "full_draft_v2.tex"
            source.write_text(r"\documentclass{article}\begin{document}Evidence.\end{document}")
            source.with_suffix(".pdf").write_bytes(b"%PDF-1.5 layout diagnostic fixture")
            source.with_suffix(".log").write_text(
                "LaTeX Warning: Float too large for page by 400.0pt on input line 9."
            )
            with (
                patch.object(
                    manuscript_publication, "synchronize", return_value={"format": "latex_pdf"}
                ),
                patch.object(
                    manuscript_publication,
                    "content_report",
                    return_value={"blocking": False, "checks": []},
                ),
                patch.object(manuscript_publication, "metadata_check", return_value=[]),
                patch.object(manuscript_publication, "latex_engine", return_value="/tool/pdflatex"),
                patch.object(
                    manuscript_publication,
                    "_run",
                    return_value=subprocess.CompletedProcess([], 0, "", ""),
                ),
                patch.object(
                    manuscript_publication,
                    "_export",
                    side_effect=AssertionError("overflow must not be promoted"),
                ),
            ):
                result = manuscript_publication.publish(root)
            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(result["code"], "LATEX_LAYOUT_ERROR")
            self.assertEqual(result["compile"]["verdict"], "layout_failed")
            self.assertNotIn("deliverable", result)
            self.assertFalse((root / "06_output").exists())

    @unittest.skipUnless(shutil.which("pdflatex"), "TeX engine unavailable")
    def test_real_overheight_float_reaches_existing_refinement_as_layout_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "full_draft_v1.tex"
            original = (
                r"\documentclass{article}\begin{document}\begin{table}"
                r"\rule{10pt}{2\textheight}\caption{Complete evidence}\end{table}\end{document}"
            )
            source.write_text(original)
            result = manuscript_publication.precompile(root, source)
            self.assertEqual(result["returncode"], 0)
            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(result["layout"]["issues"][0]["kind"], "float_too_large")
            self.assertIn("longtable", str(result["errors"]))
            self.assertEqual(source.read_text(), original)

    def test_precompile_timeout_terminates_at_the_refinement_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "full_draft_v1.tex"
            source.write_text(r"\documentclass{article}\begin{document}Text.\end{document}")
            with (
                patch.object(manuscript_publication, "latex_engine", return_value="/tool/pdflatex"),
                patch.object(
                    manuscript_publication.subprocess,
                    "run",
                    side_effect=subprocess.TimeoutExpired("pdflatex", 10),
                ) as run,
            ):
                result = manuscript_publication.precompile(root, source)
            self.assertEqual(result["status"], "TIMEOUT")
            run.assert_called_once()
            self.assertEqual(run.call_args.kwargs["timeout"], 10)
            self.assertEqual(
                source.read_text(), r"\documentclass{article}\begin{document}Text.\end{document}"
            )

    @unittest.skipUnless(shutil.which("pdflatex"), "TeX engine unavailable")
    def test_precompile_reports_source_error_without_touching_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "full_draft_v1.tex"
            original = r"\documentclass{article}\begin{document}\undefinedForTest\end{document}"
            source.write_text(original)
            result = manuscript_publication.precompile(root, source)
            self.assertEqual(result["status"], "FAILED")
            self.assertIn("Undefined control sequence", str(result["errors"]))
            self.assertEqual(source.read_text(), original)
            self.assertFalse(source.with_suffix(".pdf").exists())

    @unittest.skipUnless(shutil.which("pdflatex"), "TeX engine unavailable")
    def test_template_longtable_breaks_pages_and_retains_last_row(self):
        from pypdf import PdfReader

        with tempfile.TemporaryDirectory(prefix="slr-longtable-") as folder:
            dest = Path(folder)
            renderer.copy_template_assets("neurips", dest)
            preamble = renderer.citation_preamble(
                "english",
                {
                    "citation_style": "numeric",
                    "natbib_options": "numbers,sort",
                    "bibliography_style": "unsrtnat_scholarseed",
                },
            )
            rows = "\n".join(
                rf"Row{i}&\rule{{0pt}}{{10mm}}Supported evidence\\" for i in range(1, 51)
            )
            body = (
                r"\begin{document}\begin{longtable}{p{3cm}p{8cm}}"
                r"\caption{Evidence comparison}\label{tab:T1}\\"
                r"\toprule Method&Evidence\\\midrule\endfirsthead"
                r"\toprule Method&Evidence\\\midrule\endhead"
                + "\n"
                + rows
                + "\n"
                + r"\bottomrule\end{longtable}\end{document}"
            )
            (dest / "long.tex").write_text(preamble + "\n" + body, encoding="utf-8")
            result = subprocess.run(
                ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "long.tex"],
                cwd=dest,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout[-3000:])
            pdf = PdfReader(dest / "long.pdf")
            self.assertGreater(len(pdf.pages), 1)
            self.assertIn("Row50", pdf.pages[-1].extract_text())
            self.assertNotIn("Float too large", (dest / "long.log").read_text(errors="replace"))

    @unittest.skipUnless(
        shutil.which("pdflatex") and shutil.which("xelatex"), "TeX engines unavailable"
    )
    def test_bold_math_compiles_in_both_language_templates(self):
        root = Path(__file__).resolve().parents[1]
        merge = renderer
        for language, engine in [("english", "pdflatex"), ("chinese", "xelatex")]:
            with (
                self.subTest(language=language),
                tempfile.TemporaryDirectory(prefix="slr-bm-") as folder,
            ):
                dest = Path(folder)
                if language == "english":
                    shutil.copy(root / "assets/templates/neurips/neurips_2026.sty", dest)
                preamble = merge.citation_preamble(
                    language,
                    {
                        "citation_style": "numeric",
                        "natbib_options": "numbers,sort",
                        "bibliography_style": "unsrtnat_scholarseed",
                    },
                )
                (dest / "math.tex").write_text(
                    preamble
                    + "\n"
                    + r"\begin{document}"
                    + "\n"
                    + r"\[\bm{X}=\bm{U}\bm{V}^{\top},\quad\bm{\alpha}\in\mathbb{R}^{r}\]"
                    + "\n"
                    + r"\end{document}"
                )
                result = subprocess.run(
                    [engine, "-interaction=nonstopmode", "-halt-on-error", "math.tex"],
                    cwd=dest,
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=60,
                )
                self.assertEqual(result.returncode, 0, result.stdout[-4000:] + result.stderr)
                self.assertTrue((dest / "math.pdf").is_file())

    def test_tex_output_with_non_utf8_byte_does_not_abort_publication(self):
        with tempfile.TemporaryDirectory() as d:
            result = manuscript_publication._run(
                [
                    sys.executable,
                    "-c",
                    "import sys;sys.stdout.buffer.write(b'font warning: \\xe9\\n')",
                ],
                Path(d),
                os.environ.copy(),
            )
            self.assertEqual(result.returncode, 0)
            self.assertIn("font warning:", result.stdout)
            self.assertIn("\ufffd", result.stdout)


if __name__ == "__main__":
    unittest.main()
