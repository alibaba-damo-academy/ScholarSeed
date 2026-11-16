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
from markdown_it import MarkdownIt

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
import slr_paths
slr_paths.bootstrap(__file__)
from evidence import read,save
from compilation import bibliography as bibliography_diagnosis
from compilation import layout as layout_diagnosis, LAYOUT_ERROR
from generation_diagnostics import GenerationError, diagnostic
from usage import accumulate
from publication_files import dependencies,source_bundle
from bibliography_contract import inspect_bibliography, duplicate_citation_definitions

from platform_io import file_lock
from publication_pages import TRACKING_TEX
from publication_pages import inspection_plan
from publication_style import synchronize, metadata_check
from word import export as export_word, HEADING_IDENTIFIER, image_box
from task_contract import read_request
from latex_to_markdown import labels_for
from taxonomy import tree_sources, render_trees
from paper_materials import is_quick
from citation_formats import CitationResolver, parse_bib_file, reference_requirements

PAGE_RENDER_LONG_EDGE=1400
PRECOMPILE_TIMEOUT_SECONDS = 10
PRECOMPILE_DIRECTORY = 'compilation_precheck'
COMPILE_DIAGNOSTIC_LIMIT = 8
COMPILE_CONTEXT_LINES = 7
COMPILE_DIAGNOSTIC_CHARS = 4000
ASSET_ANCHOR = re.compile(r'''(?m)^<a id=["']((fig|tab)[:-][^"']+)["']></a>[ \t]*$''')
ASSET_REFERENCE = re.compile(r'(~)?\\(ref|autoref|cref)\{((?:fig|tab):[^}]+)\}')
ASSET_LABELS = {'fig': 'figure', 'tab': 'table'}
MEDIA_ELEMENT = re.compile(r'<\s*/?\s*(?:img|svg|picture|video|canvas)\b', re.IGNORECASE)
HTML_IDENTIFIER = re.compile(r'''\bid=["']([A-Za-z][A-Za-z0-9_.:-]*)["']''')


def native_heading_ids(text):
    """Project heading attributes to native HTML anchors in delivered Markdown."""
    tokens = MarkdownIt('commonmark', {'html': True}).enable('table').parse(text)
    identifiers = {match[1] for token in tokens for node in [token, *(token.children or [])]
                   if node.type in ('html_block', 'html_inline')
                   for match in HTML_IDENTIFIER.finditer(node.content)}
    offsets = [0]
    for line in text.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    edits = []
    for index, token in enumerate(tokens):
        if token.type != 'heading_open' or not token.map or index + 1 >= len(tokens):
            continue
        inline = tokens[index + 1]
        if inline.type != 'inline' or not inline.children or inline.children[-1].type != 'text':
            continue
        suffix = HEADING_IDENTIFIER.search(inline.children[-1].content)
        if not suffix:
            continue
        identifier = suffix[1]
        start, end = offsets[token.map[0]], offsets[token.map[1]]
        matches = list(re.finditer(r'(?<!\\)\{#' + re.escape(identifier)
                                  + r'\}(?=[ \t]*(?:#+[ \t]*)?(?:\r?\n|$))', text[start:end]))
        if not matches:
            continue  # Escaped text and inline-code examples remain literal.
        if identifier in identifiers:
            raise ValueError('duplicate heading identifier: ' + identifier)
        identifiers.add(identifier)
        matched = matches[-1]
        edits.append((start + matched.start(), start + matched.end(), '<a id="' + identifier + '"></a>'))
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
    return text


