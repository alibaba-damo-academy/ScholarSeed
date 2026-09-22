#!/usr/bin/env scholarseed-skill-python
"""Streaming outline/whole authoring and entry to the chapter/delta coordinator."""
import argparse
import asyncio
import json
from pathlib import Path
import re
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'lib'))
import slr_paths
slr_paths.bootstrap(__file__)
from task_input import task_input
from evidence import ensure, read, save
from generation_errors import GenerationError, diagnostic
from writing_prompt_guidance import OUTLINE_WRITING_GUIDANCE, TASK_GUIDANCE as SYSTEM


from chapter_plan import GUIDANCE as ANALYTICAL_PLANNING_GUIDANCE

from figure_caption import CAPTION_CONTENT_GUIDANCE

OUTLINE_PROTOCOL = r'''Plan the requested document and return one JSON object.

DOCUMENT AND CHAPTER STRUCTURE
The root has survey_title (may be empty for a component), topic, description,
outline_tree, review_thesis, organizing_axis and prerequisites. An unsectioned
component may use outline_tree=[] with a nonempty description; do not manufacture
a chapter. Optional warnings contains concrete unresolved issues.
Required_outline_nodes and structure_contract are binding: include a required
abstract as section_id "0" in this response and omit forbidden sections.

Use two distinct node shapes, not one recursive chapter template:
- L1 chapter: section_id (unique numeric string), title, description, language,
  role, paper_ids, requires, analysis_tasks; optional depends_on, subsections,
  figures and tables. language is default|chinese|english, normally default.
  An explicit user chapter exception alone justifies chinese or english; academic
  convention does not make an abstract English.
- L2 subsection: section_id (parent.child, e.g. "2.1"), title, description;
  optional paper_ids, figures and tables. Its language is inherited from L1;
  omit the language key entirely, including null, default or the parent's value.
  There is no third outline level.
Section choices follow the task, with no paper quotas, word budgets or claim lists.
Do not put References, Bibliography or 参考文献 in outline_tree at either level.
The publisher supplies that list, including when the user requests complete
references. A literature-comparison or related-work chapter is different.

ASSET PLANNING
Plan supported figures and tables where they help the owning section's argument.
Respect requested counts and exclusions; there is no default asset quota. Nest
an asset under its exact L1 or L2 owner once, with a globally unique F/T ID.
A sectioned document has no root figures/tables, even with section_id fields.
For an unsectioned table-only component, root tables is allowed with null ownership;
root figures is not supported. Assets are referenced within their owning chapter.

Each asset has purpose (why needed), content_plan (objects/relations or candidate
rows and comparison scope), caption_draft (reader-facing content), paper_ids
(supporting IDs), optional qualifications (assumptions/comparability/illustration).
Figures have figure_id and optional visual_guidance for style, label language,
palette or metaphor; this drawing guidance stays separate from scientific content.
Tables have table_id, row_unit and comparison_dimensions; the final columns are
[row_unit, *comparison_dimensions]. Choose clear labels and relevant conditions.
Use real paper IDs; [] leaves the selected corpus eligible, never invented evidence.
Final table rows/cells and image prompts belong to later authoring.
''' + '\n' + CAPTION_CONTENT_GUIDANCE + r'''

STRUCTURAL EXAMPLE
The example illustrates field placement, not required content or an asset quota.
Replace its content and IDs with the actual task and evidence.
{"survey_title":"Review","topic":"Methods","description":"Review the methods",
 "review_thesis":"Which conditions distinguish the methods?",
 "organizing_axis":"Mechanisms and conditions","prerequisites":[],
 "outline_tree":[{"section_id":"2","title":"Mechanisms","description":"Compare mechanisms","language":"default",
   "role":"analysis","paper_ids":["p1"],"requires":[],
   "analysis_tasks":[{"task_id":"A1","kind":"compare","question":"Which conditions distinguish the mechanisms?","completion":"Explain supported differences and limits."}],
   "figures":[{"figure_id":"F1","purpose":"Explain the relationship",
     "content_plan":"Show supported objects and their directed relationship",
     "caption_draft":"The objects form a conditional relationship.",
     "visual_guidance":"Use the requested visual style","paper_ids":[]}],
   "subsections":[{"section_id":"2.1","title":"Conditions","description":"Compare conditions",
     "tables":[{"table_id":"T1","purpose":"Compare methods under their assumptions",
       "content_plan":"Rows represent methods and applicable assumptions",
       "caption_draft":"Methods differ in mechanism and assumptions.",
       "row_unit":"Method","comparison_dimensions":["Assumptions"],"paper_ids":[]}]}]}]}
''' + '\n' + OUTLINE_WRITING_GUIDANCE + '\n' + ANALYTICAL_PLANNING_GUIDANCE + r'''

FINAL STRUCTURE CHECK
Before returning, check L1 and L2 separately: only L1 contains language; L2 has no
language key. For a nonempty outline_tree, root figures/tables are absent and each
F/T ID occurs once beneath its exact owner. Captions start with their subject,
without a figure/table number. Check required nodes and real paper IDs against
this task rather than copying the example.
'''

