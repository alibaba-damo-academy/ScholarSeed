"""Topic-independent asset guidance adapted to the scripted SLR contracts.

Adapted from survey-figure-rendering/scripts/figure_prompts.py and
survey-table-generation/scripts/table_prompts.py. Keep their content/layout
principles without their scope quotas, topic templates or extra model runners.
"""

from figure_authoring import PROMPT_GUIDANCE, CAPTION_GUIDANCE

# Shared with prepared figure-author packets; no second prompt rule set.
FIGURE_DESIGN_GUIDANCE = PROMPT_GUIDANCE + '\n\n' + CAPTION_GUIDANCE

TABLE_CONTENT_GUIDANCE = r'''Design tables around the requested comparison and the
owning section's question, rather than a fixed set of domain-specific headers.
Decide what one row represents and keep that unit consistent. Choose columns
that distinguish the supplied evidence; avoid redundant or mostly unavailable
columns unless the user explicitly requires them. Do not hide requested missing
evidence by dropping a required row or column. Give rows a consistent readable
identity, using supported names or author citations; never print raw cite keys
as names. Every evidence-bearing row needs its supporting citation, and a claim
drawn from a different source needs its own attribution. Do not repeat the same
citation in every cell unnecessarily.
Use concise but sufficient cell text, clear units, and comparable definitions.
Preserve the setting and conditions of any quantitative or theoretical claim;
do not mix incompatible metrics into a ranking or attach one method's guarantee
to a different row category. Distinguish not reported, not applicable and known
absence. Never fill unknown values with plausible guesses. A caption explains
the comparison and necessary qualifications without a Table N prefix.
Return the existing structured table JSON, not LaTeX environments or column
specifications. The renderer owns booktabs, wrapping and page width. Keep the
column set focused, but use no fixed column count or per-cell length quota;
readability must not remove essential evidence. For LaTeX output, escape literal
special characters in cells/captions and keep actual mathematics in math mode;
JSON-escape backslashes. For Markdown output, use Markdown content. Tables are
part of the same whole-manuscript request; do not launch a separate table model.'''
