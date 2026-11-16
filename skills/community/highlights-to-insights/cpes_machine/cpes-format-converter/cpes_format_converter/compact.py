"""Compact Figure-only conversion artifacts without changing text, lines or crops."""
import json
from .common import source_lines,artifact,write_json


def compact_output(root,catalog):
    if catalog.get('requested_domains')!=['figure']:
        raise ValueError('Compact output is supported only for figure-only extraction')
    layout_path=root/catalog['layout']['path']
    layout=json.loads(layout_path.read_text(encoding='utf-8'))
    for page in layout['pages']:
        for region in page.get('regions',[]):
            region.pop('content',None)
            for row in region.get('source_lines',[]):row.pop('text',None)
    layout['content_storage']='source-artifacts'
    write_json(layout_path,layout);catalog['layout']=artifact(layout_path,root)
    for figure in catalog['domains']['figure']['figures']:
        entry=next(e for e in figure['artifacts'] if e['path'].endswith('/figure.json'))
        path=root/entry['path'];value=json.loads(path.read_text(encoding='utf-8'))
        value['caption'].pop('content',None);value['caption']['content_ref']='caption.md'
        for row in value['caption'].get('source_lines',[]):row.pop('text',None)
        write_json(path,value)
        figure['artifacts']=[artifact(root/e['path'],root) for e in figure['artifacts']]
    context=catalog.get('native_context')
    if context:
        entry=next(e for e in context['artifacts'] if e['path'].endswith('/source.json'))
        path=root/entry['path'];source=json.loads(path.read_text(encoding='utf-8'))
        body=path.with_name('document.txt');lines=source_lines(body.read_text(encoding='utf-8'))
        for row in source['lines']:
            if 'text' in row and row['text']!=lines[row['line_number']-1]:raise ValueError('Native source line mismatch')
            row.pop('text',None)
        source['text_storage']='document-lines'
        write_json(path,source)
        entries=[]
        for item in context['artifacts']:
            p=root/item['path']
            if p.name=='document.numbered.txt':p.unlink(missing_ok=True)
            else:entries.append(artifact(p,root))
        context['artifacts']=entries
    raw=root/'raw'
    if raw.is_dir():
        for p in raw.glob('page-*.json'):p.unlink()
        if not any(raw.iterdir()):raw.rmdir()
    catalog['artifact_mode']='compact'
