#!/usr/bin/env scholarseed-skill-python
"""Compile the current editable v2; generation metadata never authorizes edits."""
from __future__ import annotations
import argparse
import json
import os
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
from bibliography_contract import inspect_bibliography, duplicate_citation_definitions

from platform_io import file_lock
from publication_pages import TRACKING_TEX
from publication_pages import inspection_plan
from publication_style import synchronize, metadata_check

PAGE_RENDER_LONG_EDGE=1400
PRECOMPILE_TIMEOUT_SECONDS = 10
PRECOMPILE_DIRECTORY = 'compilation_precheck'
COMPILE_DIAGNOSTIC_LIMIT = 8
COMPILE_CONTEXT_LINES = 7
COMPILE_DIAGNOSTIC_CHARS = 4000


def latex_engine(text):
    name = 'xelatex' if re.search(r'ctex|xeCJK|fontspec', text) else 'pdflatex'
    return shutil.which(name)


def precompile(ws, source):
    source = Path(source)
    engine = latex_engine(source.read_text())
    if not engine:
        return {'status': 'UNAVAILABLE', 'reason': 'LaTeX engine unavailable'}
    destination = source.parent/'_internal'/PRECOMPILE_DIRECTORY
    destination.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    for name in ('TEXINPUTS', 'BIBINPUTS', 'BSTINPUTS'):
        environment[name] = os.pathsep.join((str(source.parent), str(ws), environment.get(name, '')))
    command = [engine, '-interaction=nonstopmode', '-halt-on-error', '-file-line-error',
               '-output-directory='+str(destination), source.name]
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=source.parent, env=environment,
                                capture_output=True, text=True, errors='replace',
                                timeout=PRECOMPILE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return {'status': 'TIMEOUT', 'engine': engine,
                'duration_sec': round(time.monotonic()-started, 3)}
    except OSError as error:
        return {'status': 'UNAVAILABLE', 'engine': engine, 'reason': str(error)}
    output = result.stdout + result.stderr
    log = destination/(source.stem+'.log')
    save(destination/'command.log', output)
    lines = output.splitlines()
    contexts = ['\n'.join(lines[index:index+COMPILE_CONTEXT_LINES])
                for index, line in enumerate(lines)
                if line.startswith('!') or re.search(r'\.tex:\d+:', line)]
    errors = contexts[:COMPILE_DIAGNOSTIC_LIMIT] or [output[-COMPILE_DIAGNOSTIC_CHARS:]]
    return {'status': 'SUCCESS' if result.returncode == 0 else 'FAILED',
            'engine': engine, 'duration_sec': round(time.monotonic()-started, 3),
            'returncode': result.returncode, 'log': str(log),
            'errors': [] if result.returncode == 0 else errors}

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
    """Current-source checks; duplicate bibliography structures block publication."""
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
    bibliography=inspect_bibliography(sources,source.suffix=='.md',
                                     automatic_markdown=bool(cited_keys(prose)&keys))
    checks.append({'id':'bibliography_ownership',**bibliography})
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
    return {'status':'FAILED' if bibliography['blocking'] else
                    'WARNING' if any(c['status']=='WARNING' for c in checks) else 'SUCCESS',
            'blocking':bibliography['blocking'],'checks':checks}


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


def render_pages(ws,pdf=None,*,include_scope=False):
    scope={'status':'PARTIAL_SUCCESS','complete':False,'pages':[],'issues':[]}
    def finish(paths,error):
        return (paths,error,scope) if include_scope else (paths,error)
    ws=Path(ws)
    if pdf is None:
        report=ws/'05_generation/generation_report.json'
        recorded=read(report).get('deliverable') if report.exists() else None
        pdf=Path(recorded) if isinstance(recorded,str) and recorded.endswith('.pdf') else ws/'06_output/survey.pdf'
    else:pdf=Path(pdf)
    if not pdf.exists():
        scope['issues'].append({'code':'pdf_unavailable','path':str(pdf)})
        return finish([],'PDF unavailable')
    folder=ws/'07_verifier/postcheck/pages';folder.mkdir(parents=True,exist_ok=True)
    prefix=folder/('page-'+uuid.uuid4().hex[:12])
    rendered=[]
    try:
        try:source=publication_source(ws)
        except ValueError:source=None
        scope=inspection_plan(source,pdf)
        with pypdfium2.PdfDocument(pdf) as document:
            for item in scope['pages']:
                index=item['page_number']-1
                path=f'{prefix}-{index+1:02d}.png'
                page=document[index]
                try:
                    width,height=page.get_size()
                    zoom=PAGE_RENDER_LONG_EDGE/max(width,height)
                    bitmap=page.render(scale=zoom)
                    try:bitmap.to_pil().save(path)
                    finally:bitmap.close()
                finally:page.close()
                item['image']=path
                rendered.append(path)
    except (RuntimeError,OSError,ValueError,ImportError) as exc:
        scope.update(status='PARTIAL_SUCCESS',complete=False)
        scope['issues'].append({'code':'page_render_error','message':str(exc)[-2000:]})
        return finish(rendered,str(exc)[-2000:])
    error=None if scope['complete'] else 'Figure/table page selection is incomplete; see inspection_scope.issues and republish after fixing the reported labels.'
    return finish(rendered,error)


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
    ws=Path(ws).resolve();gen=ws/'05_generation';gen.mkdir(parents=True,exist_ok=True)
    with file_lock(gen/'publication.lock'):
        return _publish(ws,os.environ.copy())


