"""Lossless structural normalization against explicit confirmed identities."""
import copy
import re
from generation_errors import GenerationError


def outline_assets(outline):
    result = copy.deepcopy(outline)
    if not result.get('outline_tree') and result.get('description'):
        for table in result.get('tables',[]):
            if not isinstance(table,dict) or table.get('section_id') is not None:
                raise GenerationError('OUTLINE_MISMATCH','standalone component tables must have no section owner')
        return result
    for kind in ('figures','tables'):
        if not result.get(kind):
            result.pop(kind, None); continue
        raise GenerationError('OUTLINE_MISMATCH',
                              'sectioned outlines require figures/tables nested under their owning section or subsection; root assets are not accepted',kind)
    for section in result.get('outline_tree',[]):
        if isinstance(section,dict):section.setdefault('language','default')
    return result


def title_key(text):
    # Typography only, never fuzzy matching or semantic title replacement.
    return re.sub(r'[\s\-–—]+',' ',text.replace(r'\&','&')).strip().casefold()


def manuscript(value, outline, markdown=False):
    from writing_contract import section_label
    value=copy.deepcopy(value);sections=value.get('sections')
    if not isinstance(sections,list) or any(not isinstance(x,dict) for x in sections):return value,[]
    parents=outline.get('outline_tree',[])
    top={s['section_id']:s for s in parents}
    child_owner={c['section_id']:s['section_id'] for s in parents for c in s.get('subsections',[])}
    grouped=[];seen=set();notes=[]
    for section in sections:
        sid=section.get('section_id')
        if sid in seen or not isinstance(section.get('body_md'),str):return value,[]
        seen.add(sid)
        if sid in top:grouped.append(copy.deepcopy(section))
        elif sid in child_owner and grouped and grouped[-1]['section_id']==child_owner[sid]:
            # A detached child is appended in its submitted order; text is never dropped.
            grouped[-1]['body_md']+='\n\n'+section['body_md'];notes.append('folded child '+sid)
        else:return value,[]
    if [s['section_id'] for s in grouped]!=list(top):return value,[]
    for section in grouped:
        sid=section['section_id'];node=top[sid];body=section['body_md']
        if markdown:continue
        if title_key(node['title']) in ('abstract','摘要'):
            envelope=re.fullmatch(r'\s*\\begin\{abstract\}(.*?)\\end\{abstract\}\s*',body,re.S)
            if envelope:
                body=envelope[1].strip();notes.append('removed duplicate abstract envelope')
        # The model sometimes doubles every LaTeX slash in the JSON string.
        # Do not globally unescape: row breaks and math can legitimately use \\.
        # Normalize only recognizable section commands and their adjacent labels.
        pattern=r'(?m)^[ \t]*\\+(?:sub)*section\*?\{([^{}]+)\}(?:\s*\\+label\{([^{}]+)\})?'
        aliases={};wanted={title_key(c['title']):c for c in node.get('subsections',[])}
        def heading(match):
            key=title_key(match[1]);old=match[2]
            if key==title_key(node['title']):
                if old:aliases[old]=section_label(sid)
                notes.append('removed publisher heading '+sid)
                return ''
            if key in wanted:
                child=wanted[key];label=section_label(child['section_id'])
                if old:aliases[old]=label
                return r'\subsection{'+child['title']+'}'+r'\label{'+label+'}'
            return match[0]
        body=re.sub(pattern,heading,body)
        body=re.sub(r'\\ref\{([^}]+)\}',lambda m:r'\ref{'+aliases.get(m[1],m[1])+'}',body)
        section['body_md']=body.strip()
    value['sections']=grouped
    return value,notes
