"""Apply one model-authored delta to the complete native v1 source."""
from writing_prompt_guidance import TASK_GUIDANCE, MANUSCRIPT_WRITING_GUIDANCE
from generation_diagnostics import GenerationError

REFINE_GUIDANCE = TASK_GUIDANCE + '\n' + MANUSCRIPT_WRITING_GUIDANCE + r'''
Refine the complete assembled document once. It already includes the actual
template, chapter bodies, completed figure wrappers and captions.
Use the confirmed outline, user instructions and full evidence. Repair content,
mathematics, repetition, transitions, duplicated headings/abstracts, malformed
LaTeX, citations and caption wording without inventing evidence.
Preserve resolved_section_languages exactly; do not translate a chapter or
standardize chapters with explicit language overrides into one language.
Chapters include their script-supplied openings. Each top-level section uses
\section and direct subheadings use \subsection. If removing a repeated parent
heading, also correct its descendants' levels; do not leave a \section followed
directly by \subsubsection. Preserve planned titles and section labels.
Unlike chapter authors, you see the assembled publication source: preserve its
real image paths, figure environments and labels; never substitute a placeholder.
You may edit the preamble, headings and actual figure captions.
Preserve their scientific meaning and planned figure identity. No image model or
second review is requested. Main will handle unresolved issues in v2.

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
