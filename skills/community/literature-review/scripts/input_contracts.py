"""On-demand public input descriptions and local, actionable input errors."""
from pathlib import Path
import copy
import json
import re
from citation_styles import style_ids
from task_contract import VERBATIM_MATCH_PERCENT, VERBATIM_MATCH_THRESHOLD

ROOT=Path(__file__).resolve().parents[1]
INTERNAL_ERROR_CODE = "INTERNAL_ERROR"
OPERATIONS=('writing.configure','writing.approve','outline.configure',
            'figures.plan','evidence.build','papers.import-local',
            'writing.review-complete','writing.review-start','writing.review-status','writing.review-wait','writing.review-response','writing.review-timeout')


def examples(operation):
    return json.loads((ROOT/'schema/input_examples.json').read_text())[operation]


def describe_input(operation,workspace=None):
    if operation not in OPERATIONS:
        raise ValueError('Input descriptions are available for '+', '.join(OPERATIONS))
    from task_contract import REQUEST_FIELDS,RETRIEVAL_FIELDS,PUBLICATION_FIELDS,TIME_RANGE_FIELDS,KINDS
    from chapter_plan import ROLES,KINDS as ANALYSIS_KINDS
    from operator_cli import APPROVAL_FIELDS,FIGURE_RENDER_FIELDS
    from local_papers import LOCAL_FILE_FIELDS
    result={'status':'SUCCESS','operation':operation,'read_only':True,
            'examples':examples(operation),
            'schema_note':'fields/node/asset describe inputs; these metadata objects are not request payloads. Use the JSON shapes in examples.',
            'example_policy':'Examples describe shapes, not new requirements. Use real user quotes, IDs, files and task scope; preserve existing follow-up history and constraints.'}
    publication={'format':['latex_pdf','markdown'],'template':{'type':'string','allowed':['ctexart','neurips'],
                 'example':'ctexart','value_note':'Pass the string itself, e.g. "template":"ctexart"; never {"type":"ctexart"}.',
                 'by_language':{'CHINESE':'ctexart','ENGLISH':'neurips'}},
                 'citation_style':list(style_ids())}
    asset={'required':['purpose','content_plan','caption_draft','paper_ids'],
           'purpose':'string: contribution to owning section','content_plan':'string: supported objects/relations or comparison scope',
           'caption_draft':'string: descriptive reader-facing content, no figure/table numbering prefix or drawing instructions',
           'paper_ids':'array of selected paper IDs; [] permits the selected corpus as eligible evidence',
           'qualifications':'optional array of assumption/limitation strings',
           'figures':{'figure_id':'unique F1-style ID','visual_guidance':'optional style/label-language instructions'},
           'tables':{'table_id':'unique T1-style ID','row_unit':'string: first column',
                     'comparison_dimensions':'array of strings; remaining columns'}}
    if operation=='writing.configure':
        fields={'intent':'immutable original user request, supplied by init',
          'language':['CHINESE','ENGLISH'],'user_requests':'ordered array of actual verbatim follow-ups',
          'effective_requirements':'string; required with user_requests',
          'user_instructions':'string of actual user instructions',
          'stage_instructions':'optional string; cannot override the task',
          'output_scope':['survey','section'],'selected_section_ids':'unique top-level numeric-string IDs, e.g. ["3"]; section scope only',
          'section_instructions':'object mapping top-level section IDs to strings',
          'outline_review':['required','auto','timeout_auto'],'auto_authorization':'actual user quote required for immediate survey auto continuation',
          'review_timeout_seconds':'300 only; timeout_auto waits five minutes after actual display. New full-survey tasks default to timeout_auto; existing required/auto policies are preserved.',
          'writing_strategy':['chapter_delta','whole'],
          'chapter_concurrency':'integer 1..8; compatibility field, native chapters launch concurrently',
          'length_min':'optional positive integer','length_max':'optional positive integer >= length_min',
          'length_target':'optional positive integer','length_unit':['words','cjk_chars','characters','pages'],
          'retrieval':{'allowed_fields':sorted(RETRIEVAL_FIELDS),'corpus_size':{'target':'positive integer','min':'optional positive integer','max':'optional positive integer >= min'},
                       'dimensions':'array of search dimensions','time_range':{k:'optional integer year' for k in sorted(TIME_RANGE_FIELDS)},
                       'temporal_policy':'soft_preference','mode':'balanced by default; explicit user choice wins'},
          'publication':publication,'local_pdfs':{'type':'array of paths or per-file objects','allowed_file_fields':sorted(LOCAL_FILE_FIELDS)},
          'constraints':{'type':'array; replaces the entire current constraint list',
                         'required':['id','kind','value','verbatim'],'id':'unique nonempty string',
                         'kind':sorted(KINDS),'verbatim':f'string grounded in one original source: prefer a contiguous quote; a shortened or lightly normalized quote must preserve more than {VERBATIM_MATCH_PERCENT}% of its characters in order from intent, user_instructions, or one user_requests entry; effective_requirements is not a source',
                         'values':{'required_section / forbidden_section':{'title':'nonempty string','role':sorted(ROLES),'position':'first, last, any, after:<title>; role/position optional'},
                                   'figure_count / table_count / total_citations':'object with nonnegative min and/or max',
                                   'min_papers_per_section / min_paper_citations':'nonnegative integer',
                                   'venue_whitelist':'nonempty string array','must_include_paper':'object with title',
                                   'excluded_topic / angle / other':'nonempty string'}}}
        assert set(fields)==REQUEST_FIELDS
        result.update(fields=fields,required=[],merge_policy='publication/retrieval merge immediate keys; other supplied fields replace; original intent/history must be preserved',
                      publication_example={'format':'latex_pdf','template':'ctexart','citation_style':'numeric'},
                      verbatim_example={'source':'结构按问题建模→单一方法→混合方法→挑战展望展开。',
                                        'valid':['结构按问题建模→单一方法→混合方法→挑战展望展开。','问题建模→单一方法→混合方法→挑战展望'],
                                        'invalid':'增加实验和消融分析',
                                        'reason':f'Use one original source and retain more than {VERBATIM_MATCH_PERCENT}% ordered character coverage; do not quote derived effective_requirements.'},
                      strategy_note='whole is a legacy value; both values use the same native chapter/delta pipeline')
    elif operation.startswith('writing.review-'):
        fields={'packet_id':'actual current review-packet ID'}
        required=['packet_id']
        if operation=='writing.review-complete':
            fields.update(snapshot_id='unchanged bridge snapshot identity', request_id='actual product HIL request ID',
                          started_at='product start timestamp', deadline_at='product deadline or null',
                          decision='unchanged product HIL decision; never fabricate an answer or timeout')
            required=list(fields)
        elif operation=='writing.review-start':
            fields.update(displayed='true only after showing the outline, publication settings and timeout notice',
                          message_id='optional actual host display message ID; omit if unavailable')
            required.append('displayed')
        elif operation=='writing.review-response':
            fields.update(user_response='actual nonempty user reply; includes pause, cancellation and revision requests',
                          message_id='optional actual user message ID')
            required.append('user_response')
        elif operation=='writing.review-wait':
            fields['wait_seconds']='optional integer 0..30; default 30. Observation only; never silently approves.'
        result.update(required=required,fields=fields,
                      cli_options={'--packet-id':'alternative to packet_id in --request',
                                   '--wait-seconds':'alternative to wait_seconds for review-wait only'},
                      host_contract='Start after actual display. Persist/schedule deadline_at or keep an interruptible wait active. Record user input before processing a timeout. Timeout output includes a deduplicatable notice_id and decision_id; no fake user_response and no generation is launched by these commands.')
    elif operation=='writing.approve':
        result.update(required=['packet_id','user_response'],fields={k:{
            'packet_id':'copy from the displayed review packet','user_response':'actual nonempty user response',
            'publication':publication,'message_id':'optional actual host message ID'}[k] for k in sorted(APPROVAL_FIELDS)})
    elif operation=='outline.configure':
        result.update(required=['survey_title','topic','description','outline_tree'],
          fields={'survey_title':'string; may be empty for an unsectioned component','topic':'string','description':'task description',
                  'review_thesis':'nonempty review question/argument for a sectioned document',
                  'organizing_axis':'nonempty organizing principle for a sectioned document',
                  'prerequisites':'array, may be empty','outline_tree':'ordered top-level nodes; [] for unsectioned component'},
          node={'required':['section_id','title','description','role','paper_ids','requires','analysis_tasks'],
                'section_id':'unique numeric string, e.g. 2','title':'reader-facing string','description':'scope and argumentative purpose',
                'language':'default, chinese or english; default inherits the writing contract language',
                'role':sorted(ROLES),'paper_ids':'array of actual selected IDs; substantive chapters need evidence allocation',
                'requires':'array of declared prerequisite IDs','depends_on':'optional top-level IDs; no self-reference/cycles',
                'analysis_tasks':'array; analysis role needs at least one',
                'subsections':{'type':'optional one-level array','required':['section_id','title','description'],
                               'section_id':'numeric child path, e.g. 2.1','paper_ids':'optional selected IDs'},
                'figures':'optional nested figure plans','tables':'optional nested table plans'},
          analysis_task={'required':['task_id','kind','question','completion'],'task_id':'unique string',
                         'kind':sorted(ANALYSIS_KINDS),'question':'nonempty string','completion':'nonempty criterion','axes':'optional string array'},
          prerequisite={'required':['id','kind','requirement','owner_section_id'],'id':'unique string',
                        'kind':['concept','notation','problem','evaluation','protocol'],'requirement':'nonempty string',
                        'owner_section_id':'existing nonterminal section/subsection ID','paper_ids':'optional selected IDs'},
          asset=asset,
          ownership='Nest assets under their owner. A chapter-owned asset may appear in that chapter or its subsections; a subsection-owned asset must stay within that subsection, not a sibling or another chapter. Ownership follows source structure, not the PDF float page. Root assets only for an unsectioned component. F/T IDs are unique.',
          next_action='Main edits the current complete outline and submits outline configure --request FILE; this validates without an LLM. Do not rerun outline generate for revisions.')
    elif operation=='figures.plan':
        from validate_figures_meta import (_VALID_MODES,_VALID_IMAGE_SIZES,_CHART_SPEC_REQUIRED,
                                           _CHART_SPEC_OPTIONAL,supported_statistics,supported_chart_types)
        result.update(required=['preparation_id','items'],fields={'preparation_id':'copy from figure brief','items':'nonempty array of rendering updates'},
          item={'required':['figure_id','_render_mode','_caption'],'figure_id':'actual prepared figure ID',
                'allowed_render_fields':sorted(FIGURE_RENDER_FIELDS),'_render_mode':list(_VALID_MODES),
                '_caption':'nonempty plain caption, no numbering prefix/LaTeX/cite keys',
                '_prompt':'nonempty for image; null otherwise','_latex_body':'nonempty forest body for forest_taxonomy; null otherwise',
                '_image_size':sorted(_VALID_IMAGE_SIZES)},
          chart_spec={'required':list(_CHART_SPEC_REQUIRED),'optional':list(_CHART_SPEC_OPTIONAL),
                      'statistic':list(supported_statistics() or []),'chart_type':list(supported_chart_types() or []),
                      'types':'text strings except top_n (integer or numeric string); no inline data arrays or fabricated counts'})
    elif operation=='evidence.build':
        from evidence import OPTIONAL
        result.update(required=[],fields={'extra_fields':{'type':'array of strings','allowed':sorted(OPTIONAL)},
                                         'max_input_bytes':'optional positive integer; excess input fails without clipping'},
                      cli_options={'view':['outline','writing']},
                      next_action='Use only for an explicit evidence-view need, not as a routine readiness gate.')
    else:
        result.update(required=['files'],fields={'files':{'type':'array of local paths or per-file metadata objects',
            'required_file_fields':['path'],'allowed_file_fields':sorted(LOCAL_FILE_FIELDS),
            'path':'PDF or directory; directory entries cannot carry paper metadata',
            'authors':'array of real author-name strings','year':'four-digit integer',
            'title / doi / abstract':'optional actual source strings; unknown metadata stays absent'}})
    if workspace:
        ws=Path(workspace)
        if operation=='outline.configure':
            p=ws/'04_outline/outline.json'
            if p.is_file():result['current_outline']=json.loads(p.read_text())
            p=ws/'02_retrieval/selected_paper.json'
            if p.is_file():result['available_paper_ids']=list(json.loads(p.read_text()))
        if operation=='writing.approve' or operation.startswith('writing.review-'):
            p=ws/'04_outline/review_packet.json'
            if p.is_file():result['current_packet_id']=json.loads(p.read_text()).get('packet_id')
        if operation=='figures.plan':
            p=ws/'05_generation/_internal/figure_brief.json'
            if p.is_file():
                brief=json.loads(p.read_text());result['current_preparation_id']=brief['preparation_id']
                result['prepared_figure_ids']=[f['figure_id'] for f in brief.get('figures',[])]
    return result


