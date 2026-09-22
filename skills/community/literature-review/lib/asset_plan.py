"""Confirmed outline is the only authority for figure/table plans and callouts."""
from __future__ import annotations
import copy
import re

PLAN_VERSION = 1


def owners(outline):
    tree=outline.get('outline_tree') or []
    for section in tree:
        yield section
        yield from section.get('subsections',[])
    if not tree and outline.get('description'):
        yield {'section_id':None,'title':outline.get('survey_title',''),
               'description':outline['description'],'tables':outline.get('tables',[])}


def plan_errors(outline, allowed):
    errors=[];seen=set();tree=outline.get('outline_tree') or []
    if tree and (outline.get('figures') or outline.get('tables')):
        errors.append('root assets need a named owning section; nest them in outline_tree')
    if not tree and outline.get('figures'):
        errors.append('standalone figures need a named owning section; root tables are reserved for table-only components')
    for node in owners(outline):
        sid=node.get('section_id')
        for kind,prefix,id_key in [('figures','F','figure_id'),('tables','T','table_id')]:
            values=node.get(kind,[])
            if not isinstance(values,list):errors.append(f'{sid}/{kind}: expected array');continue
            for i,asset in enumerate(values):
                where=f'{sid}/{kind}/{i}'
                if not isinstance(asset,dict):errors.append(where+': expected asset object');continue
                aid=asset.get(id_key)
                if not isinstance(aid,str) or not re.fullmatch(prefix+r'\d+',aid):errors.append(where+': invalid '+id_key)
                elif aid in seen:errors.append(f'duplicate {kind[:-1]} id {aid!r}')
                else:seen.add(aid)
                if 'section_id' in asset and asset['section_id']!=sid:errors.append(where+': section_id conflicts with nesting')
                if 'caption' in asset:errors.append(where+': split old caption into purpose, content_plan, caption_draft and visual_guidance')
                for field in ('purpose','content_plan','caption_draft'):
                    if not isinstance(asset.get(field),str) or not asset[field].strip():errors.append(where+': nonempty '+field+' required')
                if isinstance(asset.get('caption_draft'),str):
                    from figure_caption import caption_errors
                    errors.extend(where+': '+e for e in caption_errors(asset['caption_draft'], field='caption_draft'))
                pids=asset.get('paper_ids')
                if not isinstance(pids,list) or any(not isinstance(pid,str) for pid in pids):errors.append(where+': paper_ids must be an array of source IDs')
                elif set(pids)-set(allowed):errors.append(where+': paper_ids absent from selected evidence: '+str(sorted(set(pids)-set(allowed))))
                if 'qualifications' in asset and (not isinstance(asset['qualifications'],list) or any(not isinstance(x,str) or not x.strip() for x in asset['qualifications'])):
                    errors.append(where+': qualifications must be nonempty strings')
                if kind=='figures':
                    if not isinstance(asset.get('visual_guidance',''),str):errors.append(where+': visual_guidance must be text')
                    if any(k in asset for k in ('_prompt','_latex_body','_caption','rows','columns')):errors.append(where+': detailed rendering/content belongs to authoring, not outline planning')
                else:
                    unit=asset.get('row_unit');dims=asset.get('comparison_dimensions')
                    if not isinstance(unit,str) or not unit.strip():errors.append(where+': row_unit required')
                    if not isinstance(dims,list) or any(not isinstance(x,str) or not x.strip() for x in dims):errors.append(where+': comparison_dimensions must be an array of nonempty strings')
                    elif isinstance(unit,str) and len(set([unit,*dims]))!=len(dims)+1:errors.append(where+': table column labels must be distinct')
                    if any(k in asset for k in ('rows','columns','_prompt','_caption')):errors.append(where+': do not put final table cells or authoring fields in the outline')
    return errors


def derive(outline):
    result={'version':PLAN_VERSION,'shared_figures':[],'shared_tables':[],'required_asset_refs':{}}
    for node in owners(outline):
        sid=node.get('section_id')
        for kind,id_key,label_prefix in [('figures','figure_id','fig:'),('tables','table_id','tab:')]:
            for asset in node.get(kind,[]):
                plan={**copy.deepcopy(asset),'section_id':sid,'section_title':node.get('title',''),
                      'label':label_prefix+asset[id_key]}
                result['shared_'+kind].append(plan)
                # A standalone table is the requested component itself; it does
                # not need invented prose referring to itself.
                if sid is not None:result['required_asset_refs'].setdefault(sid,[]).append(plan['label'])
    return result


def table_columns(plan):
    return [plan['row_unit'],*plan['comparison_dimensions']]


