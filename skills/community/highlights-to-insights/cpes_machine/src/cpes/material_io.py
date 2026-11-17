"""Persist extraction objects once; resolve source text and result object references."""
import copy
import json
from pathlib import Path
from .paths import internal,relative_internal,organized
from .contracts import write_json
from .job_io import source_path
from . import direct_store


def save_materials(root,value,*,debug=False):
    stored=copy.deepcopy(value)
    if not debug:
        for item in stored['objects']:
            if item.get('caption_path'):
                item.pop('caption',None);item.pop('caption_source_lines',None)
    write_json(internal(root,'materials/index.json'),stored)


def load_materials(root):
    if direct_store.direct(root):return direct_store.load_materials(root)
    value=json.loads((internal(root,'materials/index.json')).read_text(encoding='utf-8'))
    for item in value['objects']:
        if 'caption' not in item and item.get('caption_path'):
            path=source_path(root,item['caption_path'])
            item['caption']=path.read_text(encoding='utf-8').rstrip('\n')
            metadata_path=source_path(root,item['caption_metadata_path']) if item.get('caption_metadata_path') else path.with_name('figure.json')
            metadata=json.loads(metadata_path.read_text(encoding='utf-8'))
            item['caption_source_lines']=metadata['caption'].get('source_lines',[])
    return value


def save_result(root,value,*,debug=False):
    if direct_store.direct(root):return
    stored=copy.deepcopy(value)
    if not debug and (internal(root,'materials/index.json')).exists():
        objects={i['object_id']:i for i in load_materials(root)['objects'] if i.get('object_id')}
        items=[]
        for item in stored['result']['items']:
            base=objects.get(item.get('object_id'))
            if base is None:items.append(item);continue
            changes={k:v for k,v in item.items() if k not in base or base[k]!=v}
            items.append({'object_ref':item['object_id'],**changes})
        stored['result']['items']=items
        stored['result']['material_index']=relative_internal(root,'materials/index.json')
    write_json(internal(root,'results')/f"{value['request_id']}.json",stored)


def load_result(root,path):
    value=json.loads(Path(path).read_text(encoding='utf-8'))
    items=value['result']['items']
    if any('object_ref' in i for i in items):
        if value['result'].get('material_index')!=relative_internal(root,'materials/index.json'):raise ValueError('Invalid material index')
        objects={i['object_id']:i for i in load_materials(root)['objects'] if i.get('object_id')}
        value['result']['items']=[{**objects[i['object_ref']],**{k:v for k,v in i.items() if k!='object_ref'}}
                                  if 'object_ref' in i else i for i in items]
    return value
