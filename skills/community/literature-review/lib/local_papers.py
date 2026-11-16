"""Import user PDFs into the source cache, without network calls or invented metadata."""
from pathlib import Path
import hashlib
import json
import re
import shutil

import pypdfium2
from pypdf import PasswordType, PdfReader
from strategy import PROVIDED_ONLY, policy, QUICK
from materials import validate_abstract, LOCAL_MANIFEST
from prepared import validate_record as validate_prepared, partition as partition_preparation, expanded_refs
from search_metadata_eligibility import same_paper
from planning import refresh_local_metadata

LOCAL_FILE_FIELDS = {'path','title','authors','year','doi','abstract'}
METADATA_PREVIEW_CHARACTERS = 8000
METADATA_PREVIEW_PAGE = 1
METADATA_PREVIEW_FIELDS = ('title','authors','year')
METADATA_PREVIEW_BUDGET_EXHAUSTED = 'metadata_preview_budget_exhausted'
METADATA_PREVIEW_TEXT_UNAVAILABLE = 'metadata_preview_text_unavailable'
METADATA_PREVIEW_EXTRACTION_FAILED = 'metadata_preview_extraction_failed'

def validate_files(files):
    if not isinstance(files,list):raise ValueError('local_pdfs must be an array of paths or metadata objects')
    normalized=[]
    for value in files:
        value={'path':value} if isinstance(value,str) else value
        if not isinstance(value,dict) or set(value)-LOCAL_FILE_FIELDS:raise ValueError('local PDF accepts path, title, authors, year, doi and abstract only')
        if not isinstance(value.get('path'),str) or not value['path'].strip():raise ValueError('local PDF needs a nonempty path')
        for key in ('title','doi','abstract'):
            if key in value and not isinstance(value[key],str):raise ValueError('local PDF '+key+' must be text')
        if 'year' in value and (type(value['year']) is not int or not 1000<=value['year']<=9999):raise ValueError('local PDF year must be a four-digit integer')
        if 'authors' in value and (not isinstance(value['authors'],list) or any(not isinstance(a,str) or not a.strip() for a in value['authors'])):raise ValueError('local PDF authors must be nonempty names')
        normalized.append(dict(value))
    return normalized


