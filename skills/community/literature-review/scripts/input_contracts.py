"""On-demand public input descriptions and local, actionable input errors."""
from pathlib import Path
import copy
import json
import re
from citation_styles import style_ids
from task_contract import VERBATIM_MATCH_PERCENT, VERBATIM_MATCH_THRESHOLD, REQUEST_FIELDS, validate_request, publication_view
from strategy import POLICIES, QUICK, STANDARD

ROOT=Path(__file__).resolve().parents[1]
INTERNAL_ERROR_CODE = "INTERNAL_ERROR"
OPERATIONS=('progress','writing.configure','writing.approve','outline.configure',
            'writing.plan-packet','writing.plan-resolve',
            'figures.plan','evidence.build','evidence.read','papers.import-local','papers.import-selected','outline.import',
            'writing.review-complete','writing.review-start','writing.review-status','writing.review-wait','writing.review-response','writing.review-timeout')
INIT_FIELDS = {
    'intent': 'Original task, unchanged; --intent can supply it instead.',
    'execution': 'mode: quick|standard; budget_seconds is an optional advisory time estimate, never an execution cutoff.',
    'deliverable': 'kind + unit; init derives output_scope from unit unless explicitly supplied. Use --field deliverable for supported forms.',
    'sources': 'policy: provided_only|supplement|discover; refs: actual literature:<id> or literature_collection:<id> locators; activation snapshots collection members.',
    'publication': 'format and optional template/citation_style; inspect the named field as needed.',
    'constraints': 'Explicit requirements only: id, kind, value, verbatim. Inspect constraints.values.<kind> for its value shape.',
}


