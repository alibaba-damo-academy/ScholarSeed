"""Figure-author inputs adapted from ORIGIN's paired prompt/caption writer.

ORIGIN: survey_test_samples/fast/.claude/skills/survey-figure-rendering.
The current pipeline uses a fresh figure author alongside whole-manuscript writing;
section intent replaces the not-yet-written section body. Evidence is lossless.
"""

from figure_caption import CAPTION_CONTENT_GUIDANCE

PROMPT_GUIDANCE = '''Write _prompt for the image model, not for a manuscript reader.
Design the visual and its caption together from one supported figure concept.
Implement the confirmed purpose, content_plan and qualifications without changing
the scientific meaning. Apply visual_guidance to its presentation.
State the central object, concrete visible elements and their short labels, their
positions/grouping, and the direction and meaning of arrows or other connections.
Describe the legend when colors or symbols encode roles. Use meaningful icons
selectively and a balanced, information-dense layout without clutter or large
empty regions. Do not copy a domain example or invent a mechanism/number to fill
space. Preserve the conditions needed to interpret the visible relations.
Default to a clean academic conceptual diagram: flat vector, white background,
simple geometric shapes, thin outlines, sans-serif labels, one color per role,
no gradients, 3D or drop shadows. Explicit user style choices take precedence.
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
Write _caption for the reader of the finished figure, paired with _prompt from
one supported concept. Use purpose/content_plan for meaning and caption_draft
as a starting point, refining it to match the planned visual. visual_guidance
belongs to the drawing, not caption prose.

For a simple conceptual diagram, normally describe the central object and its
organizing relationship in one concise sentence. Add panel/legend explanations
or supported qualifications when needed. Describe the specific visible elements
in _prompt/_latex_body; do not retell the section or survey or assert a finding
the image does not establish. Aesthetic choices, image-model behavior,
crop/watermark steps and pipeline metadata are not publication content.
Follow the requested caption language independently of in-image label exceptions.
Use third-person present tense in English and direct descriptive prose in Chinese.
''' + '\n' + CAPTION_CONTENT_GUIDANCE + '''
FIGURE CAPTION OUTPUT
Use plain Unicode prose, without LaTeX commands, citation keys or bibliography
records. Write literal special characters normally (12%, AT&T, model_v2); the
publisher escapes LaTeX and preserves Markdown. Apply JSON string escaping.
Keep _caption separate from _prompt and from the image itself. Explicit user
requirements and necessary explanation take precedence over sentence/word habits.
Generate prompt and caption once as paired fields, with no post-image caption
rewrite or semantic review call.
'''


def authoring_packet(item, task, evidence_path, preparation_id):
    return {'preparation_id':preparation_id,
            'figure':{k:item.get(k) for k in ('figure_id','section_id','section_title',
                'section_description','subsections','purpose','content_plan','caption_draft','visual_guidance','qualifications','language','paper_ids','evidence_scope')},
            'task':task,
            'section_context_source':'confirmed_outline; manuscript generation is concurrent',
            'evidence':{'path':str(evidence_path),'paper_ids':item['paper_ids'],
                        'instruction':'Read complete business fields for these IDs. Corpus fallback is a pool of eligible evidence, not a requirement to depict every paper.'},
            'prompt_guidance':PROMPT_GUIDANCE,'caption_guidance':CAPTION_GUIDANCE,
            'output':{'figure_id':item['figure_id'],'_render_mode':'image',
                      '_prompt':'<self-contained drawing instructions>',
                      '_caption':'<reader-facing publication prose>',
                      '_latex_body':None,'_image_size':'wide'}}
