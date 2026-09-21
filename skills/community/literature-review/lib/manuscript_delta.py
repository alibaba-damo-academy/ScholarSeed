"""Apply one model-authored delta to the complete native v1 source."""
from writing_prompt_guidance import TASK_GUIDANCE, MANUSCRIPT_WRITING_GUIDANCE
from generation_diagnostics import GenerationError
from figure_caption import CAPTION_CONTENT_GUIDANCE

REFINE_GUIDANCE = TASK_GUIDANCE + '\n' + MANUSCRIPT_WRITING_GUIDANCE + r'''
Refine the complete assembled document once, returning a source delta.

DOCUMENT REPAIR
The sources already include the actual template, chapters and figure wrappers.
Use the confirmed outline, user instructions and full evidence to repair content,
mathematics, repetition, transitions, LaTeX, citations and caption wording.
Abstract, synthesis/summary and conclusion chapters were drafted concurrently
with the body from the plan and supplied evidence, not from the completed body.
Check their claims individually against what the body actually establishes and
revise unsupported or overstated claims; rewrite the abstract's findings to state
only what the body establishes, replacing its entire text when needed through
one exact-match delta edit.
Preserve resolved_section_languages, planned titles and section labels. Top-level
chapters use \section and direct children \subsection; when removing a repeated
parent heading, correct its descendants rather than leaving a skipped level.

ASSET RECONCILIATION
The confirmed outline owns the asset inventory, identities and section placement.
Retain one instance of each planned table and completed figure at its owner, with
its actual image path, label, supported meaning, citations and qualifications.
Chapters may have invented extra tables or figure shells: reconcile reported
asset_contract_warnings against sources and the plan. Keep the genuine completed
figure wrapper, remove a duplicate/placeholder shell, and repair its references.
Convert necessary supported content in an unplanned table into its owning prose,
with citations, rather than discarding evidence or treating it as a new asset.
Repair missing planned tables only from supplied evidence; report unresolved
content or ambiguous identities in issues instead of guessing. Captions preserve
scientific meaning, not erroneous self-numbering. Surrounding callouts use labels.
Preamble, headings and actual captions are editable. No image model, chapter
regeneration or second refinement follows; main handles unresolved issues in v2.

''' + '\n' + CAPTION_CONTENT_GUIDANCE + r'''
DELTA OUTPUT
Return one JSON object:
{"edits":[{"target":"main","before":"exact original text","after":"replacement",
           "reason":"why"}],"issues":[]}
Use actual targets from sources. Each nonempty before must match exactly once
in that target's ORIGINAL text. All edits address the same original v1; they
must not overlap. Use enough surrounding context to disambiguate repeated text.
Do not return hashes, base_version, section_updates or a rewritten manuscript.
Empty edits is valid. JSON-escape backslashes in delta strings only.
'''

def apply_delta(sources, delta):
    """Validate the entire patch before producing any modified text."""
    if not isinstance(delta,dict) or set(delta)-{'edits','issues'}:
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
