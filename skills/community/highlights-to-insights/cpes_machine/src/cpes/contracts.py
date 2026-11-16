from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path


def source_lines(text):
    """Split frozen source on LF only; PDF control glyphs are not new lines."""
    if not text:return []
    return text.removesuffix('\n').split('\n')


class CpesError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details
    def issue(self):
        return {'code':self.code,'message':self.message,'retryable':False,'details':self.details}


INTENT_SCHEMA = {
    'type':'object','additionalProperties':False,
    'properties':{
        'action':{'type':'string','enum':['extract_figures','interpret_figures','extract_tables','interpret_tables','request_user_input','unsupported','configure_api']},
        'figure_numbers':{'type':'array','items':{'type':'string'},'maxItems':128},
        'all_figures':{'type':'boolean'}, 'include_image':{'type':'boolean'},
        'include_appendix':{'type':'boolean'},
        'include_caption':{'type':'boolean'},'question':{'type':'string'},'reason':{'type':'string'}},
    'required':['action','figure_numbers','all_figures','include_appendix','include_image','include_caption','question','reason']}


def validate_intent(value, *, allow_roman=False):
    if isinstance(value,dict) and value.get('action') in ('extract_tables','interpret_tables'):
        value=dict(value)
        if value.pop('figure_numbers',[]) or value.pop('all_figures',False):
            raise CpesError('invalid_intent','Cannot mix Table and Figure selections.')
        translated={k:v for k,v in value.items() if k not in ('table_numbers','all_tables')}
        if 'table_numbers' in value:translated['figure_numbers']=value['table_numbers']
        if 'all_tables' in value:translated['all_figures']=value['all_tables']
        translated['action']=value['action'].replace('tables','figures')
        checked=validate_intent(translated,allow_roman=True)
        checked['action']=value['action']
        checked['table_numbers']=checked.pop('figure_numbers')
        checked['all_tables']=checked.pop('all_figures')
        return checked
    if isinstance(value,dict):
        value=dict(value)
        if value.pop('table_numbers',[]) or value.pop('all_tables',False):
            raise CpesError('invalid_intent','Table selection requires a Table action.')
    if not isinstance(value,dict) or set(value)!=set(INTENT_SCHEMA['required']):
        raise CpesError('invalid_intent','Model output does not match the intent contract.')
    if value['action'] not in INTENT_SCHEMA['properties']['action']['enum']:
        raise CpesError('invalid_intent','Unregistered action.')
    for key in ('all_figures','include_appendix','include_image','include_caption'):
        if type(value[key]) is not bool:raise CpesError('invalid_intent',f'{key} must be boolean.')
    for key in ('question','reason'):
        if not isinstance(value[key],str):raise CpesError('invalid_intent',f'{key} must be text.')
    numbers=value['figure_numbers']
    if not isinstance(numbers,list) or len(numbers)>128 or any(not isinstance(n,str) or not re.fullmatch(r'[A-Za-z]?\d+[A-Za-z0-9.-]*'+(r'|[IVXLCDMivxlcdm]+' if allow_roman else ''),n) for n in numbers):
        raise CpesError('invalid_intent','Invalid printed Figure numbers.')
    if value['action'] in ('extract_figures','interpret_figures'):
        if bool(numbers)==value['all_figures']:
            raise CpesError('invalid_intent','Specify Figure numbers OR an explicit all-Figures request.')
        if value['action']=='extract_figures' and not value['include_image'] and not value['include_caption']:
            raise CpesError('invalid_intent','No requested deliverable.')
    elif value['action']=='request_user_input' and not value['question'].strip():
        raise CpesError('invalid_intent','Clarification requires a question.')
    value={**value,'figure_numbers':list(dict.fromkeys(n.lower() for n in numbers))}
    return value


def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()