def parse_response(text):
    text = text.strip()
    if text.startswith('```') and text.endswith('```'):
        text = re.sub(r'^```(?:json)?\s*\n?', '', text, count=1).rsplit('```', 1)[0].strip()
    try: value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GenerationError('JSON_INVALID', exc.msg, f'line {exc.lineno}, column {exc.colno}') from exc
    if not isinstance(value, dict): raise GenerationError('SCHEMA_INVALID', 'model output must be a JSON object')
    return value


from request_capacity import capacity


async def invoke(ws, stage, messages, cfg, identity=None, client=None, json_output=True):
    counts = capacity(messages, cfg)
    owns_client = client is None
    request_id = uuid.uuid4().hex
    folder = ws/'_logs/llm'/request_id
    safe_config = {k:v for k,v in cfg.items() if k not in ('api_key', 'authorization', 'headers')}
    save(folder/'request.json', {'stage':stage, 'messages':messages, 'config':safe_config,
         'capacity':counts,
         'sdk_max_retries':0, 'cli_reasoning_effort':None, 'api_thinking':cfg.get('thinking', False)})
    if client is None:
        from runtime_model_client import runtime_available
        if not runtime_available() and not cfg.get('api_key'):
            raise GenerationError('API_AUTH','SCHOLARSEED_ACCOUNT_TOKEN is required')
        from light_llm import create_llm
        client = create_llm(cfg.get('provider'), model=cfg['model'], base_url=cfg.get('base_url'),
                 thinking=cfg.get('thinking', False), timeout=cfg.get('timeout', 600),
                 default_max_tokens=cfg['max_tokens'], default_temperature=cfg.get('temperature', .2), max_retries=0,
                 workspace=ws)
        client.cache_bust = False
    try:
        attempts = []
        maximum = 1 if getattr(client,'uses_runtime',False) else cfg.get('max_attempts', 2)
        if type(maximum) is not int or not 1 <= maximum <= 3:
            raise GenerationError('SCHEMA_INVALID', 'max_attempts must be 1–3')
        for number in range(1, maximum+1):
            started = time.monotonic(); capture = {}; text = ''; error = None; retry = False
            try:
                from stream_progress import StreamProgress
                async with StreamProgress(ws,stage,folder,number) as progress:
                    async with asyncio.timeout(cfg.get('request_deadline_sec',1800)):
                        text = await client.chat_stream(messages, _capture=capture, _capture_raw=True,
                            _on_chunk=progress.chunk, **({'response_format':{'type':'json_object'}} if json_output else {}),
                            max_tokens=cfg['max_tokens'],temperature=cfg.get('temperature',.2))
                if capture.get('finish_reason') == 'length':
                    raise GenerationError('OUTPUT_TRUNCATED', 'generation reached output capacity; main must decide the next action')
                if capture.get('finish_reason') is None:
                    raise GenerationError('STREAM_INTERRUPTED', 'stream ended without a completion event')
                if capture.get('finish_reason') != 'stop':
                    raise GenerationError('SCHEMA_INVALID', 'unexpected completion reason: '+str(capture.get('finish_reason')))
            except Exception as exc:
                if isinstance(exc, GenerationError):
                    error = exc; retry = exc.code in ('STREAM_INTERRUPTED','API_TIMEOUT')
                elif getattr(exc,'runtime_failure',False):
                    error=GenerationError(exc.code,str(exc),str(folder));retry=False
                else:
                    status = getattr(exc, 'status_code', None)
                    name = type(exc).__name__
                    code = ('API_AUTH' if status in (401,403) else 'API_RATE_LIMIT' if status == 429 else
                            'API_TIMEOUT' if 'Timeout' in name else 'STREAM_INTERRUPTED' if status is None else 'API_ERROR')
                    # Never put gateway error text/headers into stdout (could echo a token).
                    error = GenerationError(code, f'{name}; HTTP status {status}', str(folder))
                    retry = status in (408,429,500,502,503,504) or 'Timeout' in name or 'Connection' in name
            finally:
                save(folder/f'attempt-{number}.response.txt', text or capture.get('partial_response', ''))
                if capture.get('request') is not None:
                    save(folder/f'attempt-{number}.request.json', capture['request'])
                if capture.get('raw_chunks') is not None:
                    save(folder/f'attempt-{number}.chunks.json', capture['raw_chunks'])
                item = {'attempt':number, 'elapsed_sec':round(time.monotonic()-started,3),
                        'finish_reason':capture.get('finish_reason'), 'usage':capture.get('usage'),
                        'response_models':capture.get('response_models', []), 'error':error.report() if error else None}
                if getattr(client,'uses_runtime',False):
                    item.update(transport='runtime',retry_owner='runtime',
                                runtime_transport=capture.get('runtime_transport'),
                                runtime_options_omitted=capture.get('runtime_options_omitted',[]),
                                runtime_cleanup_error=capture.get('runtime_cleanup_error'))
                # Keep the raw response text and protocol metadata, not provider reasoning.
                save(folder/f'attempt-{number}.json', item); attempts.append(item)
                save(folder/'attempts.json', attempts)
            if error is None:
                try: value = parse_response(text) if json_output else text
                except GenerationError as exc:
                    item['error'] = exc.report()
                    save(folder/f'attempt-{number}.json', item); save(folder/'attempts.json', attempts)
                    raise
                return value, {'request_id':request_id, 'log_dir':str(folder), 'model_calls':len(attempts),
                     'elapsed_sec':round(sum(a['elapsed_sec'] for a in attempts),3),
                     'usage':[a['usage'] for a in attempts], **counts}
            if not retry or number == maximum: raise error
            await asyncio.sleep(min(2 ** number, 8))
    except GenerationError as exc:
        exc.context.update(model_calls=len(attempts),log_dir=str(folder))
        raise
    finally:
        if owns_client and getattr(client,'async_client',None) is not None:
            await client.async_client.close()


