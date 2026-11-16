"""Adapter from the formal converter catalog to CPES materials and results."""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from .paths import internal,relative_internal,organized
from .contracts import source_lines,CpesError, digest, write_json
from .material_io import save_materials
from . import direct_store

REPO = Path(__file__).resolve().parents[2]


def checked_artifact(directory, item):
    relative=Path(item['path'])
    path=(directory/relative).resolve()
    if relative.is_absolute() or not path.is_relative_to(directory.resolve()):
        raise CpesError('invalid_artifact_path','转换器产物路径超出输出目录。')
    if not path.is_file() or digest(path)!=item['sha256']:
        raise CpesError('artifact_hash_mismatch','转换器产物缺失或哈希不匹配。',path=item['path'])
    return path


def extract(request, run_dir, *, converter_python=None, skills_root=None):
    root=Path(run_dir).resolve();inputs=request['inputs'];pdf=Path(inputs['pdf_path']).resolve()
    kind=inputs.get('domains',['figure'])[0]; plural=kind+'s'; label=kind.title()
    source_hash=digest(pdf)
    if source_hash!=inputs['pdf_sha256']:raise CpesError('source_changed','PDF 在任务执行前发生变化。')
    paper_id='paper_'+source_hash[:16]
    is_direct=direct_store.direct(root)
    output=root if is_direct else internal(root,'conversion')/paper_id
    script=Path(skills_root or REPO)/'cpes-format-converter/scripts/convert_pdf.py'
    if not script.is_file():raise CpesError('converter_unavailable','找不到正式 Converter 入口。',path=str(script))
    command=[converter_python or sys.executable,str(script),'--input',str(pdf),'--output',str(output),'--domain',kind]
    if is_direct:command+=['--cpes-direct']
    elif not inputs.get('debug',False):command+=['--compact-output']
    scope_mode=inputs.get('figure_scope','all')
    if scope_mode=='main':command+=['--figure-scope','main']
    if kind=='figure' and 'figure_profile' in inputs:
        command+=['--figure-profile',inputs['figure_profile']]
    if inputs.get('include_context'):command+=['--native-context']
    for n in inputs[kind+'_numbers']:command+=['--'+kind,n]
    env=os.environ.copy();env.setdefault('CPES_DEVICE','cpu')
    try:process=subprocess.run(command,cwd=root,env=env,text=True,capture_output=True,timeout=7200,check=False)
    except FileNotFoundError as exc:raise CpesError('converter_python_unavailable','转换器 Python 不可用。') from exc
    except subprocess.TimeoutExpired as exc:raise CpesError('converter_timeout','PDF 转换超时。') from exc
    catalog_path=output/'catalog.json'
    if process.returncode not in (0,1) or (not is_direct and not catalog_path.is_file()):
        try:failure=json.loads(process.stdout)
        except (ValueError,TypeError):failure={}
        if failure.get('reason_code')=='body_boundary_unknown':
            raise CpesError('body_boundary_unknown','未找到可靠的参考文献标题，不能确认正文范围。',**failure.get('details',{}))
        raise CpesError('converter_failed','PDF 转换失败；退出状态已记录在运行摘要中。',exit_code=process.returncode)
    if is_direct:
        payload=json.loads(process.stdout)
        if payload.get('storage')!='cpes-converter-direct-v1':raise CpesError('invalid_converter_response','转换器未返回直接输出协议。')
        catalog=payload['catalog']
    else:catalog=json.loads(catalog_path.read_text(encoding='utf-8'))
    scope=catalog.get('figure_scope')
    if scope_mode=='main' and (not scope or scope.get('mode')!='main' or scope.get('status')!='identified' or not scope.get('boundary')):
        raise CpesError('body_boundary_unknown','转换器未提供可靠的正文边界。')
    if catalog['source']['sha256']!=source_hash or digest(pdf)!=source_hash:
        raise CpesError('source_changed','PDF 身份与转换结果不一致。')
    if organized(root) and not is_direct:
        from .publish import publish_figures
        catalog=publish_figures(root,output,catalog)
    artifact_root=root if catalog.get('artifact_base')=='run' else output
    layout=catalog['layout'] if is_direct else json.loads(checked_artifact(artifact_root,catalog['layout']).read_text(encoding='utf-8'))
    page_methods={p['page_number']:p.get('extraction_method') for p in layout.get('pages',[])}
    if catalog.get('figure_index') and not is_direct:checked_artifact(artifact_root,catalog['figure_index'])
    domain=catalog['domains'][kind]
    targets={n.lower() for n in inputs[kind+'_numbers']}
    items, artifacts, sources = [], [], []
    issues=[{'code':i.get('code','conversion_issue'),'message':str(i.get('message') or i.get('code')),
             'retryable':False,'details':i} for i in domain.get('issues',[])]
    for figure in domain.get(plural,[]):
        number=figure[kind+'_number']
        if targets and number.lower() not in targets:raise CpesError('scope_mismatch','转换器返回未请求的 Figure。')
        paths={}
        for artifact in figure['artifacts']:
            path=checked_artifact(artifact_root,artifact)
            paths[path.name]=path
            artifacts.append({**artifact,'path':path.relative_to(root).as_posix()})
        if not ({kind+'.png','caption.md'} if is_direct else {kind+'.png','caption.md',kind+'.json'})<=paths.keys():
            raise CpesError('incomplete_'+kind,label+' 产物不完整。')
        metadata=figure['metadata'] if is_direct else json.loads(paths[kind+'.json'].read_text(encoding='utf-8'))
        if kind=='figure' and inputs.get('figure_profile')=='fast' and metadata.get('visual_input',{}).get('profile')!='fast':
            raise CpesError('figure_profile_mismatch','转换器未返回所请求的 Fast 图片；不能静默使用其他档位。')
        page=metadata['page_number'];box=metadata['bbox_pixels']
        if type(page) is not int or page<1 or len(box)!=4 or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in box) or box[2]<=box[0] or box[3]<=box[1]:
            raise CpesError('invalid_locator','Figure 页码或坐标无效。')
        identity=json.dumps([source_hash,page,box],separators=(',',':'))
        object_id=kind+'_'+hashlib.sha256(identity.encode()).hexdigest()[:16]
        caption=paths['caption.md'].read_bytes().decode('utf-8')
        source_id=f'{paper_id}.{object_id}.caption'
        version='v_'+hashlib.sha256(caption.encode()).hexdigest()[:12]
        body=paths['caption.md']
        lines=source_lines(caption)
        locator={'pdf_sha256':source_hash,'page_number':page,'bbox_pixels':box,
                 'coordinate_space':metadata['coordinate_space'],'region_ids':metadata['visual_region_ids']}
        caption_region=metadata['caption']
        source={'schema_version':'cpes.v1','source_id':source_id,'version':version,'paper_id':paper_id,
                'content_sha256':digest(body),'line_count':len(lines),
                'body_path':body.relative_to(root).as_posix(),
                'source_kind':'paper_text','producer':'cpes-format-converter','trust':'internal_trusted',
                'qualifications':[],'parent_refs':[],
                'line_map':[{'line_start':1,'line_end':len(lines),'pdf_regions':[{
                    'page_number':page,'region_id':caption_region['region_id'],
                    'bbox_pixels':caption_region['bbox_pixels'],'coordinate_space':metadata['coordinate_space']}]}]}
        sources.append(source)
        reference={'source_id':source_id,'version':version,'line_start':1,'line_end':len(lines)}
        related=[issue for issue in issues if issue['details'].get(kind)==number]
        items.append({'object_id':object_id,'paper_id':paper_id,'kind':kind,'printed_label':f'{label} {number}',
                      'status':'partial' if related else 'completed',
                      'image':paths[kind+'.png'].relative_to(root).as_posix(),'caption':caption.rstrip('\n'),
                      'caption_path':paths['caption.md'].relative_to(root).as_posix(),
                      **({} if is_direct else {'caption_metadata_path':paths[kind+'.json'].relative_to(root).as_posix()}),
                      'caption_source_lines':caption_region.get('source_lines',[]),
                      'extraction_method':page_methods.get(page,'ocr'),
                      **({'visual_input':metadata['visual_input']} if kind=='figure' and 'visual_input' in metadata else {}),
                      'caption_ref':reference,'source_refs':[reference], 'pdf_locator':locator,

                      'producer':'cpes-format-converter','trust':'internal_trusted','issues':related})
    found={f['printed_label'].removeprefix(label+' ').lower() for f in items}
    for n in sorted(targets-found):
        items.append({'object_id':None,'printed_label':f'{label} {n}','status':'failed','source_refs':[],
                      'issues':[{'code':'requested_'+kind+'_not_found','message':f'未找到 {label} {n} 或 caption 配对失败。','retryable':False}]})
    successful=[i for i in items if i['status'] in ('completed','partial')]
    status='partial' if successful and (issues or any(i['status']!='completed' for i in items) or domain['status'] not in ('success','success_empty')) else 'completed' if successful else 'failed'
    if not successful and not issues:issues.append({'code':'no_'+plural+'_found','message':f'未找到可交付的 {label}。','retryable':False})
    native_context=None;native_source=None
    if inputs.get('include_context'):
        context=catalog.get('native_context')
        if context is None:raise CpesError('missing_native_context','转换器未提供原生文字上下文。')
        paths={}
        for entry in context['artifacts']:
            path=checked_artifact(artifact_root,entry);paths[path.name]=path
            artifacts.append({**entry,'path':path.relative_to(root).as_posix()})
        source=context['source'] if is_direct else json.loads(paths['source.json'].read_text(encoding='utf-8'))
        native_source=source
        if source['pdf_sha256']!=source_hash or source['text_sha256']!=digest(paths['document.txt']):
            raise CpesError('source_changed','原生文字与 PDF 来源不一致。')
        rows=source['lines'];text=paths['document.txt'].read_bytes().decode('utf-8')
        if source.get('text_storage')=='document-lines':
            text_lines=source_lines(text)
            for row in rows:row['text']=text_lines[row['line_number']-1]
        if text!=''.join(row['text']+'\n' for row in rows) or [r['line_number'] for r in rows]!=list(range(1,len(rows)+1)):
            raise CpesError('invalid_source_lines','原生文字行号或内容不一致。')
        native_context={'body_path':paths['document.txt'].relative_to(root).as_posix(),
                        'source_path':'system/sources.json' if is_direct else paths['source.json'].relative_to(root).as_posix(),
                        **({'numbered_path':paths['document.numbered.txt'].relative_to(root).as_posix()} if 'document.numbered.txt' in paths else {}),
                        'content_sha256':source['text_sha256'],'producer':'cpes-format-converter','trust':'internal_trusted',
                        'pages_without_native_text':source.get('pages_without_native_text',[])}
    materials={'schema_version':'cpes.v1','run_id':request['run_id'],
               'papers':[{'paper_id':paper_id,'pdf_sha256':source_hash,'path':str(pdf)}],
               'sources':sources,'objects':items,'native_context':native_context,'figure_scope':scope}
    if is_direct:
        direct_store.save_materials(root,materials,native_source)
        if kind=='table' and catalog.get('table_index'):
            from .bundle import read_index
            index=read_index(root);search=catalog['table_index']
            index['table_search']={k:search[k] for k in ('schema_version','pdf_sha256','document_page_count',
                'requested_tables','candidate_pages','matched_pages','processed_pages','missing_tables',
                'index_seconds','strategy','stopped_early') if k in search}
            direct_store.save_index(root,index)
    else:save_materials(root,materials,debug=inputs.get('debug',False))
    return {'schema_version':'cpes.v1','request_id':request['request_id'],'skill':'cpes-format-converter',
            'status':status,'result':{'material_index':relative_internal(root,'materials/index.json'),'paper_id':paper_id,'items':items,'figure_scope':scope},
            'artifacts':artifacts,'source_refs':[s for i in successful for s in i['source_refs']],
            'missing_context':[],'issues':issues}
