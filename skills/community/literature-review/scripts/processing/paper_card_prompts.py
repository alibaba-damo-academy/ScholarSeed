"""
Paper Card Extraction — Prompt Templates

4 种论文类型的卡片提取模板 + 通用字段模板 + 分类模板 + Delta/Ideation 模板。
KV Cache Scheme 2: SYSTEM_PROMPT (纯角色) + build_paper_prefix (论文内容放 user prefix)。
"""

# ============================================================================
# 论文类型分类 Prompt
# ============================================================================

CLASSIFY_TYPE_PROMPT = """You are a research paper classifier. Given the title and abstract below, classify this paper into exactly ONE type.

Types:
- method: Proposes a new method, model, algorithm, framework, or system as its core contribution.
- benchmark: Introduces a new dataset, evaluation benchmark, or measurement framework as its core contribution.
- survey: Provides a systematic review, survey, or meta-analysis of existing work.
- theory: Presents theoretical analysis, formal proofs, or mathematical frameworks as its core contribution.

Decision rules:
1. If the PRIMARY contribution is a new technique/model/system → method
2. If the PRIMARY contribution is a new dataset/benchmark → benchmark
3. If it systematically reviews/categorizes existing work → survey
4. If the PRIMARY contribution is theoretical (proofs, bounds) → theory
5. When ambiguous, choose what best describes the MAIN novelty claim.

Title: {title}
Abstract: {abstract}

Respond with ONLY the type name (one word): method, benchmark, survey, or theory."""


# ============================================================================
# Heading 分类 Prompt (LLM slicing mode)
# ============================================================================

HEADING_CLASSIFY_PROMPT_FULL = """You are a paper structure analyzer. Given the heading list below, define custom categories that best describe this paper's structure, then assign each heading to a category.

Rules:
1. Define 4-8 categories that fit THIS paper's actual structure (not a fixed template).
2. Category names should be descriptive (e.g. "search_space_design", "training_strategy", "multi_modal_fusion").
3. Every heading MUST be assigned to exactly one category — do not skip any.
4. You may skip trivial headings like "Acknowledgements", "References", "Appendix" by assigning them to a special category "_skip".

Heading list:
{heading_list}

Respond in JSON format: {{"category_name": [list_of_heading_indices]}}
Example: {{"introduction": [0, 1], "architecture_design": [2, 3], "training_strategy": [4, 5], "evaluation": [6, 7, 8], "conclusion": [9], "_skip": [10]}}"""

HEADING_CLASSIFY_PROMPT_PARTIAL = """You are a paper structure analyzer. Given the heading list below, identify only the MOST IMPORTANT sections for understanding this paper's core contribution.

Rules:
1. Select 3-5 categories that capture the paper's key content (introduction, core method, main results).
2. Category names should be descriptive and fit THIS paper (not a fixed template).
3. Only include headings that are essential — skip related work, appendix, acknowledgements, and peripheral sections.
4. Focus on: what problem is solved, how it's solved, and whether it works.

Heading list:
{heading_list}

Respond in JSON format: {{"category_name": [list_of_heading_indices]}}
Example: {{"problem_and_motivation": [0], "proposed_method": [3, 4, 5], "main_results": [7, 8], "conclusion": [10]}}"""


# ============================================================================
# System Prompt — 纯角色指令（不含论文内容，用于 KV Cache Scheme 2）
# ============================================================================

SYSTEM_PROMPT = """You are a research paper analyst. Extract structured information from the paper content provided. Be precise and factual — do NOT hallucinate or invent information not present in the text. If information is unavailable, write a short note like "No relevant information found" or "Not available from provided content" — NEVER leave fields as empty string "" or empty list [].

The user will provide the paper content followed by a specific extraction task. Follow the user's instructions precisely and respond only in the requested JSON format.

Format rule: When the text contains mathematical symbols, formulas, or special notation, always use LaTeX format (e.g. $\\alpha$, $\\mathcal{{L}}$, $x \\to y$). Do NOT convert LaTeX to Unicode symbols."""


# ============================================================================
# Paper Content Prefix Template (论文内容前缀，作为 user 消息的可缓存部分)
# ============================================================================