def native_references(text, language):
    labels = labels_for(str(language).lower())
    anchors = list(ASSET_ANCHOR.finditer(text))
    known = set(re.findall(r'''id=["']([^"']+)''', text))
    numbers = {}
    offsets = [0]
    for line in text.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    table_positions = [offsets[token.map[0]] for token in MarkdownIt('commonmark', {'html': True}).enable('table').parse(text)
                       if token.type == 'table_open' and token.map]
    image_positions = [(offsets[token.map[0]], offsets[token.map[1]], child.content)
                       for token in MarkdownIt('commonmark', {'html': True}).parse(text)
                       if token.type == 'inline' and token.map
                       for child in token.children or [] if child.type == 'image']
    insertions = {}
    figure_number = 0
    for index, anchor in enumerate(anchors):
        end = anchors[index + 1].start() if index + 1 < len(anchors) else len(text)
        label = labels[ASSET_LABELS[anchor.group(2)]]
        caption = re.search(r'(?m)^(?:\*\*)?' + re.escape(label) + r'\s*(\d+)[.．：:](?:\*\*)?', text[anchor.end():end])
        if caption:
            numbers[anchor.group(1)] = (label, caption.group(1))
            if anchor.group(2) == 'fig':
                figure_number = int(caption.group(1))
        elif anchor.group(2) == 'fig':
            image = next((row for row in image_positions if anchor.end() <= row[0] < end), None)
            if image is not None:
                alternate = re.fullmatch(re.escape(label) + r'\s*(\d+)', image[2].strip())
                figure_number = int(alternate[1]) if alternate else figure_number + 1
                numbers[anchor.group(1)] = (label, str(figure_number))
                insertions[image[1]] = '\n**' + label + ' ' + str(figure_number) + '.**\n'
        elif anchor.group(2) == 'tab':
            position = next((offset for offset in table_positions if anchor.end() <= offset < end), None)
            if position is not None:
                number = str(table_positions.index(position) + 1)
                numbers[anchor.group(1)] = (label, number)
                insertions[position] = '**' + label + ' ' + number + '.**\n\n'

    def reference(match):
        key = match.group(3)
        candidates = (key, key.replace(':', '-', 1))
        anchor = next((candidate for candidate in candidates if candidate in numbers),
                      next((candidate for candidate in candidates if candidate in known), None))
        if anchor is None:
            return match.group(0)
        label, number = numbers.get(anchor, ('', key))
        display = label + ' ' + number if label and match.group(2) != 'ref' else number
        return (' ' if match.group(1) else '') + '[' + display + '](#' + anchor + ')'

    for position, label in sorted(insertions.items(), reverse=True):
        text = text[:position] + label + text[position:]
    return ASSET_REFERENCE.sub(reference, text)


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
    layout = layout_diagnosis(log.read_text(errors='replace') if log.exists() else output)
    clean = result.returncode == 0 and layout['status'] == 'SUCCESS'
    if result.returncode == 0 and not clean:
        errors = [issue['context'] for issue in layout['issues']] + [layout['next_action']]
    return {'status': 'SUCCESS' if clean else 'FAILED',
            'engine': engine, 'duration_sec': round(time.monotonic()-started, 3),
            'returncode': result.returncode, 'log': str(log),
            'layout': layout, 'errors': [] if clean else errors}

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


def content_report(ws,edited=True,publication=None):
    """Current-source checks; duplicate bibliography structures block publication."""
    source=publication_source(ws)
    quick=is_quick(ws)
    sources,paths=({'main':source.read_text()},{'main':source}) if quick else source_bundle(source)
    prose='\n'.join(re.sub(r'(?m)(?<!\\)%[^\n]*','',text) if paths[k].suffix=='.tex' else text
                    for k,text in sources.items() if k=='main' or paths[k].suffix=='.tex')
    keys=set()
    files={source} if quick else dependencies(source)
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
    settings = publication if publication is not None else (
        read(source.parent/'publication.json') if (source.parent/'publication.json').exists() else {})
    metadata_issues = reference_requirements(parse_bib_file(default_bib) if default_bib.is_file() else {},
                                           settings.get('citation_style'), cited_keys(prose), pdf=source.suffix=='.tex')
    if metadata_issues:
        checks.append({'id':'reference_metadata','status':'FAILED','issues':metadata_issues})
    identity_failure=False
    request_path=Path(ws)/'01_input/writing_request.json'
    if request_path.exists():
        request=read_request(ws)
        citation_bounds=[item['value'] for item in request['constraints'] if item['kind']=='total_citations']
        requires_citations=(request['output_scope']=='survey' or request.get('deliverable',{}).get('kind')=='related_work')
        if any(bound.get('max')==0 for bound in citation_bounds):requires_citations=False
        identity_failure='execution' in request and (bool(unknown) or requires_citations and not cited_keys(prose))
        if identity_failure:
            checks.append({'id':'citation_identities','status':'FAILED',
                           'message':'Native review source needs supplied citation keys, not hand-numbered references.'})
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
    return {'status':'FAILED' if bibliography['blocking'] or identity_failure or metadata_issues else
                    'WARNING' if any(c['status']=='WARNING' for c in checks) else 'SUCCESS',
            'blocking':bibliography['blocking'] or identity_failure or bool(metadata_issues),'checks':checks,
            'code':'CITATION_IDENTITIES_MISSING' if identity_failure else 'BIBLIOGRAPHY_CONFLICT' if bibliography['blocking'] else 'REFERENCE_METADATA_INCOMPLETE' if metadata_issues else None}


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
    try:
        return subprocess.run(command,cwd=cwd,env=env,capture_output=True,text=True,errors='replace',timeout=180)
    except subprocess.TimeoutExpired as exc:
        raise GenerationError('COMPILER_TIMEOUT','Compiler process exceeded its deadline',
                              component=Path(command[0]).stem,
                              next_action='Inspect the compiler inputs and logs; retain completed chapters and retry publication only.') from exc
    except OSError as exc:
        raise GenerationError('COMPILER_LAUNCH_FAILED','Compiler process could not start',
                              component=Path(command[0]).stem, error_type=type(exc).__name__,
                              next_action='Restore the configured compiler executable and permissions; do not regenerate chapters.') from exc


