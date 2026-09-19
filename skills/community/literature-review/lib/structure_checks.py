"""Task-conditioned structure and real asset references; no semantic repair."""
import re
from task_contract import structural_contract, is_abstract


def actual_references(body, markdown=False):
    if markdown:
        body=re.sub(r'(?ms)^\s*(```|~~~).*?^\s*\1\s*$', '', body)
        body=re.sub(r'`[^`]*`','',body)
        body=re.sub(r'<!--.*?-->','',body,flags=re.S)
    else:
        body=re.sub(r'\\begin\{(verbatim|lstlisting|minted)\}.*?\\end\{\1\}','',body,flags=re.S)
        body=re.sub(r'\\verb(.).*?\1','',body)
        body=re.sub(r'(?<!\\)%[^\n]*','',body)
    return set(re.findall(r'(?<!\\)\\ref\{([^}]+)\}',body))


def outline_structure_errors(request,outline):
    tree=outline.get('outline_tree') or []
    all_nodes=[n for s in tree for n in [s,*s.get('subsections',[])]]
    rules=structural_contract(request); errors=[]
    for v in rules['forbidden_sections']:
        match=lambda n:is_abstract(n) if is_abstract(v) else n.get('title','').strip().casefold()==v['title'].strip().casefold()
        if any(match(n) for n in all_nodes): errors.append('forbidden section present: '+v['title'])
    if any(is_abstract(v) for v in rules['required_sections']):
        found=[n for n in tree if is_abstract(n)]
        if len(found)!=1 or found[0].get('section_id')!='0': errors.append('required abstract must appear exactly once as top-level section_id 0')
    return errors


def validate_body_structure(request,sections,outline,component_body=''):
    from generation_errors import GenerationError
    required=structural_contract(request)
    nodes={n['section_id']:n for n in outline.get('outline_tree',[])}
    for section in sections:
        if is_abstract(nodes.get(section['section_id'],{})):
            body=section.get('body_md','').strip()
            if not body or re.fullmatch(r'(?is)(todo|tbd|placeholder|待补充|摘要待写|\.\.\.)[.!。\s]*',body):
                raise GenerationError('SECTION_MISSING','required abstract is empty or a placeholder',section['section_id'])
    if any(is_abstract(v) for v in required['forbidden_sections']):
        text='\n'.join([s.get('body_md','') for s in sections]+[component_body])
        if re.search(r'\\begin\{abstract\}|(?im:^#{1,6}\s*(?:摘要|Abstract)\s*$)|\\(?:sub)*section\*?\{(?:摘要|Abstract)\}',text):
            raise GenerationError('SECTION_FORBIDDEN','task excludes the abstract; generated body contains an abstract')