def sizing(local_count,request):
    if request.get('sources',{}).get('policy') == PROVIDED_ONLY:
        if not local_count:
            raise ValueError('provided_only requires supplied papers; import the authorized materials before continuing')
        return {'local_count':local_count,'search_target':0,'combined_target':local_count,
                'combined_ceiling':local_count,'policy':PROVIDED_ONLY}
    if 'execution' in request:
        target=request['retrieval']['corpus_size'].get('target',policy(request)['papers'])
        supplement=max(0,target-local_count)
        return {'local_count':local_count,'search_target':supplement,'combined_target':local_count+supplement,
                'combined_ceiling':max(local_count,request['retrieval']['corpus_size'].get('max',target)),
                'policy':'configured_supplement'}
    if local_count:
        supplement=10*((max(0,40-local_count)+9)//10)
        return {'local_count':local_count,'search_target':supplement,'combined_target':local_count+supplement,
                'combined_ceiling':local_count+supplement,'policy':'keep_all_local_then_round_supplement_up_to_tens'}
    size=request['retrieval']['corpus_size'];target=size.get('target',40)
    return {'local_count':0,'search_target':target,'combined_target':target,
            'combined_ceiling':size.get('max',target),'policy':'configured_retrieval'}


def file_hash(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for part in iter(lambda:stream.read(1024*1024),b''):h.update(part)
    return h.hexdigest()


def source_directory(workspace,pid):
    safe=re.sub(r'[^A-Za-z0-9_-]+','_',pid)[:48]
    name=safe+'.'+hashlib.sha1(pid.encode()).hexdigest()[:10]+'.source'
    return Path(workspace)/'02_retrieval/_fulltext_cache/caption-sentences-v1'/name


def import_pdfs(workspace,request=None):
    from task_contract import read_request,configure,atomic_json,digest
    ws=Path(workspace).resolve();task=read_request(ws);request=request or {}
    if task.get('execution',{}).get('mode') == QUICK:
        raise ValueError('Quick needs supplied abstracts; use Standard for local PDFs')
    if not isinstance(request,dict) or set(request)-{'files'}:raise ValueError('import-local request accepts files only; repeated imports append or update paths')
    supplied=validate_files(request.get('files',[]))
    expanded={}
    for entry in [*task.get('local_pdfs',[]),*supplied]:
        path=Path(entry['path']).expanduser()
        path=(path if path.is_absolute() else ws/path).resolve()
        paths=sorted(p for p in path.rglob('*') if p.is_file() and p.suffix.lower()=='.pdf') if path.is_dir() else [path]
        if not paths:raise ValueError('no PDFs in '+str(path))
        if path.is_dir() and set(entry)!={'path'}:raise ValueError('directory input cannot supply per-paper metadata')
        for source in paths:expanded[str(source)]={**expanded.get(str(source),{}),**entry,'path':str(source)}
    if not expanded:raise ValueError('no local PDFs specified; supply files or configure local_pdfs first')
    records={};copies=[];duplicates=[];new_copies=0;reused_copies=0
    previews=[];preview_characters=0
    for entry in expanded.values():
        source=Path(entry['path'])
        if source.suffix.lower()!='.pdf' or not source.is_file():raise ValueError('local PDF is missing or not a PDF path: '+str(source))
        try:
            reader=PdfReader(source,strict=False)
            if reader.is_encrypted and reader.decrypt('') is PasswordType.NOT_DECRYPTED:
                raise ValueError('PDF is encrypted, empty or invalid: '+str(source))
            with pypdfium2.PdfDocument(source,password='') as document:
                if not len(document):raise ValueError('PDF is encrypted, empty or invalid: '+str(source))
            raw_metadata=reader.metadata or {}
            metadata={'title':str(raw_metadata.get('/Title') or '').strip(),'author':str(raw_metadata.get('/Author') or '').strip()}
        except ValueError:raise
        except Exception as exc:raise ValueError('PDF is encrypted, empty or invalid: '+str(source)) from exc
        sha=file_hash(source);pid='local_'+sha[:24]
        if pid in records:
            existing=records[pid]
            existing['local_source']['original_paths'].append(str(source));duplicates.append(str(source))
            for field in ('title','authors','year','doi','abstract'):
                if entry.get(field):
                    existing[field]=[{'name':name} for name in entry[field]] if field=='authors' else entry[field]
                    if field in existing['metadata_provenance']:existing['metadata_provenance'][field]='user'
            continue
        title=entry.get('title') or metadata.get('title') or source.stem
        title_origin='user' if entry.get('title') else 'pdf_metadata' if metadata.get('title') else 'filename_unverified'
        authors=entry.get('authors') or ([name.strip() for name in re.split(r'[;\n]+',metadata['author']) if name.strip()] if metadata.get('author') else [])
        target=source_directory(ws,pid)/'source.pdf'
        records[pid]={'paperId':pid,'title':title,'abstract':entry.get('abstract',''),'year':entry.get('year'),
            'authors':[{'name':name} for name in authors],'venue':None,'doi':entry.get('doi'),
            'arxiv_id':None,'external_ids':{},'citation_count':None,'tier':1,'relevance_level':'L1',
            'selection_reason':'User-supplied local PDF; retained explicitly.','subtopics_covered':[],
            'source':'local_pdf','user_supplied':True,'metadata_provenance':{'title':title_origin,'authors':'user' if entry.get('authors') else 'pdf_metadata' if authors else 'missing','year':'user' if entry.get('year') else 'missing'},
            'local_source':{'path':str(target),'sha256':sha,'original_paths':[str(source)]}}
        copies.append((source,target,sha))
        missing=[field for field in METADATA_PREVIEW_FIELDS
                 if records[pid]['metadata_provenance'][field] in ('missing','filename_unverified')]
        if missing:
            preview={'paper_id':pid,'path':str(source),'page':METADATA_PREVIEW_PAGE,
                     'missing_fields':missing,'text':'','truncated':False,'error':None}
            available=METADATA_PREVIEW_CHARACTERS-preview_characters
            if available<=0:
                preview.update(truncated=True,error=METADATA_PREVIEW_BUDGET_EXHAUSTED)
            else:
                try:
                    text=reader.pages[METADATA_PREVIEW_PAGE-1].extract_text() or ''
                    preview.update(text=text[:available],truncated=len(text)>available,
                                   error=None if text.strip() else METADATA_PREVIEW_TEXT_UNAVAILABLE)
                    preview_characters+=len(preview['text'])
                except Exception as error:
                    preview['error']=METADATA_PREVIEW_EXTRACTION_FAILED+':'+type(error).__name__
                    preview['message']=str(error)
            previews.append(preview)
    # Validate every input first. Only immutable cache objects precede the manifest commit.
    for source,target,sha in copies:
        target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists() or file_hash(target)!=sha:
            new_copies+=1
            temporary=target.with_suffix('.part');shutil.copyfile(source,temporary)
            if file_hash(temporary)!=sha:temporary.unlink();raise ValueError('local PDF changed during import: '+str(source))
            temporary.replace(target)
        else:reused_copies+=1
        atomic_json(target.parent/'local_import.json',{'source':'local_pdf','sha256':sha,'original_path':str(source)})
    configured=list(expanded.values());configure(ws,{'local_pdfs':configured})
    manifest={'version':1,'input_sha256':digest(configured),'papers':records,'duplicate_files':duplicates}
    atomic_json(ws/LOCAL_MANIFEST,manifest)
    plan_current=refresh_local_metadata(ws)
    selected_refs=read_request(ws).get('sources',{}).get('refs',[])
    plan={} if selected_refs else budget(ws)
    next_action=('Consume the selected-source preparation from task activation, create or confirm the execution plan, then run papers budget. Local import alone does not establish corpus readiness.'
                 if selected_refs else
                 'Search for search_target additional distinct papers, import-search, then run retrieval_adapt.' if plan['search_target'] else
                 'Skip search and run retrieval_adapt, fulltext and processing.')
    if 'execution' in read_request(ws):
        next_action=('Continue using the current approved execution plan without another question; consume any current selected-source preparation, then run papers budget.'
                     if plan_current else 'Consume the selected-source preparation and confirm the execution plan before discovery or evidence processing; then run papers budget.')
    return {'status':'SUCCESS','imported_count':len(records),'new_snapshot_count':new_copies,
            'reused_snapshot_count':reused_copies,'duplicate_count':len(duplicates),
            'manifest':str(ws/LOCAL_MANIFEST),**plan,
            'metadata_preview':{'purpose':'bibliography_preparation_only',
                                'character_limit':METADATA_PREVIEW_CHARACTERS,
                                'characters':preview_characters,'items':previews,
                                'notice':'First-page excerpts from explicitly supplied local PDFs only. Missing, failed or truncated previews are incomplete. These excerpts are not abstracts, full-text evidence or authorization. Preserve unknown metadata and the complete PDF snapshots.'},
            'metadata_gaps':[{'paper_id':pid,'fields':[key for key in ('title','authors','year') if p['metadata_provenance'][key] in ('missing','filename_unverified')]} for pid,p in records.items() if any(v in ('missing','filename_unverified') for v in p['metadata_provenance'].values())],
            'next_action':next_action}


def load_local(workspace):
    from task_contract import read_request,digest
    ws=Path(workspace);entries=read_request(ws).get('local_pdfs',[])
    material_path=ws/'02_retrieval/material_papers.json'
    materials=json.loads(material_path.read_text()) if material_path.exists() else {}
    refs=read_request(ws).get('sources',{}).get('refs',[])
    expected_refs=refs
    if set(materials.get('refs',[]))!=set(refs):raise ValueError('selected references must be imported before retrieval')
    material_records=materials.get('papers',{})
    observed=set()
    for paper in material_records.values():
        if 'preparation_source' in paper:
            observed.update(validate_prepared(paper))
            continue
        if 'abstract_source' in paper:
            observed.add(validate_abstract(paper))
            continue
        local=paper['local_source']
        observed.update(local.get('refs',[]))
        if file_hash(Path(local['path']))!=local['sha256']:raise ValueError('selected material snapshot changed')
    if materials.get('preparation'):
        receipt=materials['preparation'];source=(ws/receipt['relative_path']).resolve()
        if not source.is_relative_to(ws.resolve()) or file_hash(source)!=receipt['sha256']:
            raise ValueError('selected preparation snapshot changed')
        manifest=json.loads(source.read_text())
        if partition_preparation(manifest,refs)!=material_records:
            raise ValueError('selected preparation records changed')
        expected_refs=expanded_refs(manifest,refs)
        observed.update(manifest['pending'])
        observed.update(manifest['duplicates'])
    if observed!=set(expected_refs):raise ValueError('selected material records must preserve every selected reference')
    if not entries:return material_records
    path=ws/LOCAL_MANIFEST
    if not path.exists():raise ValueError('configured local PDFs must be imported with papers import-local before retrieval')
    manifest=json.loads(path.read_text())
    if manifest.get('input_sha256')!=digest(entries):raise ValueError('local PDF configuration changed; rerun papers import-local')
    for paper in manifest['papers'].values():
        local=paper['local_source'];source=Path(local['path'])
        if not source.is_file() or file_hash(source)!=local['sha256']:raise ValueError('local PDF snapshot missing or changed; rerun papers import-local')
    return {**manifest['papers'],**material_records}


def budget(workspace):
    from task_contract import read_request
    papers=load_local(workspace)
    manifest=json.loads((Path(workspace)/'02_retrieval/material_papers.json').read_text()) if (Path(workspace)/'02_retrieval/material_papers.json').exists() else {}
    request=read_request(workspace)
    if not papers and manifest.get('preparation') and request.get('sources',{}).get('policy')==PROVIDED_ONLY:
        return {'state':'waiting_materials','local_count':0,'search_target':0,'combined_target':0,
                'combined_ceiling':0,'policy':PROVIDED_ONLY,'pending_count':len(manifest.get('pending',[])),
                'exclude_from_search':[]}
    return {**sizing(len(papers),request),'pending_count':len(manifest.get('pending',[])),
            'exclude_from_search':[{'paper_id':pid,'title':p['title'],'doi':p.get('doi'),'title_verified':p['metadata_provenance']['title']!='filename_unverified'} for pid,p in papers.items()]}


def merge_local(remote,local):
    """Prefer supplied bytes; match exact DOI or an actual supplied/embedded title."""
    result={pid:dict(p) for pid,p in local.items()};remaining={};duplicates=[]
    for rid,paper in remote.items():
        matches=[pid for pid,p in result.items() if same_paper(
            {**p, 'title': ''} if p['metadata_provenance']['title']=='filename_unverified' else p, paper)]
        if len(matches)!=1:remaining[rid]=paper;continue
        local_record=result[matches[0]]
        local_record['metadata_provenance']=dict(local_record['metadata_provenance'])
        if local_record['metadata_provenance']['title']=='filename_unverified' and paper.get('title'):
            local_record['title']=paper['title'];local_record['metadata_provenance']['title']='search_metadata'
        for key,value in paper.items():
            if key in ('paperId','source','user_supplied','local_source','metadata_provenance'):continue
            if not local_record.get(key) and value:
                local_record[key]=value
                if key in local_record['metadata_provenance']:local_record['metadata_provenance'][key]='search_metadata'
        duplicates.append({'remote_id':rid,'local_id':matches[0]})
    return result,remaining,duplicates
