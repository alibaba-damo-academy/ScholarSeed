#!/usr/bin/env scholarseed-skill-python
"""Compile the current editable v2; generation metadata never authorizes edits."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import uuid

import pypdfium2

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
import slr_paths
slr_paths.bootstrap(__file__)
from evidence import read,save
from publication_files import dependencies,source_bundle

PAGE_RENDER_LIMIT=3
PAGE_RENDER_LONG_EDGE=1400


def publication_source(ws):
    gen=Path(ws)/'05_generation'
    candidates=[gen/f'full_draft_v2.{s}' for s in ('tex','md')]
    existing=[p for p in candidates if p.is_file()]
    if len(existing)!=1:
        raise ValueError('Expected exactly one full_draft_v2.tex or full_draft_v2.md. Finish generation or explicitly import the final source.')
    # Old v2 was an intermediate, not a publication handoff. Never silently
    # choose it over a legacy final v3.
    if not (gen/'publication.json').exists() and any(gen.glob('full_draft_v3.*')):
        raise ValueError('Legacy v2/v3 workspace: explicitly copy its final source into a new publication workspace.')
    return existing[0]


def source_text(ws,source):
    sources,_=source_bundle(source)
    return '\n'.join(sources.values())


def content_report(ws,edited=True):
    """Advisory checks against CURRENT source/bibliography, never old task IDs."""
    source=publication_source(ws);sources,paths=source_bundle(source)
    prose='\n'.join(text for k,text in sources.items() if k=='main' or paths[k].suffix=='.tex')
    prose=re.sub(r'(?m)(?<!\\)%[^\n]*','',prose)
    keys=set()
    files=dependencies(source)
    default_bib=source.parent/'citations.bib'
    if default_bib.is_file():files.add(default_bib)
    for p in files:
        if p.suffix=='.bib':
            keys.update(re.findall(r'@\w+\s*\{\s*([^,\s]+)',p.read_text(errors='replace')))
    from manuscript_rules import cited_keys
    unknown=sorted(cited_keys(prose)-keys)
    labels=set(re.findall(r'\\label\{([^}]+)\}',prose))
    if source.suffix=='.md':
        labels.update(k.replace('fig-','fig:',1).replace('tab-','tab:',1)
                      for k in re.findall(r'id=["\']([^"\']+)',prose))
    references=set(re.findall(r'\\(?:ref|autoref|cref|eqref)\{([^}]+)\}',prose))
    checks=[{'id':'unknown_citations','unknown':unknown,'status':'WARNING' if unknown else 'SUCCESS'},
            {'id':'unresolved_references','missing':sorted(references-labels),
             'status':'WARNING' if references-labels else 'SUCCESS'}]
    # Planned coverage is advice only. Deleting all generation JSON must still
    # leave a directly compilable document.
    outline_path=Path(ws)/'04_outline/outline.json'
    if outline_path.exists():
        try:
            outline=read(outline_path);missing=[];tables=[]
            from writing_contract import section_label
            for node in outline.get('outline_tree',[]):
                if source.suffix=='.md':
                    exists=node.get('title','') in prose
                elif node.get('role')=='abstract':exists=r'\begin{abstract}' in prose
                else:exists=section_label(node['section_id']) in labels or node.get('title','') in prose
                if not exists:missing.append(node['section_id'])
                for n in [node,*node.get('subsections',[])]:
                    for t in n.get('tables',[]):
                        if 'tab:'+t['table_id'] not in labels and source.suffix=='.tex':tables.append(t['table_id'])
            checks += [{'id':'planned_chapters','missing':missing,'status':'WARNING' if missing else 'SUCCESS'},
                       {'id':'planned_tables','missing':tables,'status':'WARNING' if tables else 'SUCCESS'}]
        except (ValueError,KeyError,TypeError):
            checks.append({'id':'plan_advice','status':'WARNING','message':'Old outline unavailable; current source remains editable.'})
    return {'status':'WARNING' if any(c['status']=='WARNING' for c in checks) else 'SUCCESS',
            'blocking':False,'checks':checks}


def safe_title_stem(title):
    """Keep readable Unicode while replacing cross-platform unsafe runs."""
    text=unicodedata.normalize('NFKC',str(title or '')).strip()
    text=re.sub(r'[\x00-\x1f<>:"/\\|?*\s]+','_',text)
    text=re.sub(r'_+','_',text).strip('._') or 'survey'
    if text.upper() in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),
                        *(f'LPT{i}' for i in range(1,10))}:
        text+='_'
    return text[:160].rstrip('._') or 'survey'


def publication_title(ws,source):
    outline_path=Path(ws)/'04_outline/outline.json'
    if outline_path.exists():
        try:
            title=read(outline_path).get('survey_title')
            if isinstance(title,str) and title.strip():return title
        except (OSError,ValueError,TypeError):pass
    text=source.read_text(errors='replace')
    if source.suffix=='.md':
        match=re.search(r'(?m)^#\s+(.+?)\s*$',text)
    else:
        match=re.search(r'\\title\{([^{}]+)\}',text)
    return match[1].strip() if match else 'survey'


def deliverable_pdf_path(ws,source):
    return Path(ws)/'06_output'/(safe_title_stem(publication_title(ws,source))+'.pdf')


def render_pages(ws,pdf=None):
    ws=Path(ws)
    if pdf is None:
        report=ws/'05_generation/generation_report.json'
        recorded=read(report).get('deliverable') if report.exists() else None
        pdf=Path(recorded) if isinstance(recorded,str) and recorded.endswith('.pdf') else ws/'06_output/survey.pdf'
    else:pdf=Path(pdf)
    if not pdf.exists():return [],'PDF unavailable'
    folder=ws/'07_verifier/postcheck/pages';folder.mkdir(parents=True,exist_ok=True)
    prefix=folder/('page-'+uuid.uuid4().hex[:12])
    try:
        with pypdfium2.PdfDocument(pdf) as document:
            for index in range(min(PAGE_RENDER_LIMIT,len(document))):
                width,height=document[index].get_size()
                zoom=PAGE_RENDER_LONG_EDGE/max(width,height)
                document[index].render(scale=zoom).to_pil().save(
                    f'{prefix}-{index+1:02d}.png')
    except (RuntimeError,OSError,ValueError) as exc:
        return [],str(exc)[-2000:]
    return [str(p) for p in sorted(folder.glob(prefix.name+'-*.png'))],None


def _run(command,cwd,env):
    return subprocess.run(command,cwd=cwd,env=env,capture_output=True,text=True,errors='replace',timeout=180)


def _export(ws,source):
    out=ws/'06_output';out.mkdir(parents=True,exist_ok=True)
    # Current local dependencies, including user-added tables, styles and bibs.
    files=dependencies(source)
    if (source.parent/'citations.bib').exists():files.add(source.parent/'citations.bib')
    for path in files:
        if path==source:continue
        if path.is_relative_to(source.parent):
            target=out/path.relative_to(source.parent)
            target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
    shutil.copyfile(source,out/('survey'+source.suffix))
    return out


def publish(ws):
    import os
    import fcntl
    ws=Path(ws).resolve();gen=ws/'05_generation';gen.mkdir(parents=True,exist_ok=True)
    with (gen/'publication.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return _publish(ws,os.environ.copy())


def _publish(ws,env):
    started=time.monotonic();source=publication_source(ws);gen=source.parent
    rules=content_report(ws)
    if source.suffix=='.md':
        out=_export(ws,source);deliverable=out/'survey.md'
        from citation_formats import CitationResolver,parse_bib_file
        settings=read(gen/'publication.json') if (gen/'publication.json').exists() else {}
        entries=parse_bib_file(gen/'citations.bib')
        resolver=CitationResolver(entries,settings.get('citation_style','numeric'),settings.get('language','english'))
        raw=source.read_text();resolver.collect(raw)
        def citation(match):
            keys=[k.strip() for k in match[2].split(',')]
            # Preserve unresolved citations visibly; never silently erase them.
            return match[0] if any(k not in entries for k in keys) else resolver.rewrite(match[0])
        rendered=re.sub(r'\\(cite|citet|citep)\*?\{([^}]+)\}',citation,raw)
        anchors=set(re.findall(r'id=["\']([^"\']+)',raw))
        def reference(match):
            key=match[1];anchor=key.replace(':','-',1)
            return '['+key+'](#'+anchor+')' if anchor in anchors else match[0]
        rendered=re.sub(r'\\(?:ref|autoref|cref)\{((?:fig|tab):[^}]+)\}',reference,rendered)
        if resolver.order:
            lines=resolver.reference_lines()
            if settings.get('output_scope')=='section':
                save(out/'references.md','\n'.join(lines)+'\n')
                rendered=rendered.replace('](#ref-','](references.md#ref-')
            else:rendered+='\n'+'\n'.join(lines)+'\n'
        save(deliverable,rendered)
        result={'status':'SUCCESS','deliverable':str(deliverable),'source':str(source),
                'checks':rules['checks'],'visual_review_required':False,'pages_to_read':[],
                'next_action':'Edit v2 directly and run workflow publish.'}
    else:
        text=source.read_text()
        engine='xelatex' if re.search(r'ctex|xeCJK|fontspec',text) else 'pdflatex'
        if not shutil.which(engine):raise ValueError(engine+' unavailable')
        # Every invocation compiles the current source; no cache or generation gate.
        record=gen/'_status/phase07_compile_latex.json'
        save(record,{'status':'FAILED','source':str(source),'message':'Current compile running'})
        for name in ('TEXINPUTS','BIBINPUTS','BSTINPUTS'):
            env[name]=str(gen)+':'+str(ws)+':'+env.get(name,'')
        command=[engine,'-interaction=nonstopmode','-halt-on-error',source.name]
        logs=[];first=_run(command,gen,env);logs.append(first.stdout+first.stderr)
        if (gen/(source.stem+'.aux')).exists() and r'\bibliography{' in text and shutil.which('bibtex'):
            bib=_run(['bibtex',source.stem],gen,env);logs.append(bib.stdout+bib.stderr)
        final=first
        for _ in range(2):
            final=_run(command,gen,env);logs.append(final.stdout+final.stderr)
        save(ws/'_logs/publication_compile.log','\n'.join(logs))
        pdf=source.with_suffix('.pdf')
        log=source.with_suffix('.log').read_text(errors='replace') if source.with_suffix('.log').exists() else ''
        log_lines=log.splitlines()
        fatal=[line for line in log_lines if line.startswith('!')]
        contexts=['\n'.join(log_lines[i:i+7]) for i,line in enumerate(log_lines) if line.startswith('!')]
        clean=final.returncode==0 and pdf.exists() and not fatal
        diagnosis={'verdict':'clean' if clean else 'compile_failed','final_pass_rc':final.returncode,
                   'fatal_errors':fatal,'log_path':str(source.with_suffix('.log')),
                   'error_contexts':contexts,
                   'log_warnings':[line for line in log.splitlines() if 'Warning' in line or 'Overfull' in line]}
        save(record,{'status':'SUCCESS' if clean else 'FAILED','source':str(source),'diagnosis':diagnosis})
        result={'status':'SUCCESS' if clean else 'FAILED','source':str(source),
                'checks':rules['checks']+[{'id':'compilation','status':'SUCCESS' if clean else 'FAILED','diagnosis':diagnosis}],
                'compile':diagnosis,'visual_review_required':True,
                'next_action':'Inspect PDF pages; edit v2 and its dependencies, then run workflow publish.'}
        if clean:
            out=_export(ws,source);deliverable=deliverable_pdf_path(ws,source)
            shutil.copyfile(pdf,deliverable)
            legacy=out/'survey.pdf'
            if legacy!=deliverable and legacy.exists():legacy.unlink()
            result['deliverable']=str(deliverable)
        else:
            result.update(code='LATEX_COMPILE_ERROR',message='Current v2 did not compile. Edit it directly; any earlier exported PDF is not the current result.')
    result.update(stage='generation_publish',duration_sec=round(time.monotonic()-started,3))
    save(gen/'generation_report.json',result);save(ws/'_status/manuscript_publish.json',result)
    return result


def audit(ws,render=False):
    ws=Path(ws);source=publication_source(ws)
    result=content_report(ws)
    previous=read(ws/'05_generation/generation_report.json') if (ws/'05_generation/generation_report.json').exists() else {}
    result.update(status=previous.get('status','FAILED'),visual_review_required=source.suffix=='.tex',
                  visual_review_complete=False,pages_to_read=[],render_error=None)
    result['checks'] += [c for c in previous.get('checks',[]) if c['id']=='compilation']
    if render and source.suffix=='.tex' and result['status']=='SUCCESS':
        result['pages_to_read'],result['render_error']=render_pages(ws,previous.get('deliverable'))
        if result['render_error']:result['status']='PARTIAL_SUCCESS'
    folder=ws/('07_verifier/postcheck' if render else '07_verifier/fast_audit/output')
    result['next_action']='Inspect the rendered pages; edit v2 directly and run workflow publish.'
    result['report']=str(folder/'report.json');save(folder/'report.json',result)
    save(folder/'summary.md','# Publication checks\n\n'+'\n'.join('- '+c['id']+': '+c['status'] for c in result['checks']))
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['publish','audit','postcheck'])
    parser.add_argument('--workspace',required=True)
    args=parser.parse_args()
    try:result=publish(Path(args.workspace)) if args.action=='publish' else audit(Path(args.workspace),args.action=='postcheck')
    except (OSError,ValueError,KeyError,subprocess.TimeoutExpired) as exc:
        result={'status':'FAILED','message':str(exc),'next_action':'Edit v2 or fix the reported compiler issue; run workflow publish.'}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 1 if result['status']=='FAILED' else 0


if __name__=='__main__':raise SystemExit(main())
