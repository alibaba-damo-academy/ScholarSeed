"""Offline title/caption boundary checks; no App, model or network calls."""

import json
import unittest
from pathlib import Path

import test_native_pipeline as native
from figure_caption import caption_latex
from manuscript import prepare
from native_document import assemble, chapter_frame, complete_chapter
from task_contract import atomic_json


class TitleTest(unittest.TestCase):
    def test_chapter_and_abstract_titles_do_not_use_caption_numbering_rules(self):
        for title in ("图、原型与对比结构方法", "表、图与评估协议", "Table: a data abstraction"):
            for role in ("analysis", "abstract"):
                with self.subTest(title=title, role=role):
                    section = {"section_id": "7", "title": title, "role": role}
                    frame = chapter_frame(section, "latex_pdf")
                    self.assertIn("{" + title + "}", frame["chapter_opening"])
                    if role == "analysis":
                        self.assertIn(r"\label{sec:s7}", frame["chapter_opening"])
                    else:
                        self.assertEqual(frame["chapter_closing"], "\n\\end{abstract}\n")
                    self.assertEqual(
                        chapter_frame(section, "markdown")["chapter_opening"],
                        "## " + title + "\n\n",
                    )

    def test_titles_still_require_plain_prose_and_escape_latex_once(self):
        section = {
            "section_id": "7",
            "role": "analysis",
            "title": r"图、AT\&T 与 model\_v2：12\% 与 $5、{边界}、~ 和 ^",
        }
        expected = r"图、AT\&T 与 model\_v2：12\% 与 \$5、\{边界\}、\textasciitilde{} 和 \textasciicircum{}"
        self.assertIn(
            r"\section{" + expected + "}", chapter_frame(section, "latex_pdf")["chapter_opening"]
        )
        for title in (
            "",
            "  ",
            None,
            r"Title \input{other}",
            r"\section{Injected}",
            "First\n\nSecond",
        ):
            with self.subTest(title=title):
                with self.assertRaisesRegex(ValueError, "title"):
                    chapter_frame({**section, "title": title}, "latex_pdf")

    def test_document_and_chapter_titles_survive_prepare_and_assembly(self):
        fixture = native.NativeTest()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        title = "图、原型与对比结构方法"
        fixture.outline["survey_title"] = title
        fixture.outline["outline_tree"][1]["title"] = title
        atomic_json(fixture.ws / "04_outline/outline.json", fixture.outline)
        prepare(fixture.ws)
        internal = fixture.ws / "05_generation/_internal"
        index = json.loads((internal / "chapter_packets.json").read_text())
        packets = [json.loads(Path(row["path"]).read_text()) for row in index["packets"]]
        for packet in packets:
            sid = packet["chapter_ids"][0]
            path = fixture.ws / "05_generation/chapters" / f"{sid}.tex"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(complete_chapter(packet, r"Supported evidence \citep{Keyp1}."))
        spec = json.loads((internal / "manuscript_contract.json").read_text())["publication"]
        text = assemble(fixture.ws, fixture.outline, packets, spec, [])
        self.assertIn(r"\title{" + title + "}", text)
        self.assertIn(r"\section{" + title + "}", text)
        self.assertIn(r"\label{sec:s1}", text)
        self.assertEqual(text.count(r"\citep{Keyp1}"), 3)
        self.assertEqual(
            json.loads((fixture.ws / "04_outline/outline.json").read_text()), fixture.outline
        )

    def test_caption_numbering_and_plain_text_guards_remain_strict(self):
        for caption in (
            "图1：方法",
            "表二：方法比较",
            "Figure 2 shows results",
            "Table 1: Results",
            "图、原型",
        ):
            with self.subTest(caption=caption):
                with self.assertRaisesRegex(ValueError, "numbering prefix"):
                    caption_latex(caption)
        for caption in ("", r"Results \input{file}", "First\n\nSecond"):
            with self.subTest(caption=caption):
                with self.assertRaisesRegex(ValueError, "_caption"):
                    caption_latex(caption)
        self.assertEqual(caption_latex(r"12\% on AT\&T model\_v2."), r"12\% on AT\&T model\_v2.")


if __name__ == "__main__":
    unittest.main()