_PAPER_CONTENT_PREFIX = """Title: {title}

Paper Content:
{content}

---

"""


# ============================================================================
# Legacy System Prompt (includes paper content — kept for backward compatibility)
# ============================================================================

_CARD_SYSTEM_WITH_CONTENT = """You are a research paper analyst. Extract structured information from the paper content provided. Be precise and factual — do NOT hallucinate or invent information not present in the text. If information is unavailable, write a short note like "No relevant information found" or "Not available from provided content" — NEVER leave fields as empty string "" or empty list [].

The user will give you a specific extraction task. Follow the user's instructions precisely and respond only in the requested JSON format.

Format rule: When the text contains mathematical symbols, formulas, or special notation, always use LaTeX format (e.g. $\\alpha$, $\\mathcal{{L}}$, $x \\to y$). Do NOT convert LaTeX to Unicode symbols.

---

Title: {title}

Paper Content:
{content}"""

METHOD_CARD_PROMPT = """Extract the following structured card from this METHOD paper.

For "key_formulas": Extract core formulas in LaTeX format ONLY if the paper's contribution fundamentally relies on mathematical formulation or algorithmic logic. Include brief variable definitions. Leave as empty list [] for purely empirical, architecture-stacking, or application papers.

Respond in JSON format:
{{
  "background": "Problem domain and broader context",
  "problem": "Specific problem or limitation targeted",
  "idea": "Core intuition/insight (1-2 sentences)",
  "method": {{
    "name": "Method/model/framework name",
    "description": "How it works (3-5 sentences, min 50 chars)",
    "key_components": ["Component 1: desc", "Component 2: desc"],
    "key_formulas": ["$formula$ — description and key variable definitions"],
    "novelty": "What is new vs prior work"
  }},
  "experiments": {{
    "datasets": ["Dataset names used"],
    "baselines": ["Baseline methods compared"],
    "metrics": ["Metric 1: desc", "Metric 2: desc"],
    "key_results": "Main quantitative results with numbers",
    "ablation_findings": "Key ablation findings"
  }},
  "conclusion": "Main takeaway",
  "discussion": {{
    "strengths": ["Strength 1", "Strength 2"],
    "limitations": ["Limitation 1", "Limitation 2"],
    "future_work": "Suggested future directions"
  }},
  "other_info": "Notable info (code availability, cost, etc.)"
}}"""

BENCHMARK_CARD_PROMPT = """Extract the following structured card from this BENCHMARK paper.

Respond in JSON format:
{{
  "background": "Problem domain the benchmark addresses",
  "problem": "Gap in existing evaluation",
  "idea": "Core design philosophy (1-2 sentences)",
  "dataset": {{
    "name": "Dataset/benchmark name",
    "description": "What it contains and construction method",
    "size": "Scale info",
    "source": "Data source",
    "splits": "Train/val/test split info"
  }},
  "metrics": {{
    "primary_metrics": ["Metric 1: desc", "Metric 2: desc"],
    "evaluation_protocol": "How models are evaluated"
  }},
  "experiments": {{
    "models_evaluated": ["Model 1", "Model 2"],
    "key_findings": "Main findings from baseline evaluations",
    "human_performance": "Human baseline (if reported)"
  }},
  "conclusion": "Main takeaway about benchmark value"
}}"""

SURVEY_CARD_PROMPT = """Extract the following structured card from this SURVEY paper.

Respond in JSON format:
{{
  "background": "Research area covered",
  "problem": "Gap in understanding this survey addresses",
  "summary": {{
    "scope": "Scope of papers/methods covered",
    "taxonomy": "How the survey categorizes the field",
    "key_themes": ["Theme 1: desc", "Theme 2: desc"],
    "total_papers_reviewed": "Approximate count"
  }},
  "analysis": {{
    "trends": "Key trends identified",
    "comparisons": "Notable comparisons drawn",
    "open_problems": ["Open problem 1", "Open problem 2"]
  }},
  "discussion": {{
    "conclusions": "Main conclusions about field state",
    "future_directions": ["Direction 1", "Direction 2"],
    "recommendations": "Practical recommendations"
  }},
  "survey_outline": {{
    "sections": [
      {{"title": "Section title", "description": "What it covers", "subsections": ["sub1"]}}
    ]
  }}
}}"""

