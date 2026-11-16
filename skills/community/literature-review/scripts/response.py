"""Consume an externally produced outline only against its original request."""

import re
import uuid
from pathlib import Path

from evidence import ensure, read, save
from outlining import build_prompt, corpus_digest, restore_ids
from operator_cli import configure_outline
from scripted_generation import parse_response
from task_contract import read_request
from task_input import task_input
from generation.output_spec import read_output_spec

REQUEST_ID = re.compile(r'^[a-f0-9]{32}$')


def import_outline(workspace, value):
    if not isinstance(value, dict) or set(value) != {'request_id', 'response_path'}:
        raise ValueError('outline import requires request_id and response_path')
    if not isinstance(value['request_id'], str) or not REQUEST_ID.fullmatch(value['request_id']):
        raise ValueError('invalid outline request_id')
    workspace = Path(workspace)
    directory = workspace / '_logs/llm' / value['request_id']
    adapter = read(directory / 'outline_adapter.json')
    original=read(directory/'request.json')
    evidence = read(ensure(workspace, 'outline')['artifacts'][0])
    messages,expected=build_prompt(task_input(workspace),read_request(workspace),evidence,read_output_spec(workspace)['format'])
    base_messages = adapter.get('base_messages', original.get('messages'))
    request_messages = adapter.get('request_messages', messages)
    if original.get('stage')!='outline' or base_messages!=messages or original.get('messages')!=request_messages:
        raise ValueError('outline request inputs changed; use the matching task and evidence revision')
    if adapter.get('papers')!=expected['papers'] or adapter.get('version')!=expected['version']:
        raise ValueError('outline request mapping changed')
    raw = Path(value['response_path']).read_text(encoding='utf-8')
    attempt=directory/'imports'/uuid.uuid4().hex
    save(attempt/'response.txt',raw)
    changes=[]
    normalized = restore_ids(parse_response(raw), adapter, value['request_id'], corpus_digest(evidence),changes)
    candidate = attempt / 'candidate.json'
    save(candidate,normalized)
    save(attempt/'normalization.json',{'request_id':value['request_id'],'origin':'external_import','changes':changes})
    result = configure_outline(workspace, normalized)
    return {**result,'candidate_path':str(candidate),'normalization':str(attempt/'normalization.json')}