def _publish(ws,env):
    started=time.monotonic();source=publication_source(ws);gen=source.parent
    settings = synchronize(ws, source)
    rules=content_report(ws)
    rules['checks'].extend(metadata_check(source, settings))
    if rules['blocking']:
        result={**rules,'code':'BIBLIOGRAPHY_CONFLICT','stage':'generation_publish',
                'source':str(source),'duration_sec':round(time.monotonic()-started,3),
                'next_action':'Remove the reported duplicate bibliography from v2 or its included sources, then run workflow publish. Any earlier exported PDF is not the current result.'}
        save(gen/'generation_report.json',result);save(ws/'_status/manuscript_publish.json',result)
        return result
    if source.suffix=='.md':
        out=_export(ws,source);deliverable=out/'survey.md'
        from citation_formats import CitationResolver,parse_bib_file
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
        engine=latex_engine(text)
        if not engine:raise ValueError('LaTeX engine unavailable')
        # Every invocation compiles the current source; no cache or generation gate.
        record=gen/'_status/phase07_compile_latex.json'
        save(record,{'status':'FAILED','source':str(source),'message':'Current compile running'})
        for name in ('TEXINPUTS','BIBINPUTS','BSTINPUTS'):
            env[name]=os.pathsep.join((str(gen),str(ws),env.get(name,'')))
        tracker=gen/'_internal/publication_page_tracking.tex'
        save(tracker,TRACKING_TEX)
        command=[engine,'-interaction=nonstopmode','-halt-on-error','-jobname='+source.stem,
                 r'\input{_internal/publication_page_tracking.tex}\input{'+source.name+'}']
        logs=[];first=_run(command,gen,env);logs.append(first.stdout+first.stderr)
        bibliography_required = r'\bibliography{' in text
        bibliography_ok = not bibliography_required
        if (gen/(source.stem+'.aux')).exists() and bibliography_required and shutil.which('bibtex'):
            bib=_run(['bibtex',source.stem],gen,env);logs.append(bib.stdout+bib.stderr)
            bibliography_ok = bib.returncode == 0
        final=first
        for _ in range(2):
            final=_run(command,gen,env);logs.append(final.stdout+final.stderr)
        save(ws/'_logs/publication_compile.log','\n'.join(logs))
        pdf=source.with_suffix('.pdf')
        log=source.with_suffix('.log').read_text(errors='replace') if source.with_suffix('.log').exists() else ''
        log_lines=log.splitlines()
        fatal=[line for line in log_lines if line.startswith('!')]
        contexts=['\n'.join(log_lines[i:i+7]) for i,line in enumerate(log_lines) if line.startswith('!')]
        clean=final.returncode==0 and pdf.exists() and not fatal and bibliography_ok
        duplicate_definitions=duplicate_citation_definitions(log)
        if duplicate_definitions:clean=False
        diagnosis={'verdict':'bibliography_conflict' if duplicate_definitions else 'clean' if clean else 'compile_failed','final_pass_rc':final.returncode,
                   'fatal_errors':fatal,'log_path':str(source.with_suffix('.log')),
                   'error_contexts':contexts,
                   'bibliography_ok': bibliography_ok,
                   'log_warnings':[line for line in log.splitlines() if 'Warning' in line or 'Overfull' in line]}
        save(record,{'status':'SUCCESS' if clean else 'FAILED','source':str(source),'diagnosis':diagnosis})
        result={'status':'SUCCESS' if clean else 'FAILED','source':str(source),
                'checks':rules['checks']+[{'id':'bibliography_definitions',
                    'status':'FAILED' if duplicate_definitions else 'SUCCESS','warnings':duplicate_definitions},
                    {'id':'compilation','status':'SUCCESS' if clean else 'FAILED','diagnosis':diagnosis}],
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
            if duplicate_definitions:
                result.update(code='BIBLIOGRAPHY_CONFLICT',blocking=True,
                              message='Duplicate citation definitions remain; repair the bibliography and republish.')
    result.update(stage='generation_publish',duration_sec=round(time.monotonic()-started,3))
    save(gen/'generation_report.json',result);save(ws/'_status/manuscript_publish.json',result)
    return result


def audit(ws,render=False):
    ws=Path(ws);source=publication_source(ws)
    result=content_report(ws)
    previous=read(ws/'05_generation/generation_report.json') if (ws/'05_generation/generation_report.json').exists() else {}
    result.update(status='FAILED' if result['blocking'] else previous.get('status','FAILED'),visual_review_required=source.suffix=='.tex',
                  visual_review_complete=False,pages_to_read=[],render_error=None)
    result['checks'] += [c for c in previous.get('checks',[]) if c['id'] in ('compilation','bibliography_definitions','citation_metadata','citation_fidelity')]
    if render and source.suffix=='.tex' and result['status']=='SUCCESS':
        result['pages_to_read'],result['render_error'],result['inspection_scope']=render_pages(
            ws,previous.get('deliverable'),include_scope=True)
        result['checks'].append({'id':'visual_inspection_scope',
                                 'status':'SUCCESS' if result['inspection_scope']['complete'] else 'WARNING',
                                 'issues':result['inspection_scope']['issues']})
        if result['render_error']:result['status']='PARTIAL_SUCCESS'
    folder=ws/('07_verifier/postcheck' if render else '07_verifier/fast_audit/output')
    result['next_action']='Inspect the rendered pages; edit v2 directly and run workflow publish.'
    if result.get('inspection_scope',{}).get('complete') is False:
        result['next_action']='Resolve inspection_scope.issues and republish; available page images do not cover every figure/table yet.'
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