THEORY_CARD_PROMPT = """Extract the following structured card from this THEORY paper.

Respond in JSON format:
{{
  "background": "Theoretical domain and foundational concepts",
  "problem": "Theoretical question or gap addressed",
  "theorem_proof": {{
    "main_results": ["Theorem 1: statement", "Theorem 2: statement"],
    "key_assumptions": ["Assumption 1", "Assumption 2"],
    "key_formulas": ["$formula$ — description and key variable definitions"],
    "proof_technique": "Main proof technique used",
    "formal_guarantees": "Guarantees or bounds established"
  }},
  "implication": {{
    "theoretical_impact": "How this advances understanding",
    "practical_implications": "Practical implications",
    "connections": "Connections to other frameworks"
  }},
  "discussion": {{
    "strengths": ["Strength 1"],
    "limitations": ["Limitation 1"],
    "open_questions": ["Open question"]
  }}
}}"""

# Type → prompt mapping
CARD_PROMPTS = {
    "method": METHOD_CARD_PROMPT,
    "benchmark": BENCHMARK_CARD_PROMPT,
    "survey": SURVEY_CARD_PROMPT,
    "theory": THEORY_CARD_PROMPT,
}


# ============================================================================
# Common Fields Prompt
# ============================================================================

COMMON_FIELDS_PROMPT = """Extract common metadata fields from this paper.

Respond in JSON format:
{{
  "tldr": "One-sentence summary (10-50 words)",
  "research_question": "Main research question",
  "core_contribution": "Single most important contribution (1 sentence)",
  "limitations": "Key limitation",
  "innovation_points": ["Innovation 1", "Innovation 2"],
  "future_work": "Main future direction",
  "claims": ["Claim 1: specific verifiable claim", "Claim 2"]
}}"""


# ============================================================================
# Delta Extraction Prompt (method/theory 类论文专用)
# ============================================================================

DELTA_EXTRACTION_PROMPT_BASE = """Extract "strong delta" relationships between this paper (Paper B) and the specific methodological works it cites (Papers A).

A "strong delta" represents a substantive, non-trivial research advancement where:
1. Paper B cites Paper A (identified by its LaTeX `bib_id` / citation key).
2. Paper B explicitly discusses Paper A's limitations, unresolved problems, or gaps.
3. Paper B introduces a new observation, insight, or theoretical foundation that builds directly on or counteracts A.
4. Paper B evaluates its method against Paper A as an experimental baseline.
5. Paper B reports explicit quantitative/qualitative empirical gains over Paper A.

Respond in JSON only:
{{
  "deltas": [
    {{
      "cited_bib_id": "Exact LaTeX citation key (e.g., 'he2016deep')",
      "problem_attacked": "What specific limitation of Paper A does this paper address? (1-3 sentences)",
      "new_insight": "What new technical observation did Paper B uncover that Paper A missed? (1-3 sentences)",
      "methodological_pivot": "What core change did Paper B implement to surpass Paper A? (1-3 sentences)",
      "empirical_gain": "Specific datasets/metrics and quantitative improvement (e.g., 'ImageNet Top-1: 76.2% -> 78.5%')",
      "applicability_boundary": "How did Paper B expand the operational boundary of Paper A? (1-3 sentences)"
    }}
  ]
}}

Rules:
- ONLY extract papers that serve as specific methodological baselines or direct technical predecessors with explicit experimental comparison. Do NOT extract weak citations (background, motivation, related work without direct comparison).
- DO NOT extract deltas where Paper A is an industry-standard foundation model (e.g., LLaMA, GPT-4, BERT, ResNet, ViT). Only extract specialized methods designed to solve the specific task.
- cited_bib_id must exactly match the identifier in \\cite{{...}} or \\bibitem blocks.
- If a field cannot be confidently inferred, use "Not specified".
- If no strong deltas exist, return {{"deltas": []}}.
"""

