"""Reuse a completed extraction only for identical inputs and unchanged assets."""
from pathlib import Path
import json
from .paths import internal,relative_internal,organized
from .contracts import CpesError,digest,write_json
from .material_io import load_result
from . import direct_store


def save_extraction(root,state,inputs,result):
    if state.get('layout_version',0)>=3:return direct_store.save_extraction(root,state,inputs,result)
    files={}
    for folder in ('conversion','sources','materials'):
        for path in internal(root,folder).rglob('*'):
            if path.is_file():files[path.relative_to(root).as_posix()]=digest(path)
    if organized(root):
        for path in (root/'figure-cards').glob('figure-*/*'):
            if path.name in ('figure.png','caption.md'):files[path.relative_to(root).as_posix()]=digest(path)
    path=internal(root,'checkpoints/extraction.json')
    result_path=internal(root,'results')/f"{result['request_id']}.json"
    if not result_path.exists():write_json(result_path,result)
    files[result_path.relative_to(root).as_posix()]=digest(result_path)
    write_json(path,{'inputs':inputs,'result_path':result_path.relative_to(root).as_posix(),'files':files})
    state['extraction_checkpoint']={'path':path.relative_to(root).as_posix(),'sha256':digest(path)}


def load_extraction(root,state,inputs):
    if state.get('layout_version',0)>=3:return direct_store.load_extraction(root,state,inputs)
    record=state.get('extraction_checkpoint')
    if not record:return None
    path=(root/record['path']).resolve()
    if not path.is_relative_to(root) or not path.is_file() or digest(path)!=record['sha256']:
        raise CpesError('checkpoint_artifact_changed','提取检查点缺失或已改变。')
    value=json.loads(path.read_text(encoding='utf-8'))
    expected={**value['inputs'],'debug':value['inputs'].get('debug',False)}
    current={**inputs,'debug':inputs.get('debug',False)}
    if expected!=current:
        raise CpesError('resume_scope_changed','已有提取结果的范围与新任务不同，请新建运行。')
    for relative,sha in value['files'].items():
        artifact=(root/relative).resolve()
        if not artifact.is_relative_to(root) or not artifact.is_file() or digest(artifact)!=sha:
            raise CpesError('checkpoint_artifact_changed','已提取产物缺失或改变，不能继续复用。',path=relative)
    if 'result' in value:return value['result']
    relative=value['result_path']
    if relative not in value['files']:raise CpesError('checkpoint_artifact_changed','提取结果未登记在检查点中。')
    return load_result(root,root/relative)
