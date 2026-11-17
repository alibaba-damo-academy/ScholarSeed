"""Apply one model-authored delta to the complete native v1 source."""
from generation_diagnostics import GenerationError
from figure_caption import CAPTION_CONTENT_GUIDANCE

REFINE_GUIDANCE = r'''
Refine the complete assembled document once as a coherent whole, not independent
chapters. Follow the confirmed task and outline, including explicit exceptions,
language, document scope and requested format. Do not add excluded components.
Use the completed manuscript as the basis for editing, not for independent fact
verification. Improve organization, clarity, terminology and transitions without
introducing scientific claims, results, citations or stronger conclusions.
Preserve numbers, formulas, assumptions, attribution and qualifying conditions.
Reconcile the abstract and conclusions with what the body actually establishes.
Read the body in order: retain a concept's definition where first needed, then
use consistent terms without reintroducing it or repeating background framing.
Keep abstracts and captions self-contained where needed. Preserve scientific
meaning, distinct senses and necessary local explanations; when uncertain,
retain the meaning and report the ambiguity rather than guessing a correction.
Keep the abstract compact unless the user requests otherwise. Report specific
unresolved issues without creating an additional review stage.

The outline owns the asset inventory and placement. Retain one instance of each
planned table and completed figure with its label, citations and qualifications.
Use asset_contract_warnings to reconcile the source with that inventory.
Preserve supported content when moving it between a table and prose.
The publisher owns the reference list and metadata. Keep one bibliography entry
point and valid inline citations; do not author bibliography entries or invent
missing metadata. Resolve bibliography_warnings at that boundary.

Resolve reported compile, hierarchy and layout errors within the supplied sources.
Preserve section labels, resolved_section_languages, planned titles, actual asset
paths and reader-facing captions. Report unresolved content or ambiguous identity
in issues. Image links ending in .tex name native forest sources; preserve those
links and sources so the publisher can render the real tree for Markdown or DOCX.
This pass does not invoke another model, regenerate chapters or images,
or change the confirmed scientific scope.

''' + '\n' + CAPTION_CONTENT_GUIDANCE + r'''
DELTA RULES
Return one JSON object: {"edits":[{"target":"main","before":"exact original text",
"after":"replacement","reason":"why"}],"issues":[]}.
Targets must exist in sources. Each nonempty before matches exactly once in its
original target. All edits address the same original source and must not overlap.
Use sufficient surrounding text to identify a replacement. Omit unchanged passages.
Empty edits is valid.
Apply JSON escaping to string values. Return only this delta object.
'''

def apply_delta(sources, delta):
    """Validate the entire patch before producing any modified text."""
    if not isinstance(delta,dict) or 'edits' not in delta or set(delta)-{'edits','issues'}:
        raise GenerationError('DELTA_SCHEMA','expected edits and optional issues')
    edits=delta.get('edits',[]);issues=delta.get('issues',[])
    if not isinstance(edits,list) or not isinstance(issues,list):
        raise GenerationError('DELTA_SCHEMA','edits and issues must be arrays')
    ranges={}
    for n,e in enumerate(edits):
        if not isinstance(e,dict) or set(e)-{'target','before','after','reason'}:
            raise GenerationError('DELTA_SCHEMA',f'edit {n}: invalid fields')
        target=e.get('target');before=e.get('before');after=e.get('after')
        if not isinstance(target,str) or target not in sources:
            raise GenerationError('DELTA_INVALID',f'edit {n}: unknown source target')
        if not isinstance(before,str) or not before or not isinstance(after,str):
            raise GenerationError('DELTA_INVALID',f'edit {n}: before/after must be text, before nonempty')
        source=sources[target]
        if source.count(before)!=1:
            raise GenerationError('DELTA_INVALID',f'edit {n}: before must match exactly once in {target}')
        start=source.index(before);end=start+len(before)
        if any(a<end and b>start for a,b,_ in ranges.get(target,[])):
            raise GenerationError('DELTA_INVALID',f'edit {n}: overlapping replacements')
        ranges.setdefault(target,[]).append((start,end,after))
    result=dict(sources)
    for target,changes in ranges.items():
        for a,b,after in sorted(changes,reverse=True):
            result[target]=result[target][:a]+after+result[target][b:]
    return result,{'applied_edits':len(edits),'issues':issues}