def prose_text(body, markdown):
    if markdown:
        body=re.sub(r'(?ms)^\s*(```|~~~).*?^\s*\1\s*$',lambda m:re.sub(r'[^\n]',' ',m[0]),body)
        body=re.sub(r'(?<!`)(`+)(?!`)(.*?)\1(?!`)',lambda m:re.sub(r'[^\n]',' ',m[0]),body,flags=re.S)
        body=re.sub(r'<!--.*?-->',lambda m:re.sub(r'[^\n]',' ',m[0]),body,flags=re.S)
        body=re.sub(r'<(table|figure|figcaption)\b[^>]*>.*?</\1>',lambda m:re.sub(r'[^\n]',' ',m[0]),body,flags=re.S|re.I)
        body=re.sub(r'(?m)^\s*\|.*$',lambda m:re.sub(r'[^\n]',' ',m[0]),body)
    else:
        body=re.sub(r'\\verb\*?([^\w\s]).*?\1',lambda m:re.sub(r'[^\n]',' ',m[0]),body)
        body=re.sub(r'\\begin\{(figure\*?|table\*?|verbatim|lstlisting|minted)\}.*?\\end\{\1\}',lambda m:re.sub(r'[^\n]',' ',m[0]),body,flags=re.S)
        body=re.sub(r'(?<!\\)%[^\n]*',lambda m:re.sub(r'[^\n]',' ',m[0]),body)
    return body


def section_bodies(outline,sections,markdown):
    """Top-level owners include their children; child owners use only that child."""
    supplied={s.get('section_id'):s.get('body_md','') for s in sections if isinstance(s,dict)}
    result={}
    for node in outline.get('outline_tree',[]):
        sid=node['section_id'];body=supplied.get(sid,'')
        body=prose_text(body,markdown) if isinstance(body,str) else ''
        result[sid]=body
        pattern=r'(?m)^###\s+(.+?)\s*$' if markdown else r'\\subsection\{([^}]+)\}'
        headings=list(re.finditer(pattern,body))
        for child in node.get('subsections',[]):
            for index,heading in enumerate(headings):
                if heading[1].strip()==child['title'].strip():
                    stop=headings[index+1].start() if index+1<len(headings) else len(body)
                    result[child['section_id']]=body[heading.end():stop]
                    break
    return result


def inline_asset_issues(sections,markdown,component_body=''):
    issues=[]
    entries=[*sections,*([{'section_id':None,'body_md':component_body}] if component_body else [])]
    for section in entries:
        body=section.get('body_md','')
        if not isinstance(body,str):continue
        if markdown:
            body=re.sub(r'(?ms)^\s*(```|~~~).*?^\s*\1\s*$',lambda m:re.sub(r'[^\n]',' ',m[0]),body)
            body=re.sub(r'(?<!`)(`+)(?!`)(.*?)\1(?!`)',lambda m:re.sub(r'[^\n]',' ',m[0]),body,flags=re.S)
            body=re.sub(r'<!--.*?-->','',body,flags=re.S)
            found=bool(re.search(r'!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])|<(?:table|figure|img)\b',body,re.I))
            lines=body.splitlines()
            for i,line in enumerate(lines[1:],1):
                cells=line.strip().strip('|').split('|')
                if ('|' in line or '|' in lines[i-1]) and cells and all(re.fullmatch(r':?-{3,}:?',cell.strip()) for cell in cells):
                    found=True
        else:
            body=prose_text(body,False)
            found=bool(re.search(r'\\(?:input|include|subfile)\b|\\begin\{(?:tikzpicture|forest)\}',body))
        if found:issues.append({'code':'ASSET_INLINE','asset_id':None,'section_id':section.get('section_id'),
            'message':'unplanned inline assets or external asset includes are not allowed; use planned structured tables and figure callouts'})
    return issues


def reference_issues(asset_plan,outline,sections,markdown,component_body=''):
    from structure_checks import actual_references
    blocks=section_bodies(outline,sections,markdown)
    if not outline.get('outline_tree'):blocks[None]=prose_text(component_body,markdown)
    references={sid:actual_references(body,markdown) for sid,body in blocks.items()}
    planned={a['label']:a for a in [*asset_plan['shared_figures'],*asset_plan['shared_tables']]}
    issues=inline_asset_issues(sections,markdown,component_body)
    for sid,labels in asset_plan['required_asset_refs'].items():
        for label in labels:
            if label not in references.get(sid,set()):
                issues.append({'code':'REF_MISSING','asset_id':label,'section_id':sid,
                    'location':f'sections/{sid}/body_md','message':f'missing planned asset reference {label} in owning section {sid}',
                    'found_in_sections':[s for s,refs in references.items() if label in refs]})
    for section in sections:
        sid=section.get('section_id')
        if not isinstance(sid,str):continue
        for label in references.get(sid,set()) & set(planned):
            owner=planned[label]['section_id']
            if owner is not None and sid.split('.')[0]!=owner.split('.')[0]:
                issues.append({'code':'ASSET_CROSS_CHAPTER_REF','asset_id':label,'section_id':sid,
                               'owner_section_id':owner,'message':'figure/table references are restricted to the owning chapter'})
    for sid,refs in references.items():
        for label in sorted(refs-set(planned)):
            if label.startswith(('fig:','tab:')):
                issues.append({'code':'ASSET_UNPLANNED_REF','asset_id':label,'section_id':sid,
                               'message':'reference names an asset absent from the confirmed outline'})
    return issues