def _export(ws,source):
    out=ws/'06_output';out.mkdir(parents=True,exist_ok=True)
    if is_quick(ws):
        shutil.copyfile(source,out/'survey.md')
        return out
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
        status_path=ws/'_status/manuscript_publish.json'
        previous=read(status_path) if status_path.exists() else {}
        started=time.monotonic()
        try:
            result=_publish(ws,os.environ.copy())
        except GenerationError as exc:
            result=diagnostic(exc)
        result.update(accumulate(previous,result,time.monotonic()-started))
        save(gen/'generation_report.json',result);save(status_path,result)
        return result


def _publish(ws,env):
    started=time.monotonic();source=publication_source(ws);gen=source.parent
    if is_quick(ws):
        if source.suffix != '.md':
            raise ValueError('Quick publishes Markdown only; recommend Standard for other formats')
        tokens = MarkdownIt('commonmark').parse(source.read_text())
        nodes = [node for token in tokens for node in [token, *(token.children or [])]]
        if any(node.type == 'image' or node.type in ('html_inline','html_block') and MEDIA_ELEMENT.search(node.content) for node in nodes):
            raise ValueError('Quick cannot publish images; preserve requested images by switching to Standard')
    settings = synchronize(ws, source)
    requested_format=(read_request(ws)['publication'].get('format',settings.get('format'))
                      if (ws/'01_input/writing_request.json').exists() else settings.get('format'))
    managed_request=(read_request(ws) if (ws/'01_input/writing_request.json').exists() else {})
    if 'execution' in managed_request and (requested_format=='latex_pdf' and source.suffix=='.md'
            or requested_format in ('markdown','docx') and source.suffix=='.tex'):
        raise ValueError('publication format requires a different native source; convert in a new publication workspace without overwriting v2')
    rules=content_report(ws,publication=settings)
    rules['checks'].extend(metadata_check(source, settings))
    if rules['blocking']:
        result={**rules,'code':rules.get('code') or 'BIBLIOGRAPHY_CONFLICT','stage':'generation_publish',
                'source':str(source),'duration_sec':round(time.monotonic()-started,3),
                'next_action':'Remove the reported duplicate bibliography from v2 or its included sources, then run workflow publish. Any earlier exported PDF is not the current result.'}
        if rules.get('code')=='CITATION_IDENTITIES_MISSING':
            result['next_action']='Restore actual supplied citation keys in v2 using \\cite{key}; the publisher owns printed numbers. Do not guess a number-to-paper mapping. Then run workflow publish.'
        if rules.get('code')=='REFERENCE_METADATA_INCOMPLETE':
            result['next_action']='Use the recorded primary metadata or actual source-consultation evidence for each cited preprint date; update urldate in the active bibliography and republish. Do not invent a date from the clock or change cited sources.'
        save(gen/'generation_report.json',result);save(ws/'_status/manuscript_publish.json',result)
        return result
    if source.suffix=='.md':
        entries=parse_bib_file(gen/'citations.bib')
        resolver=CitationResolver(entries,settings.get('citation_style','numeric'),settings.get('language','english'))
        raw=source.read_text()
        if is_quick(ws):
            resolver.collect(raw)
            rendered_native,native_records=raw,[]
        else:
            native_sources=tree_sources(raw,source.parent)
            resolver.collect(raw+'\n'+'\n'.join(body for _path,body in native_sources.values()))
            box = tuple(length.pt for length in image_box()) if requested_format == 'docx' else None
            rendered_native,native_records=render_trees(raw,source.parent,resolver,
                                                       **({'image_box':box} if box else {}))
        out=_export(ws,source);deliverable=out/'survey.md'
        for record in native_records:
            image=source.parent/record['image']
            target=out/record['image']
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(image,target)
        def citation(match):
            keys=[k.strip() for k in match[2].split(',')]
            # Preserve unresolved citations visibly; never silently erase them.
            return match[0] if any(k not in entries for k in keys) else resolver.rewrite(match[0])
        rendered=re.sub(r'\\(cite|citet|citep)\*?\{([^}]+)\}',citation,rendered_native)
        rendered=native_references(rendered,settings.get('language','english'))
        if requested_format != 'docx':
            rendered=native_heading_ids(rendered)
        if resolver.order:
            lines=resolver.reference_lines()
            rendered+='\n'+'\n'.join(lines)+'\n'
        save(deliverable,rendered)
        result={'status':'SUCCESS','deliverable':str(deliverable),'source':str(source),
                'native_figures':native_records,
                'checks':rules['checks'],'visual_review_required':False,'pages_to_read':[],
                'next_action':'Edit v2 directly and run workflow publish.'}
        output_format=(read_request(ws)['publication'].get('format')
                       if (ws/'01_input/writing_request.json').exists() else settings.get('format'))
        if output_format=='docx':
            result.update(export_word(rendered,out,out/'survey.docx',settings.get('language','english')))
    else:
        text=source.read_text()
        engine=latex_engine(text)
        if not engine:raise GenerationError('LATEX_TOOL_UNAVAILABLE','LaTeX engine unavailable',next_action='Restore the configured LaTeX engine; keep the manuscript and republish.')
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
        bib=None
        aux_exists=(gen/(source.stem+'.aux')).exists()
        bib_available=bool(shutil.which('bibtex'))
        if aux_exists and bibliography_required and bib_available:
            bib=_run(['bibtex',source.stem],gen,env);logs.append(bib.stdout+bib.stderr)
        bib_diagnosis=bibliography_diagnosis(bibliography_required,bib_available,aux_exists,bib)
        bibliography_ok=bib_diagnosis['status'] in ('SUCCESS','NOT_REQUIRED')
        final=first
        for _ in range(2):
            final=_run(command,gen,env);logs.append(final.stdout+final.stderr)
        save(ws/'_logs/publication_compile.log','\n'.join(logs))
        pdf=source.with_suffix('.pdf')
        log=source.with_suffix('.log').read_text(errors='replace') if source.with_suffix('.log').exists() else ''
        log_lines=log.splitlines()
        fatal=[line for line in log_lines if line.startswith('!')]
        contexts=['\n'.join(log_lines[i:i+7]) for i,line in enumerate(log_lines) if line.startswith('!')]
        compiled=final.returncode==0 and pdf.exists() and not fatal and bibliography_ok
        layout = layout_diagnosis(log)
        clean=compiled and layout['status']=='SUCCESS'
        duplicate_definitions=duplicate_citation_definitions(log)
        if duplicate_definitions:clean=False
        diagnosis={'verdict':'bibliography_conflict' if duplicate_definitions else
                   'layout_failed' if compiled and layout['status']=='FAILED' else
                   'clean' if clean else 'compile_failed','final_pass_rc':final.returncode,
                   'fatal_errors':fatal,'log_path':str(source.with_suffix('.log')),
                   'error_contexts':contexts,
                   'bibliography_ok': bibliography_ok, 'bibliography':bib_diagnosis, 'layout':layout,
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
            if compiled and layout['status']=='FAILED':
                result.update(code=LAYOUT_ERROR,
                              message='Current PDF has reported layout overflow; any earlier export is not the current result.',
                              next_action=layout['next_action'])
            if not bibliography_ok and first.returncode == 0:
                result.update(code=bib_diagnosis['code'],
                              message='Bibliography compilation failed; see compile.bibliography for entry and field diagnostics.',
                              next_action=bib_diagnosis['next_action'])
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
    result.update(status='FAILED' if result['blocking'] else previous.get('status','FAILED'),visual_review_required=source.suffix=='.tex' or str(previous.get('deliverable','')).endswith('.docx'),
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