_DELTA_SOURCE_MAP_ADDON = """
Additionally, include a "source_map" key in your JSON response. For each delta field (except cited_bib_id), record which sentence IDs (#N) support it.

Use "deltas[i].field_name" as keys with integer arrays as values. Per field, list 1-5 sentence IDs ordered by relevance (most relevant first). Prefer precision over coverage.

Example:
{{
  "deltas": [ ... ],
  "source_map": {{
    "deltas[0].problem_attacked": [15, 16],
    "deltas[0].new_insight": [22, 23],
    "deltas[0].methodological_pivot": [30, 31],
    "deltas[0].empirical_gain": [55, 56],
    "deltas[0].applicability_boundary": [70, 71]
  }}
}}
"""


def build_delta_prompt(with_source_map: bool = False) -> str:
    """Build delta extraction prompt, optionally including source_map instructions."""
    if with_source_map:
        return DELTA_EXTRACTION_PROMPT_BASE + _DELTA_SOURCE_MAP_ADDON
    return DELTA_EXTRACTION_PROMPT_BASE


# Keep backward-compatible name (with source_map included)
DELTA_EXTRACTION_PROMPT = DELTA_EXTRACTION_PROMPT_BASE + _DELTA_SOURCE_MAP_ADDON


# ============================================================================
# Ideation Claims Prompt (method/theory 类论文专用)
# ============================================================================

IDEATION_CLAIMS_PROMPT = """Extract idea-generation claims from this paper for downstream research ideation.

Focus on claims that are specific, verifiable, and useful for generating new research ideas. Cover diverse aspects: methods, results, limitations, mechanisms, assumptions, comparisons, and future directions.

Respond in JSON only:
{{
  "idea_claims": [
    {{
      "claim": "one compact, specific, verifiable claim (max 50 words)",
      "role_hint": "anchor|pressure|component|bridge|uncertain",
      "source_ids": [23, 24]
    }}
  ]
}}

Role hints (ONLY these 5 values are valid):
- anchor: existing method, theory, baseline, artifact, result, or prior reference point.
- pressure: limitation, gap, failure, tradeoff, open question, assumption, or future work/direction.
- component: reusable mechanism, method part, workflow unit, empirical pattern, metric, dataset/task property, or theory fragment.
- bridge: explicit mapping, analogy, transfer relation, or connection between concepts/domains/methods.
- uncertain: useful claim but role is unclear.

Rules:
- Extract 4-8 claims; never more than 8, fewer than 4 only if paper has very few useful claims.
- Each "claim" MUST be at most 50 words. Be concise and specific.
- role_hint MUST be exactly one of: anchor, pressure, component, bridge, uncertain. No other values allowed.
- Cover diverse role_hint types; do not only extract the main contribution.
- source_ids: array of 1-3 integer sentence IDs (#N) from the paper that directly support this claim.
- Omit unsupported, vague, or duplicate claims.
"""


# ============================================================================
# Source Map Fields (per paper_type)
# ============================================================================

_SOURCE_MAP_FIELDS = {
    "method": [
        "card.background", "card.problem", "card.idea", "card.conclusion",
        "card.method.description", "card.method.key_components[i]",
        "card.method.key_formulas[i]", "card.method.novelty",
        "card.experiments.key_results", "card.experiments.ablation_findings",
        "card.discussion.strengths[i]", "card.discussion.limitations[i]",
        "card.discussion.future_work",
        "common_fields.core_contribution", "common_fields.claims[i]",
        "common_fields.limitations", "common_fields.innovation_points[i]",
        "common_fields.future_work",
    ],
    "survey": [
        "card.background", "card.problem",
        "card.summary.taxonomy", "card.summary.key_themes[i]",
        "card.analysis.trends", "card.analysis.comparisons",
        "card.analysis.open_problems[i]",
        "card.discussion.conclusions", "card.discussion.future_directions[i]",
        "card.discussion.recommendations",
        "common_fields.core_contribution", "common_fields.claims[i]",
        "common_fields.limitations", "common_fields.innovation_points[i]",
        "common_fields.future_work",
    ],
    "benchmark": [
        "card.background", "card.problem", "card.idea", "card.conclusion",
        "card.experiments.key_findings",
        "common_fields.core_contribution", "common_fields.claims[i]",
        "common_fields.limitations", "common_fields.innovation_points[i]",
        "common_fields.future_work",
    ],
    "theory": [
        "card.background", "card.problem",
        "card.discussion.strengths[i]", "card.discussion.limitations[i]",
        "card.discussion.open_questions[i]",
        "common_fields.core_contribution", "common_fields.claims[i]",
        "common_fields.limitations", "common_fields.innovation_points[i]",
        "common_fields.future_work",
    ],
}

