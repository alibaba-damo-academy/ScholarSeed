"""External task/decision contracts. No inference and no implicit scope changes."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import re
import uuid
from .contracts import CpesError,validate_intent

TABLE_ALIASES={'table_backend':'figure_backend','table_concurrency':'figure_concurrency','max_table_calls':'max_figure_calls','table_model':'figure_model','table_effort':'figure_effort','table_cache_dir':'figure_cache_dir','refresh_tables':'refresh_figures'}

EXECUTION_KEYS={'output','converter_python','skills_root','model','profile','max_model_calls',
                'figure_backend','figure_concurrency','max_figure_calls','figure_model','figure_effort',
                'figure_cache_dir','refresh_figures','debug','cache_warmup','figure_profile'}


def text(value,label,*,nullable=False):
    if value is None and nullable:return value
    if not isinstance(value,str) or not value.strip():
        raise CpesError('invalid_task',f'{label} 必须是非空字符串。')
    return value


def external_intent(value):
    if not isinstance(value,dict):raise CpesError('invalid_intent','intent 必须是对象。')
    value=validate_intent({'question':'','reason':'',**value})
    if any(re.fullmatch(r'\d+[-–]\d+',n) for n in value.get('table_numbers',value.get('figure_numbers',[]))):
        raise CpesError('invalid_intent','请将图号范围展开为单独图号。')
    if value['action'] not in {'extract_figures','interpret_figures','extract_tables','interpret_tables'} and (value.get('table_numbers',value.get('figure_numbers',[])) or value['all_figures']):
        raise CpesError('invalid_intent','待澄清或配置动作不能同时指定提取范围。')
    return value


def validate_task(value):
    required={'pdf','user_request','intent','execution'}
    if not isinstance(value,dict) or set(value)!=required:
        raise CpesError('invalid_task','任务必须且只能包含 pdf、user_request、intent、execution。')
    task=text(value['user_request'],'user_request')
    pdf=text(value['pdf'],'pdf',nullable=True)
    intent=external_intent(value['intent'])
    execution=value['execution']
    if isinstance(execution,dict):
        execution=dict(execution)
        for key,target in TABLE_ALIASES.items():
            if key in execution:
                if not intent['action'].endswith('_tables') or target in execution:
                    raise CpesError('invalid_task','Table configuration requires a Table action and no conflicting aliases.')
                execution[target]=execution.pop(key)
    if not isinstance(execution,dict) or 'output' not in execution or set(execution)-EXECUTION_KEYS:
        raise CpesError('invalid_task','execution 缺少 output 或包含不支持的配置。')
    for key,val in execution.items():
        if key in {'refresh_figures','debug','cache_warmup'}:
            if type(val) is not bool:raise CpesError('invalid_task',f'{key} 必须是布尔值。')
        elif key not in {'max_model_calls','figure_concurrency','max_figure_calls'}:text(val,key)
    return task,pdf,intent,execution.copy()


def load_json(path):
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value:raise ValueError(f'duplicate key: {key}')
            value[key]=item
        return value
    try:return json.loads(Path(path).expanduser().read_text(encoding='utf-8'),object_pairs_hook=unique)
    except (OSError,ValueError,UnicodeError) as exc:
        raise CpesError('invalid_request_file','无法读取有效的 JSON 请求文件。') from exc


def pending_decision(state,code,question,issues):
    if code=='missing_pdf':actions=['provide_pdf','cancel']
    elif code=='body_boundary_unknown':actions=['include_appendix','cancel']
    elif code=='intent_unclear':actions=['replace_intent','cancel']
    else:actions=['configure','continue','cancel']
    if state.get('intent',{}).get('action')=='configure_api':actions=['configure','replace_intent','cancel']
    evidence=[]
    for issue in (issues or [])[:5]:
        details=issue.get('details',{})
        evidence.append({'code':issue['code'],'message':issue['message'][:1000],
                         'details':{k:details[k] for k in ('figure_scope','path','jobs','max_calls') if k in details}})
    return {'decision_id':'decision_'+uuid.uuid4().hex[:16],'run_id':state['run_id'],
            'code':code,'stage':state.get('stage','input'),'question':question,
            'task':state['task'][:2000],'intent':state.get('intent'),
            'completed_steps':['extract'] if state.get('extraction_checkpoint') else [],
            'evidence':evidence,'allowed_actions':actions}


def apply_decision(state,value):
    """Validate against the pending ID before changing even in-memory state."""
    base={'run_id','decision_id','action'}
    if not isinstance(value,dict) or not base<=set(value):
        raise CpesError('invalid_decision','决定必须包含 run_id、decision_id 和 action。')
    pending=state.get('decision',{})
    if value['run_id']!=state['run_id'] or value['decision_id']!=pending.get('decision_id'):
        raise CpesError('stale_decision','决定不属于本次运行的当前待决事项。')
    action=value['action']
    if not isinstance(action,str) or action not in pending.get('allowed_actions',[]):
        raise CpesError('invalid_decision','当前待决事项不接受该动作。')
    fields={'replace_intent':{'intent'},'provide_pdf':{'pdf'},'configure':{'figure_backend','intent'},
            'include_appendix':set(),'continue':set(),'cancel':set()}[action]
    if set(value)-base-fields:raise CpesError('invalid_decision','决定包含不支持的字段。')
    updated=copy.deepcopy(state)
    if action=='replace_intent':updated['intent']=external_intent(value.get('intent'))
    elif action=='include_appendix':updated['intent']['include_appendix']=True
    elif action=='provide_pdf':
        path=str(Path(text(value.get('pdf'),'pdf')).expanduser().resolve())
        if state.get('pdf_sha256') and path!=state.get('pdf'):
            raise CpesError('source_changed','更换已登记 PDF 时请开始新任务。')
        updated['pdf']=path
    elif action=='configure':
        backend=value.get('figure_backend')
        if not isinstance(backend,str) or backend not in {'api','codex'}:
            raise CpesError('invalid_decision','figure_backend 必须为 api 或 codex。')
        updated['figure_backend']=backend
        if 'intent' in value:updated['intent']=external_intent(value['intent'])
        if updated['intent']['action']=='configure_api':
            raise CpesError('invalid_decision','配置后请同时提供已明确的执行 intent。')
    updated.pop('decision',None)
    return updated,action
