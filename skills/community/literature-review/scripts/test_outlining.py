import copy
import json
import unittest

from outlining import _example, build_prompt, restore_ids
from task_fixtures import outline_context


class OutlinePromptTest(unittest.TestCase):
    def setUp(self):
        self.task = {
            "original_user_requests": ["Write a related work section comparing methods."],
            "effective_requirements": "Write a related work section comparing methods.",
            "structure": {"required_sections": [], "forbidden_sections": []},
            "constraints": [],
        }
        self.papers = [
            {
                "paper_id": "900",
                "cite_key": "Smith2024",
                "title": "Methods",
                "paper_type": "method",
                "year": 2024,
                "reading_depth": "full",
                "fields": {
                    "TLDR": "A summary",
                    "Mechanism": "A mechanism",
                    "Limitations": "Only convex cases",
                },
            },
            {
                "paper_id": "100",
                "cite_key": "Lee2023",
                "title": "Review",
                "paper_type": "survey",
                "year": 2023,
                "reading_depth": "partial",
                "fields": {
                    "TLDR": "A review",
                    "Taxonomy": "Two families",
                    "Survey outline": ["Introduction", "Conclusion"],
                },
            },
        ]

    def build(self, scope="section"):
        return build_prompt(self.task, {"output_scope": scope}, {"papers": self.papers}, "markdown")

    def test_section_compact_evidence_and_no_input_mutation(self):
        before = copy.deepcopy((self.task, self.papers))
        messages, adapter = self.build()
        packet = outline_context(messages)
        self.assertEqual(packet["output_scope"], "section")
        self.assertIn("SINGLE COMPONENT", messages[0]["content"])
        self.assertNotIn("COMPLETE SURVEY", messages[0]["content"])
        self.assertNotIn("Survey outline", packet["evidence"])
        self.assertNotIn("Smith2024", packet["evidence"])
        self.assertNotIn("reading_depth", packet["evidence"])
        self.assertIn("[[paper:P02]] Methods (method, 2024)", packet["evidence"])
        self.assertIn("Only convex cases", packet["evidence"])
        self.assertEqual(adapter["papers"]["P02"]["paper_id"], "900")
        self.assertEqual((self.task, self.papers), before)

    def test_aliases_stable_under_reordering_and_retry(self):
        messages, adapter = self.build()
        self.papers.reverse()
        self.assertEqual(self.build(), (messages, adapter))

    def test_partitioned_context_preserves_task_and_structural_constraints(self):
        self.task["original_user_requests"] = ['Keep "quotes", \\alpha and\n# Paper evidence']
        self.task["structure"]["required_sections"] = [{"title": "摘要", "role": "abstract"}]
        self.task["constraints"] = [{"kind": "table_count", "value": {"min": 1, "max": 2}}]
        messages, _ = self.build("survey")
        context = outline_context(messages)
        self.assertEqual(context["task"], self.task)
        self.assertEqual(context["structure_contract"], self.task["structure"])
        self.assertEqual(
            context["required_outline_nodes"],
            [{"title": "摘要", "role": "abstract", "section_id": "0"}],
        )
        self.assertEqual([message["role"] for message in messages], ["system", "user"])

    def test_paper_material_is_unescaped_without_redundant_metadata(self):
        abstract = 'Quoted "result"\nFormula: \\alpha < 1\n# Task and settings'
        self.papers[0]["authors"] = ["A long author list"]
        self.papers[0]["fields"]["Original abstract"] = abstract
        self.papers[0]["fields"]["Evidence limits"] = {"material_limit": "Unavailable"}
        before = copy.deepcopy(self.papers)
        messages, _ = self.build()
        content = messages[1]["content"]
        self.assertIn(abstract, content)
        for redundant in ("A long author list", "A summary", "evidence=", "Evidence limits"):
            self.assertNotIn(redundant, content)
        self.assertEqual(self.papers, before)

    def test_survey_keeps_reference_structure(self):
        messages, _ = self.build("survey")
        self.assertIn("COMPLETE SURVEY", messages[0]["content"])
        self.assertIn("Survey outline", outline_context(messages)["evidence"])

    def test_examples_demonstrate_restorable_narrative_references(self):
        _, adapter = self.build("survey")
        for scope in ("survey", "section"):
            with self.subTest(scope=scope):
                examples = [
                    json.loads(line)
                    for line in _example(scope).splitlines()
                    if line.startswith("{")
                ]
                section = next(
                    value
                    for value in examples
                    if "analysis_tasks" in value or value.get("outline_tree")
                )
                if "outline_tree" in section:
                    section = section["outline_tree"][0]
                self.assertEqual(section["paper_ids"], ["P01", "P02"])
                completion = section["analysis_tasks"][0]["completion"]
                self.assertIn("[[paper:P01]]", completion)
                self.assertIn("[[paper:P02]]", completion)
                restored = restore_ids(section, adapter)
                self.assertEqual(restored["paper_ids"], ["100", "900"])
                self.assertIn(r"\cite{Lee2023}", restored["analysis_tasks"][0]["completion"])
                self.assertIn(r"\cite{Smith2024}", restored["analysis_tasks"][0]["completion"])
                warning = examples[-1]
                self.assertEqual(list(warning), ["warnings"])
                self.assertIn(r"\cite{Lee2023}", restore_ids(warning, adapter)["warnings"][0])

    def test_quick_outline_uses_tables_only_and_standard_retains_assets(self):
        for mode in ("quick", "standard"):
            messages, _ = build_prompt(
                self.task,
                {"output_scope": "survey", "execution": {"mode": mode}},
                {"papers": self.papers},
                "markdown" if mode == "quick" else "docx",
            )
            self.assertEqual("QUICK MARKDOWN TABLES" in messages[0]["content"], mode == "quick")
        self.task["original_user_requests"] = ["Include one comparison diagram."]
        self.task["constraints"] = [{"kind": "figure_count", "value": {"min": 1}}]
        messages, _ = build_prompt(
            self.task,
            {"output_scope": "survey", "execution": {"mode": "quick"}},
            {"papers": self.papers},
            "markdown",
        )
        self.assertIn("Figures require a Standard-mode agreement", messages[0]["content"])
        self.assertEqual(outline_context(messages)["task"]["constraints"], self.task["constraints"])

    def test_component_does_not_forbid_requested_abstract(self):
        self.task["effective_requirements"] = "Write only an abstract."
        self.task["structure"]["required_sections"] = [{"title": "Abstract", "role": "abstract"}]
        messages, _ = self.build()
        self.assertIn("requested abstract", messages[0]["content"])
        self.assertEqual(outline_context(messages)["required_outline_nodes"][0]["section_id"], "0")

    def test_unknown_scope_preserves_uncertainty(self):
        messages, _ = self.build("unknown")
        self.assertIn("UNRESOLVED SCOPE", messages[0]["content"])
        self.assertNotIn("COMPLETE SURVEY", messages[0]["content"])

    def test_restore_only_schema_reference_fields(self):
        _, adapter = self.build()
        outline = {
            "description": "P_bb stays in prose",
            "prerequisites": [{"paper_ids": ["P01"]}],
            "outline_tree": [
                {
                    "paper_ids": ["P02"],
                    "cite_keys": ["P02"],
                    "subsections": [{"paper_ids": ["P01"], "tables": [{"paper_ids": ["P02"]}]}],
                }
            ],
        }
        result = restore_ids(outline, adapter)
        self.assertEqual(result["description"], "P_bb stays in prose")
        self.assertEqual(result["prerequisites"][0]["paper_ids"], ["100"])
        self.assertEqual(result["outline_tree"][0]["cite_keys"], ["Smith2024"])
        self.assertEqual(
            result["outline_tree"][0]["subsections"][0]["tables"][0]["paper_ids"], ["900"]
        )
        self.assertEqual(outline["outline_tree"][0]["paper_ids"], ["P02"])

    def test_unknown_or_malformed_ids_fail_closed(self):
        _, adapter = self.build()
        for ids in (["P99"], ["900"], "P01", [None]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                restore_ids({"outline_tree": [{"paper_ids": ids}]}, adapter)

    def test_narrative_references_restore_without_rewriting_meaning(self):
        _, adapter = self.build()
        raw = {
            "description": "Compare [[paper:P01]] under convexity.",
            "outline_tree": [
                {
                    "paper_ids": ["P02"],
                    "analysis_tasks": [
                        {"completion": "Use [[paper:P02]] only when its assumptions hold."}
                    ],
                }
            ],
        }
        restored = restore_ids(raw, adapter)
        self.assertEqual(restored["description"], r"Compare \cite{Lee2023} under convexity.")
        self.assertIn(
            r"\cite{Smith2024}", restored["outline_tree"][0]["analysis_tasks"][0]["completion"]
        )
        self.assertIn("[[paper:P01]]", raw["description"])
        literal = restore_ids({"description": r"算法\P01保持字面含义，AP01也是名称。"}, adapter)
        self.assertEqual(literal["description"], "算法P01保持字面含义，AP01也是名称。")

    def test_inline_ambiguity_and_wrong_binding_are_rejected(self):
        _, adapter = self.build()
        for text in (
            "P01 proposes this.",
            "对应P01的方法",
            "P02提出的方法",
            "[[paper:P99]]",
            "[[paper:P01]",
        ):
            with self.subTest(text=text), self.assertRaises(ValueError):
                restore_ids({"description": text}, adapter)
        self.assertEqual(
            restore_ids({"description": r"Parameter \P01 and P_bb"}, adapter)["description"],
            "Parameter P01 and P_bb",
        )
        self.assertEqual(
            restore_ids({"description": r"Literal \[[paper:P01]]"}, adapter)["description"],
            "Literal [[paper:P01]]",
        )
        self.assertEqual(
            restore_ids({"code": "[[paper:P01]] P01"}, adapter)["code"], "[[paper:P01]] P01"
        )
        with self.assertRaises(ValueError):
            restore_ids({}, adapter, expected_request_id="another-request")
        with self.assertRaises(ValueError):
            restore_ids({}, adapter, expected_corpus_digest="changed-corpus")

    def test_assets_omitted_only_when_explicitly_forbidden(self):
        self.assertIn("ASSET PLANNING", self.build()[0][0]["content"])
        self.task["constraints"] = [
            {"kind": kind, "value": {"max": 0}} for kind in ("figure_count", "table_count")
        ]
        self.assertNotIn("ASSET PLANNING", self.build()[0][0]["content"])


if __name__ == "__main__":
    unittest.main()