def table_issues(tables,asset_plan,keys,key_index):
    """Accumulate identity, scope, column and evidence errors for every table."""
    from writing import cite_keys
    planned={a['table_id']:a for a in asset_plan['shared_tables']};seen=set();issues=[]
    def add(code,tid,message,**data):issues.append({'code':code,'asset_id':tid if isinstance(tid,str) or tid is None else repr(tid),'message':message,**data})
    for i,table in enumerate(tables):
        if not isinstance(table,dict):add('TABLE_SHAPE',None,'table must be an object',location=f'tables/{i}');continue
        tid=table.get('table_id')
        if not isinstance(tid,str) or tid not in planned:
            add('ASSET_UNPLANNED',tid,'table is absent from the confirmed outline',location=f'tables/{i}');continue
        if tid in seen:add('ASSET_DUPLICATE',tid,'table ID appears more than once')
        seen.add(tid);plan=planned[tid]
        if table.get('section_id')!=plan['section_id']:add('ASSET_OWNER',tid,'table belongs to a different section',expected=plan['section_id'],actual=table.get('section_id'))
        for field in ('purpose','content_plan','row_unit','comparison_dimensions','paper_ids','qualifications'):
            if field in table and table[field]!=plan.get(field):add('ASSET_PLAN_CHANGED',tid,'submitted table changes confirmed '+field)
        if not isinstance(table.get('caption'),str) or not table['caption'].strip():add('TABLE_SHAPE',tid,'table caption required')
        columns=table.get('columns');expected=table_columns(plan)
        if columns!=expected:add('TABLE_COLUMNS',tid,'table columns differ from the confirmed row unit and comparison dimensions',expected=expected,actual=columns)
        rows=table.get('rows')
        if not isinstance(rows,list) or not rows:add('TABLE_SHAPE',tid,'table requires evidence rows');continue
        allowed={key_index[p] for p in plan['paper_ids'] if p in key_index} if plan['paper_ids'] else keys
        for index,row in enumerate(rows):
            if not isinstance(row,list) or len(row)!=len(expected) or any(not isinstance(c,str) for c in row):
                add('TABLE_SHAPE',tid,'table row shape differs from planned columns',row=index);continue
            cited=cite_keys(' '.join(row))
            if not cited or cited-allowed:add('TABLE_EVIDENCE',tid,'comparison row must cite planned corpus evidence',row=index,unknown_cite_keys=sorted(cited-allowed))
    for tid in sorted(set(planned)-seen):add('ASSET_MISSING',tid,'planned table is missing',section_id=planned[tid]['section_id'])
    return issues


def fail_if_issues(issues):
    if issues:
        from generation_errors import GenerationError
        raise GenerationError('ASSET_CONTRACT', '; '.join(x['message']+((': '+str(x.get('asset_id'))) if x.get('asset_id') else '') for x in issues),
                              'manuscript/assets',issues=issues,
                              next_action='Fix all reported authoring errors against the confirmed outline; change the outline explicitly before adding or moving assets.')


def extra_artifacts(workspace,asset_plan):
    from pathlib import Path
    ws=Path(workspace);extras=[]
    for kind,key,suffixes in [('tables','table_id',{'.tex'}),('figures','figure_id',{'.tex','.png','.pdf'})]:
        allowed={a[key] for a in asset_plan['shared_'+kind]}
        for path in (ws/'05_generation'/kind).glob('*'):
            if path.is_file() and path.suffix in suffixes and re.fullmatch(r'[FT]\d+',path.stem) and path.stem not in allowed:
                extras.append(path)
    return extras


def retire_unplanned(workspace,asset_plan,preparation_id):
    """Preserve outputs of explicitly removed plans outside the publish bundle."""
    from pathlib import Path
    ws=Path(workspace);retired=[]
    for path in extra_artifacts(ws,asset_plan):
        target=ws/'05_generation/_internal/retired_assets'/preparation_id/path.parent.name/path.name
        target.parent.mkdir(parents=True,exist_ok=True);path.replace(target)
        retired.append(str(target))
    return retired
