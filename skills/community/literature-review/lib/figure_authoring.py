"""Figure-author inputs adapted from ORIGIN's paired prompt/caption writer.

ORIGIN: survey_test_samples/fast/.claude/skills/survey-figure-rendering.
The current pipeline uses a fresh figure author alongside whole-manuscript writing;
section intent replaces the not-yet-written section body. Evidence is lossless.
"""

from figure_caption import CAPTION_CONTENT_GUIDANCE

RENDERING_CONTRACT = {
    'selection': 'Choose a supported mode that preserves the confirmed scientific content. '
                 'Honor explicit user mode and size requirements; the examples do not select a mode.',
    'modes': {
        'image': {'required': ['_prompt', '_caption'], 'optional': ['_image_size']},
        'forest_taxonomy': {'required': ['_latex_body', '_caption']},
        'data_chart': {'required': ['_chart_spec', '_caption'],
                       'chart_fields': ['statistic', 'chart_type', 'x_label', 'y_label']},
    },
    'nonapplicable_fields': 'Use null for fields belonging to a different mode.',
}

PROMPT_GUIDANCE = '''For image mode, write _prompt for the image model, not for a manuscript reader.
Design the visual and its caption together from one supported figure concept.
Implement the confirmed purpose, content_plan and qualifications without changing
the scientific meaning. Apply visual_guidance to its presentation.
For an overview, design the page before detailing individual objects. Give the
reader clear groups to compare: aligned headings, balanced panel widths, similar
scale for peer mechanisms and even gutters. A pale tint can hold a family of
methods together; a shared band can introduce context or give a synthesis.
Choose the arrangement that suits the question and the user's preferred layout.
Draw a recognizable operation inside each group. Put a few short labels beside
their objects. Give a crowded group more room or move secondary detail into
prose. Use natural reading order. A short connector can clarify a meaningful
flow; panel membership and alignment already communicate many relationships.
Leave line routing to the illustrator. Use a key only if readers need one.

Default editorial style: paper white, charcoal lettering, fine ink contours
and a clear sans-serif hierarchy. Use deep green (#2C5545) and slate blue
(#64848A) on peer groups, with terracotta (#AC7058) or ochre (#C58B2B) as
a selective accent. Use light panel washes, restrained outlines and small
concrete illustrations within the shared grid. Let labels or distinct
silhouettes carry the distinction in grayscale. At print width each panel
should have one clear point of entry and enough room around its text.

Explicit user style choices take precedence. Write the requested style into
the applicable image prompt, including concrete drawing cues (for a cartoon,
for example, expressive silhouettes and clear ink contours). Adapt the default
palette and treatment to the request while preserving scientific relationships.
The prompt and in-image labels follow the requested language and local exceptions;
keep method/model/dataset proper names recognizable. If bilingual labels help,
use Chinese (English) consistently within a level rather than English (Chinese).
Write all relevant user decisions into this self-contained _prompt: the raster
API receives only this field, not the task, evidence, figure IDs or caption.
Do not include the publication caption, a standalone title, citation keys,
bibliography entries, filesystem paths or LaTeX commands. The publisher adds the
figure caption, numbering and ScholarSeed watermark outside model generation.
Use enough detail to specify this drawing; do not pad to a word-count target.'''

CAPTION_GUIDANCE = '''FIGURE CAPTION ROLE
Write _caption for the reader of the finished figure, paired with the selected visual specification from
one supported concept. Use purpose/content_plan for meaning and caption_draft
as a starting point, refining it to match the planned visual. visual_guidance
belongs to the drawing, not caption prose.

For a conceptual figure, give the reader a compact standalone explanation.
Use one or two sentences: introduce the subject, then explain the most useful
contrast, connection or condition in the picture. Around 25–45 English words
is a practical budget; in Chinese use one or two comparably informative sentences.
Adjust to the complexity and language instead of padding to a quota.
Put necessary symbol keys on the artwork. Keep the panel inventory and
line-by-line walkthrough out of the caption. The surrounding prose develops
the mechanism and evidence. Retain essential units, uncertainty definitions
and explicit venue or user rules.
Follow the requested caption language independently of in-image label exceptions.
Use third-person present tense in English and direct descriptive prose in Chinese.
''' + '\n' + CAPTION_CONTENT_GUIDANCE + '''
FIGURE CAPTION OUTPUT
Use plain Unicode prose, without LaTeX commands, citation keys or bibliography
records. Write literal special characters normally (12%, AT&T, model_v2); the
publisher escapes LaTeX and preserves Markdown. Apply JSON string escaping.
Keep _caption separate from _prompt and from the image itself. Explicit user
requirements and necessary explanation take precedence over sentence/word habits.
Generate visual specification and caption once as paired fields, with no post-image caption
rewrite or semantic review call.
'''


def authoring_packet(item, evidence_path, preparation_id):
    return {'preparation_id':preparation_id,
            'figure':{k:item.get(k) for k in ('figure_id','section_id','section_title',
                'section_description','subsections','purpose','content_plan','caption_draft','visual_guidance','qualifications','language','cite_keys','evidence_scope')},
            'section_context_source':'confirmed_outline; manuscript generation is concurrent',
            'evidence':{'path':str(evidence_path),'cite_keys':item['cite_keys'],
                        'instruction':'Read complete records keyed by these citation keys. Select relevant evidence from the eligible pool.'},
            'output':{'figure_id':item['figure_id'],
                      'contract':'Use the shared rendering_contract, prompt_guidance and caption_guidance from figure_brief.json.',
                      **{key:item[key] for key in ('_render_mode', '_image_size') if item.get(key)}}}
