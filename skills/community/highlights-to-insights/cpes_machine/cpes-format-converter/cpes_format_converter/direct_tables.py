"""Publish PDF Table crops, optionally retaining legacy source structure."""
import os
import time
from .common import ConverterError, artifact, sha256_file
from .direct import model_stdout_to_stderr
from .extract import (normalize_pages, TABLE_PREFIX, table_caption, pair_table_regions, table_rows,
                      table_document, render_page, crop_box, valid_table_region)
from .native import export_native_context
from .scope import filter_pages
from .worker import build_payload


def explicit_rowspan_slots(rows):
    """LaTeX needs an empty column slot for each HTML cell inherited from above."""
    occupied={};result=[];width=0
    for row_number,row in enumerate(rows):
        expanded=[];column=0
        for cell in row:
            while occupied.get(column,0)>row_number:
                expanded.append({'text':'','rowspan':1,'colspan':1});column+=1
            expanded.append(cell)
            for col in range(column,column+cell['colspan']):
                if cell['rowspan']>1:occupied[col]=row_number+cell['rowspan']
            column+=cell['colspan']
        while column<max(occupied,default=-1)+1:
            expanded.append({'text':'','rowspan':1,'colspan':1});column+=1
        width=max(width,column);result.append(expanded)
    return result,width


def publish_tables(pdf, pages, output, targets=(), *, image_only=False):
    published=[];issues=[];seen=set();rendered={}
    for page in pages:
        for caption,region in pair_table_regions(page):
            match=TABLE_PREFIX.match(str(caption['content'])) if caption else None
            if not match:
                issues.append({'code':'table_caption_unresolved','page_number':page['page_number']})
                continue
            number=match.group(1).lower()
            if targets and number not in targets:continue
            if number in seen:
                issues.append({'code':'duplicate_table_number','table':number,'page_number':page['page_number']})
                continue
            seen.add(number)
            if image_only:
                if not valid_table_region(page, region):
                    issues.append({'code':'table_region_unavailable','table':number,'page_number':page['page_number']})
                    continue
            else:
                try:
                    rows,_=table_rows(str(region['content']))
                    rows,columns=explicit_rowspan_slots(rows)
                except Exception as exc:
                    issues.append({'code':'table_structure_unavailable','table':number,'message':str(exc)})
                    continue
            directory=output/'table-cards'/f'table-{number}'
            directory.mkdir()
            if page['page_number'] not in rendered:
                rendered[page['page_number']]=render_page(pdf,page['page_number'],page['width'],page['height'])
            image=directory/'table.png'
            rendered[page['page_number']].crop(crop_box(region['bbox_pixels'],page['width'],page['height'])).save(image,'PNG')
            text=str(caption['content']).strip()
            (directory/'caption.md').write_text(text+'\n',encoding='utf-8')
            metadata={'page_number':page['page_number'],'bbox_pixels':region['bbox_pixels'],
                'coordinate_space':region['coordinate_space'],'visual_region_ids':[region['region_id']],
                'caption':caption}
            names=['table.png','caption.md']
            if not image_only:
                (directory/'table.tex').write_text(table_document(rows,columns,''),encoding='utf-8')
                metadata.update(rows=rows,columns=columns)
                names.append('table.tex')
            published.append({'table_number':match.group(1).upper() if number.isalpha() else number,'status':'success','metadata':metadata,
                'artifacts':[artifact(directory/name,output) for name in names]})
        for issue in page.get('issues',[]):
            if issue.get('domain')=='table':issues.append({**issue,'page_number':page['page_number']})
    return {'status':'partial' if published and issues else 'failed' if issues else 'success' if published else 'success_empty',
            'count':len(published),'tables':published,'issues':issues}


def run_direct_tables(pdf, output, input_value, source_hash, targets, scope_mode, native_context, started):
    if any(not (output/n).is_dir() or (output/n).is_symlink() for n in ('table-cards','system')):
        raise ConverterError('invalid_output','Direct Table output needs table-cards and system directories.')
    if list((output/'table-cards').glob('table-*')) or (output/'system/document.txt').exists():
        raise ConverterError('output_exists','Table output already exists.')
    with model_stdout_to_stderr():
        envelope=build_payload(pdf,{'table'},None,scope_mode,os.environ.get('CPES_DEVICE','cpu'),table_numbers=targets,image_only=True)
    scope=envelope['search']['figure_scope']
    if scope_mode=='main' and scope['status']!='identified':
        raise ConverterError('body_boundary_unknown','No verified References boundary.',figure_scope=scope)
    if sha256_file(pdf)!=source_hash:raise ConverterError('source_changed','PDF changed during conversion.')
    pages=normalize_pages(envelope['pages'],allow_sparse=bool(targets) or scope_mode=='main')
    tables=publish_tables(pdf,filter_pages(pages,scope),output,targets,image_only=True)
    catalog={'source':{'input_path':input_value,'resolved_path':str(pdf),'sha256':source_hash},
        'status':tables['status'] if tables['status'] in ('partial','failed') else 'success',
        'engine':envelope['engine'],'artifact_base':'run','figure_scope':scope,
        'layout':{'pages':[{'page_number':p['page_number'],'extraction_method':p['extraction_method']} for p in pages]},
        'domains':{'table':tables},'elapsed_seconds':round(time.monotonic()-started,3)}
    if targets:catalog['table_index']={'schema_version':'cpes-table-index.v1','pdf_sha256':source_hash,**envelope['search']}
    if native_context:catalog['native_context']=export_native_context(pdf,output,source_hash,figure_scope=scope,cpes_direct=True)
    if sha256_file(pdf)!=source_hash:raise ConverterError('source_changed','PDF changed during extraction.')
    return {'storage':'cpes-converter-direct-v1','catalog':catalog}