def describe_init(mode=STANDARD, field=None):
    if mode not in POLICIES:
        raise ValueError('init mode must be quick or standard')
    contract = describe_input('writing.configure')
    fields = contract['fields']
    if mode == QUICK:
        fields['publication']['format'] = ['markdown']
    result = {'status': 'SUCCESS', 'operation': 'init', 'read_only': True, 'mode': mode,
              'policy': 'Preserve the original task and every explicit requirement. Examples show shapes, not additional requirements. '
                        'Quick uses abstracts and Markdown. Incompatible explicit requirements need a required user choice '
                        'before initializing a changed task; recommending Standard or a timeout is not consent.'}
    if field:
        definition = fields
        for part in field.split('.'):
            if not isinstance(definition, dict):
                raise ValueError('input field has no nested fields: ' + field)
            matches = [key for key in definition if part == key or part in key.split(' / ')]
            if len(matches) != 1:
                raise ValueError('unknown input field: ' + field + '; available here: ' + ', '.join(definition))
            definition = definition[matches[0]]
        return {**result, 'field': field, 'definition': definition}
    publication_defaults = {
        language: publication_view(validate_request({'intent': 'Review the supplied papers.',
                                                     'language': language, 'execution': {'mode': mode}}))
        for language in ('CHINESE', 'ENGLISH')
    }
    return {**result, 'required': ['intent, unless supplied with --intent'],
            'fields': INIT_FIELDS,
            'defaults': {'budget_seconds': POLICIES[mode]['budget_seconds'],
                         'language': 'inferred from the original task; explicit language wins',
                         'publication': publication_defaults,
                         'note': 'Defaults are proposed settings, never attributed to the user.'},
            'examples': [{'intent': 'Review the supplied papers.', 'language': language,
                          'execution': {'mode': mode},
                          'sources': {'policy': 'provided_only', 'refs': ['literature:<actual-selected-id>']},
                          'publication': {key: value for key, value in publication_defaults[language].items()
                                          if value is not None}} for language in publication_defaults],
            'optional_fields': ', '.join(sorted(REQUEST_FIELDS - set(INIT_FIELDS))),
            'full_contract_query': 'writing configure --describe-input',
            'field_query': 'init --mode ' + mode + ' --describe-input --field <path>; '
                           'paths include constraints.values.required_section, constraints.values.table_count, '
                           'publication.citation_style, retrieval.corpus_size and length_unit',
            'submission': 'Put the complete request in one file and run init --workspace <actual cwd-relative stage workspace> --request FILE. '
                          'All fields use the writing request contract; initialization validates them together before creating the task.'}


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
    publication={'format':['latex_pdf','markdown','docx'],'template':{'type':'string','allowed':['standard_chinese','neurips','ieee','iclr','icml','aaai','word'],
                 'example':'standard_chinese','value_note':'Pass the string itself, e.g. "template":"standard_chinese"; never {"type":"standard_chinese"}.',
                 'by_language':{'CHINESE':'standard_chinese','ENGLISH':'neurips'},
                 'by_format':{'docx':'word','latex_pdf':'select by language'}},
                 'citation_style':list(style_ids())}
    asset={'required':['purpose','content_plan','caption_draft','paper_ids'],
           'purpose':'string: contribution to owning section','content_plan':'string: supported objects/relations or comparison scope',
           'caption_draft':'string: descriptive reader-facing content, no figure/table numbering prefix or drawing instructions',
           'paper_ids':'array of selected paper IDs; [] permits the selected corpus as eligible evidence',
           'qualifications':'optional array of assumption/limitation strings',
           'figures':{'figure_id':'unique F1-style ID','visual_guidance':'optional style/label-language instructions'},
           'tables':{'table_id':'unique T1-style ID','row_unit':'string: first column',
                     'comparison_dimensions':'array of strings; remaining columns'}}
    if operation=='progress':
        result.update(fields={'ok':'true from the actual plan/get', 'turn_id':'actual current turn',
                              'plan':'unchanged plan metadata or null', 'items':'complete unchanged flat tree',
                              'actions':'unchanged allowed actions by item ID; required for existing flat plans'},
                      required=['ok','turn_id','plan','items'],
                      output='exact update_plan arguments; --protocol flat is the default; use legacy only for the actual declared older tool. Flat create needs get then start before work; --complete emits only finish, then get and start the next stage. Reuse saved output for an uncertain identical retry')
    elif operation=='writing.plan-packet':
        result.update(required=[], fields={'receipt': 'Use --receipt with the product activation receipt_ref; no response JSON needs to be saved.'},
                      output='Execution plan and actionable material limitations; not a full-text authorization.')
    elif operation=='writing.configure':
        fields={'intent':'immutable original user request, supplied by init',
          'language':['CHINESE','ENGLISH'],'user_requests':'ordered array of actual verbatim follow-ups',
          'effective_requirements':'string; optional on the first request without user_requests; required when user_requests contains verbatim follow-ups, summarizing the updated requirements',
          'user_instructions':'string of actual user instructions',
          'stage_instructions':'optional string; cannot override the task',
          'output_scope':['survey','section'],'selected_section_ids':'unique top-level numeric-string IDs, e.g. ["3"]; section scope only',
          'execution':{'mode':['quick','standard'],'budget_seconds':'positive advisory seconds for progress diagnostics, not a deadline or permission requirement','confirmation':['timeout_auto','required']},
          'deliverable':{'kind':['survey','related_work','chapter','fragment','components'],'unit':['document','chapter','paragraph','components']},
          'sources':{'policy':['provided_only','supplement','discover'],'refs':'optional array of unique actual literature:<id> or literature_collection:<id> locators; preserve collection references for product batch preparation'},
          'section_instructions':'object mapping top-level section IDs to strings',
          'outline_review':['plan','required','auto','timeout_auto'],'auto_authorization':'actual user quote required for immediate survey auto continuation',
          'review_timeout_seconds':'300 only; timeout_auto waits five minutes after actual display. New full-survey tasks default to timeout_auto; existing required/auto policies are preserved.',
          'writing_strategy':['chapter_delta','whole'],
          'chapter_concurrency':'integer 1..8; defaults to 5; maximum simultaneous chapter calls',
          'length_min':'optional positive integer','length_max':'optional positive integer >= length_min',
          'length_target':'optional positive integer','length_unit':['words','cjk_chars','characters','pages'],
          'retrieval':{'allowed_fields':sorted(RETRIEVAL_FIELDS),'corpus_size':{'target':'positive integer','min':'optional positive integer','max':'optional positive integer >= min'},
                       'dimensions':'array of search dimensions','time_range':{k:'optional integer year' for k in sorted(TIME_RANGE_FIELDS)},
                       'temporal_policy':'soft_preference','mode':'balanced by default; explicit user choice wins'},
          'publication':publication,'local_pdfs':{'type':'array of paths or per-file objects','allowed_file_fields':sorted(LOCAL_FILE_FIELDS)},
          'constraints':{'type':'array; replaces the entire current constraint list',
                         'required':['id','kind','value','verbatim'],'id':'unique nonempty string',
                         'kind':sorted(KINDS),'verbatim':f'string grounded in one original source: prefer a contiguous quote; a shortened or lightly normalized quote must preserve more than {VERBATIM_MATCH_PERCENT}% of its characters in order from intent, user_instructions, or one user_requests entry; effective_requirements is not a source',
                         'values':{'required_section / forbidden_section':{'title':'nonempty authored-body title; reference lists are publisher-owned and belong in effective_requirements','role':sorted(ROLES),'position':'first, last, any, after:<title>; role/position optional'},
                                   'figure_count / table_count':'object with nonnegative min and/or max',
                                   'total_citations':'object with nonnegative min and/or max; distinct papers cited in the authored body',
                                   'min_papers_per_section':'nonnegative integer; distinct papers cited per authored section',
                                   'min_paper_citations':'nonnegative integer; upstream citation-count eligibility filter for each candidate, not manuscript reference coverage',
                                   'venue_whitelist':'nonempty string array','must_include_paper':'object with title',
                                   'excluded_topic / angle / other':'nonempty string'}}}
        assert set(fields)==REQUEST_FIELDS
        result.update(fields=fields,required=[],merge_policy='publication/retrieval/execution merge immediate keys; other supplied fields replace; original intent/history must be preserved',
                      publication_example={'format':'latex_pdf','template':'standard_chinese','citation_style':'numeric'},
                      verbatim_example={'source':'结构按问题建模→单一方法→混合方法→挑战展望展开。',
                                        'valid':['结构按问题建模→单一方法→混合方法→挑战展望展开。','问题建模→单一方法→混合方法→挑战展望'],
                                        'invalid':'增加实验和消融分析',
                                        'reason':f'Use one original source and retain more than {VERBATIM_MATCH_PERCENT}% ordered character coverage; do not quote derived effective_requirements.'},
                      strategy_note='Quick uses abstracts only and one Markdown drafting call, without cards, images or format conversion. Standard retains full-text, asset and export capabilities. An incompatible explicit request needs an actual required user choice before changing mode or deliverable.')
    elif operation=='papers.import-selected':
        result.update(required=[], fields={'receipt':'Use --receipt with task.activate receipt_ref from the session working directory'},
                      result='Imports ready papers and preserves pending/duplicate membership. Existing legacy material snapshots remain readable; new per-paper items arrays are rejected.')
    elif operation=='outline.import':
        result.update(required=['request_id','response_path'],fields={'request_id':'actual saved 32-character request ID','response_path':'file containing the raw external model response'})
    elif operation=='writing.plan-resolve':
        result.update(required=[],
            fields={'receipt':'Use --receipt with literature.review plan receipt_ref; code loads the original decision'},
            cli_options={'--action':'proceed, pause or cancel after interpreting an actual answer; omit for product timeout/cancellation',
                         '--patch':'optional JSON file with only requested changes, appended verbatim user_requests and effective_requirements'},
            next_action='Pass receipt_ref directly without saving JSON. Interpret actual free text through --action and --patch. An uncertain retry uses the same reference and arguments.')
    elif operation.startswith('writing.review-'):
        fields={'packet_id':'actual current review-packet ID'}
        required=['packet_id']
        if operation=='writing.review-complete':
            fields={'receipt':'Use --receipt with literature.review outline receipt_ref; code reads the original confirmation'}
            required=[]
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
        if operation=='writing.review-complete':
            result.update(cli_options={'--receipt':'original product receipt_ref; no copied response JSON'},
                          host_contract='The product owns the confirmation wait and saved decision. Consume its receipt_ref, follow can_continue and interpret actual free text. Do not start another timer or question.')
    elif operation=='writing.approve':
        result.update(required=[], fields={'receipt':'Use --receipt with the same outline receipt_ref after review-complete',
                      'publication':publication},
                      next_action='Approve only an actual affirmative answer. Optional --request contains only requested publication changes; the receipt supplies the original answer and identities. Standalone legacy hosts retain the explicit packet_id/user_response contract.')
    elif operation=='outline.configure':
        result.update(required=['survey_title','topic','description','outline_tree'],
          fields={'survey_title':'string; may be empty for an unsectioned component','topic':'string','description':'task description',
                  'review_thesis':'nonempty review question/argument for a sectioned document',
                  'organizing_axis':'nonempty organizing principle for a sectioned document',
                  'outline_tree':'ordered top-level nodes; [] for unsectioned component'},
          node={'required':['section_id','title','description','role','paper_ids','analysis_tasks'],
                'section_id':'unique numeric string, e.g. 2','title':'reader-facing string','description':'scope and argumentative purpose',
                'language':'default, chinese or english; default inherits the writing contract language',
                'role':sorted(ROLES),'paper_ids':'array of actual selected IDs; substantive chapters need evidence allocation',
                'analysis_tasks':'array; analysis role needs at least one',
                'subsections':{'type':'optional one-level array','required':['section_id','title','description'],
                               'section_id':'numeric child path, e.g. 2.1','paper_ids':'optional selected IDs'},
                'figures':'optional nested figure plans','tables':'optional nested table plans'},
          analysis_task={'required':['task_id','kind','question','completion'],'task_id':'unique string',
                         'kind':sorted(ANALYSIS_KINDS),'question':'nonempty string','completion':'nonempty criterion','axes':'optional string array'},
          authoring='Chapters run independently in parallel. Put definitions and evaluation conventions in local descriptions or analytical tasks and assign their supporting papers directly. Preserve document reading order without execution edges.',
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
    elif operation=='evidence.read':
        result.update(fields={'requests': '1..4 objects: paper_id or citation key, question, source=saved|original, optional pages (up to 4), visual boolean, allow_remote boolean'}, required=['requests'],
                      note='No extraction model. Returns source excerpts/pixels and provenance, not a semantic verdict. Remote source acquisition only if local is unavailable.')
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
    samples=examples(operation)
    sample=samples[0] if samples else None
    if operation in ('writing.configure','writing.approve') and message.startswith('publication.template'):
        result.update(field='publication.template',expected_type='string',allowed=['standard_chinese','neurips','ieee','iclr','icml','aaai'],
                      example={'publication':{'template':'standard_chinese'}},
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
    elif sample is not None:result['example']=copy.deepcopy(sample)
    return result