_SOURCE_MAP_INSTRUCTION = """
=== Task 3: Source Map (Provenance Tracking) ===
While extracting the card and common_fields above, you should have noted which sentences (#N) each field's content was derived from. Now record those mappings.

Fields to trace:
{fields_list}

Rules:
- For array fields marked with [i], use the actual index: e.g. "card.discussion.limitations[0]", "common_fields.claims[1]"
- Values are arrays of integer sentence IDs: e.g. [42, 43, 55]
- ONLY trace the fields listed above. Do NOT add extra fields not in this list.
- Only include fields that have non-empty content in the card/common_fields above
- Per field, list 1-5 sentence IDs from which that field was primarily derived. Prefer fewer precise IDs over many loosely related ones — 2 exact matches are better than 8 vague ones. Place the strongest supporting sentence first.

Add "source_map" as a third top-level key in your JSON response."""


# ============================================================================
# Helper Functions
# ============================================================================

def build_system_prompt(title: str = None, content: str = None) -> str:
    """Legacy helper — returns old-style system prompt with content embedded.

    Kept for backward compatibility. New code should use SYSTEM_PROMPT + build_paper_prefix().
    """
    if title and content:
        return _CARD_SYSTEM_WITH_CONTENT.format(title=title, content=content)
    return SYSTEM_PROMPT


def build_paper_prefix(title: str, content: str) -> str:
    """Build the paper content prefix for user messages (KV Cache Scheme 2).

    This is the cacheable part — identical across all extraction tasks for the same paper.
    The gateway's KV cache picks up this common prefix after the warmup request.
    """
    return _PAPER_CONTENT_PREFIX.format(title=title, content=content)


def build_user_prompt(title: str, content: str, task_prompt: str) -> str:
    """Build complete user prompt = paper prefix + task instruction."""
    return build_paper_prefix(title, content) + task_prompt


def build_combined_card_prompt(paper_type: str, with_source_map: bool = False) -> str:
    """Build combined card + common_fields (+ optional source_map) extraction prompt.

    Args:
        paper_type: One of method/benchmark/survey/theory.
        with_source_map: If True, include source_map as a third extraction task.
    """
    card_prompt = CARD_PROMPTS[paper_type]

    if not with_source_map:
        return f"""Complete the following TWO extraction tasks. Return a single JSON with exactly two top-level keys: "card" and "common_fields".

=== Task 1: {paper_type.upper()} Card ===
{card_prompt}

=== Task 2: Common Metadata ===
{COMMON_FIELDS_PROMPT}

IMPORTANT: Your response must be a single JSON object with this structure:
{{
  "card": {{ ... fields from Task 1 ... }},
  "common_fields": {{ ... fields from Task 2 ... }}
}}"""

    fields = _SOURCE_MAP_FIELDS.get(paper_type, _SOURCE_MAP_FIELDS["method"])
    fields_list = "\n".join(f"- {f}" for f in fields)
    source_map_section = _SOURCE_MAP_INSTRUCTION.format(fields_list=fields_list)
    return f"""Complete the following THREE extraction tasks. Return a single JSON with exactly three top-level keys: "card", "common_fields", and "source_map".

=== Task 1: {paper_type.upper()} Card ===
{card_prompt}

=== Task 2: Common Metadata ===
{COMMON_FIELDS_PROMPT}

{source_map_section}

IMPORTANT: Your response must be a single JSON object with this structure:
{{
  "card": {{ ... fields from Task 1 ... }},
  "common_fields": {{ ... fields from Task 2 ... }},
  "source_map": {{ "card.field.path": [sentence_ids], ... }}
}}"""


def get_card_prompt(paper_type: str) -> str:
    """Return the task-specific card prompt for the given paper type (used as user prompt)."""
    if paper_type not in CARD_PROMPTS:
        raise ValueError(f"Unknown paper_type: {paper_type}. Must be one of: {list(CARD_PROMPTS.keys())}")
    return CARD_PROMPTS[paper_type]
