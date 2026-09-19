"""Figure-author inputs adapted from ORIGIN's paired prompt/caption writer.

ORIGIN: survey_test_samples/fast/.claude/skills/survey-figure-rendering.
The current pipeline uses a fresh figure author alongside whole-manuscript writing;
section intent replaces the not-yet-written section body. Evidence is lossless.
"""

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

CAPTION_GUIDANCE = '''Write _caption for a reader looking at the finished figure.
It is distinct from the drawing instructions in _prompt. Use the outline's
caption_draft as a reader-facing starting point, refining it to match the planned visual. Use purpose and content_plan
for meaning; visual_guidance is for the drawing, never caption prose. Use third person and present tense
in English; use direct descriptive prose in Chinese. Follow the requested caption
language independently of any local exception for in-image labels.
For a simple conceptual diagram, normally use one concise sentence naming the
central object and organizing axis or relationship. Add sentences only when the
reader needs a panel/legend explanation or a supported qualification. A detailed
caption refers to the specific visible elements designed in _prompt/_latex_body;
it does not retell the section, summarize the whole survey, or add a finding the
image does not establish. Do not report layout/style instructions, colors chosen
only for aesthetics, image-model behavior, crop/watermark steps or task metadata.
No "Figure N:", "Fig.", "图 N：" or other numbering prefix: the publisher adds it.
Use plain Unicode prose, not LaTeX commands, citation keys or bibliography records.
Write literal percentages/special characters normally (12%, AT&T, model_v2); the
publisher escapes them for LaTeX and preserves them in Markdown. JSON string
escaping still applies. Do not place this caption inside _prompt or the image.
No fixed sentence/word quota overrides a user's explicit requirement or a
necessary explanation of the visual. Generate the prompt and caption once as
paired fields, without a post-image caption rewrite or semantic review call.'''


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