async def generate(ws, stage, request=None, cfg=None, client=None):
    stage_started = time.monotonic()
    ws = Path(ws)
    if stage=='manuscript':
        from chapter_pipeline import generate as generate_chapters
        return await generate_chapters(ws,chapter_cfg=cfg,refine_cfg=cfg,client=client)
    task = task_input(ws, request)
    if stage=='outline' and (ws/'04_outline/outline.json').exists():
        from manuscript import validate_plan
        current=read(ws/'04_outline/outline.json')
        try:validate_plan(ws,current)
        except (ValueError,KeyError,TypeError) as exc:
            raise GenerationError('OUTLINE_REVISION_REQUIRED',str(exc),str(ws/'04_outline/outline.json'),
                next_action='Main edits the current complete outline, then uses outline configure; no further outline model call.') from exc
        return {'status':'SUCCESS','stage':'outline','state':'existing_outline','model_calls':0,
                'artifact':str(ws/'04_outline/outline.json'),
                'next_action':'Display outline review-packet; main performs any requested revision through outline configure, without another LLM call.'}
    from output_spec import read_output_spec
    spec = read_output_spec(ws)
    if spec.get('spec_error'): raise GenerationError('SCHEMA_INVALID', spec['spec_error'])
    context = {'task':task, 'stage':stage, 'output_format':spec['format'], 'structure_contract':task['structure']}
    if stage == 'outline':
        context['required_outline_nodes'] = [{**v,'section_id':'0'} if v.get('role')=='abstract' else v for v in task['structure']['required_sections']]
    evidence = ensure(ws, 'outline')
    context['evidence'] = Path(evidence['artifacts'][1]).read_text(encoding='utf-8')
    # Keep full evidence intact while placing the current generative target last.
    context = {'evidence':context['evidence'],
               **{k:v for k,v in context.items() if k not in ('evidence','task')},
               'task':context['task']}
    protocol = OUTLINE_PROTOCOL
    messages = [{'role':'system','content':SYSTEM+protocol},
                {'role':'user','content':json.dumps(context, ensure_ascii=False)}]
    if cfg is None:
        from load_model_config import load_stage_config
        cfg = load_stage_config(stage+'_generation')
    if not cfg: raise GenerationError('INPUT_MISSING', 'model stage is not configured: '+stage+'_generation')
    value, metrics = await invoke(ws, stage, messages, cfg, client=client)
    candidate = Path(metrics['log_dir'])/'candidate.json'; save(candidate, value)
    if stage == 'outline':
        from manuscript import validate_plan
        from submission_normalization import outline_assets
        try:
            value = outline_assets(value)
            validate_plan(ws, value, preparing=True)
        except (ValueError, KeyError, TypeError) as exc:
            report=diagnostic(exc)
            raise GenerationError(report['code'],report['message'],report.get('location'),
                                  candidate_path=str(candidate),log_dir=metrics['log_dir'],
                                  model_calls=metrics['model_calls'],
                                  outline_recovery={
                                      'strategy':'repair_saved_candidate',
                                      'request':str(candidate),
                                      'command':'outline configure --request <repaired-complete-outline.json>',
                                      'rerun_model_only_if':'candidate is truncated/unreadable or needs a substantive scientific redesign'},
                                  next_action=('Main repairs all named validation errors in the saved candidate, '
                                      'then submits the complete result with outline configure --request; '
                                      'do not rerun outline generation for local schema, ID, enum, caption, '
                                      'duplication or ownership errors.')) from exc
        target = ws/'04_outline/outline.json'; save(target, value)
        from manuscript import run_script
        run_script(ws, 'scripts/outline/render_outline_md.py', str(ws))
    result = {'status':'SUCCESS', 'stage':stage, 'artifact':str(target), **metrics,
              'stage_elapsed_sec':round(time.monotonic()-stage_started,3),
              'model_wait_sec':metrics['elapsed_sec'],
              'rules_only':True, 'scientific_review_complete':False,

              'next_action':'Run outline review-packet and show its hierarchical outline_markdown with nested figure/table IDs and captions, then honor the approval policy.' if stage=='outline' else 'Join figure assets, publish, and run rule verification.'}
    save(ws/f'_logs/{stage}_generation.json', result)
    return result


def main():
    p = argparse.ArgumentParser(); p.add_argument('stage', choices=['outline','manuscript'])
    p.add_argument('--workspace', required=True); p.add_argument('--request'); args = p.parse_args()
    ws = Path(args.workspace).resolve()
    try: result = asyncio.run(generate(ws, args.stage, __import__('task_contract').json_input(args.request) if args.request else None))
    except (ValueError, OSError, TypeError, KeyError, RuntimeError) as exc:
        result = diagnostic(exc); save(ws/f'_logs/{args.stage}_generation.json', result)
    print(json.dumps(result, ensure_ascii=False)); return int(result['status']=='FAILED')


if __name__ == '__main__': sys.exit(main())