def input_error(operation,error):
    """Keep errors small: only the named field/example plus a discovery command."""
    message=str(error)
    if isinstance(error, KeyError):
        return {'status': 'FAILED', 'code': INTERNAL_ERROR_CODE, 'message': message,
                'error_type': type(error).__name__,
                'next_action': 'Preserve the current input and publication settings. Stop and report this internal skill error; do not substitute another citation style.'}
    result={'status':'FAILED','code':'INPUT_INVALID','message':message}
    if hasattr(error,'report'):result.update(error.report())
    if isinstance(error,BlockingIOError):
        return {'status':'FAILED','code':'STATE_BUSY','message':message,
                'next_action':'Retry the same state operation after the current writer finishes. Preserve queued user input and do not start a duplicate workflow.'}
    if operation not in OPERATIONS:return result
    result['describe_input']='slr '+operation.replace('.',' ')+' --describe-input'
    result['next_action']='Correct the named input; query describe_input only if its shape is unclear.'
    sample=examples(operation)[0]
    if operation in ('writing.configure','writing.approve') and message.startswith('publication.template'):
        result.update(field='publication.template',expected_type='string',allowed=['ctexart','neurips'],
                      example={'publication':{'template':'ctexart'}},
                      next_action='Use a template string supported by the current language/environment; do not wrap it in a type object.')
        return result
    if operation=='writing.configure':
        if index:=re.search(r'constraints/(\d+)(?:/verbatim:|: verbatim\b)',message):
            result.update(field=f'constraints[{index[1]}].verbatim',
                          quote_sources=['intent','user_instructions','user_requests[]'],
                          match_threshold=VERBATIM_MATCH_THRESHOLD,
                          next_action=f'Ground the value in one original source. Prefer a direct quote; otherwise retain more than {VERBATIM_MATCH_PERCENT}% of its characters in order. Use separate constraints for unrelated requirements.')
        elif 'time_range' in message or 'year' in message:
            result.update(field='retrieval.time_range',example={'retrieval':{'time_range':{'start_year':2010,'end_year':2020}}})
        elif 'corpus' in message:
            result.update(field='retrieval.corpus_size',example={'retrieval':{'corpus_size':{'target':40}}})
        elif 'role' in message or 'position' in message:
            from chapter_plan import ROLES
            result.update(field='constraints[].value',allowed_roles=sorted(ROLES),
                          example={'title':'Methods','role':'analysis','position':'any'})
        elif 'constraints' in message:
            result.update(field='constraints',example=next(e for e in examples(operation) if 'constraints' in e)['constraints'][0])
        else:
            from task_contract import REQUEST_FIELDS
            result.update(allowed_fields=sorted(REQUEST_FIELDS),example=sample)
    elif operation=='outline.configure':
        from chapter_plan import ROLES,KINDS
        if 'role' in message:result.update(field='outline_tree[].role',allowed=sorted(ROLES),example='analysis')
        elif 'analysis_task' in message or 'analytical' in message:
            result.update(field='outline_tree[].analysis_tasks',allowed_kinds=sorted(KINDS),
                          example=sample['outline_tree'][2]['analysis_tasks'][0])
        else:result['input_hint']='Submit the entire current outline; describe_input supplies node/asset fields and current_outline. Main performs revisions without another LLM call.'
    else:result['example']=copy.deepcopy(sample)
    return result
