"""Review strategies and deliverable boundaries, independent of the host."""

QUICK = 'quick'
STANDARD = 'standard'
PROVIDED_ONLY = 'provided_only'
SUPPLEMENT = 'supplement'
DISCOVER = 'discover'
CHAPTER = 'chapter'
PARAGRAPH = 'paragraph'
DOCUMENT = 'document'
COMPONENTS = 'components'
POLICIES = {
    QUICK: {'search_mode': 'quick', 'papers': 20, 'budget_seconds': 900,
            'refine': False, 'evidence_kind': 'abstract',
            'blocked_stages': ('fulltext',),
            'stage_scripts': {'processing': ('scripts/quick.py','prepare')},
            'stage_outputs': {'processing': ('03_process/references.bib','03_process/cite_keys.json',
                                             '02_retrieval/fulltext_report.json')}},
    STANDARD: {'search_mode': 'balanced', 'papers': 40, 'budget_seconds': 2400,
               'evidence_concurrency': 20, 'refine': True},
}
KINDS = ('survey', 'related_work', 'chapter', 'fragment', 'components')
UNITS = (DOCUMENT, CHAPTER, PARAGRAPH, COMPONENTS)


def policy(request):
    return POLICIES[request.get('execution', {}).get('mode', STANDARD)]


def require_capabilities(request):
    if request.get('execution', {}).get('mode') != QUICK:
        return
    reasons = []
    if request.get('publication', {}).get('format', 'markdown') != 'markdown':
        reasons.append('non-Markdown delivery')
    if request.get('local_pdfs'):
        reasons.append('PDF input instead of supplied abstracts')
    if request.get('length_unit') == 'pages':
        reasons.append('page-based layout')
    for constraint in request.get('constraints', []):
        if constraint.get('kind') == 'figure_count' and any(value > 0 for value in constraint['value'].values()):
            reasons.append('figures')
    if reasons:
        raise ValueError('Quick supports abstracts and Markdown prose/tables only; incompatible capabilities: '
                         + ', '.join(reasons) + '. Preserve the original requirements; recommend Standard as an alternative and ask for an actual user choice '
                         'before initializing a different mode or deliverable. A recommendation or timeout is not consent.')


def validate_strategy(request):
    if 'execution' in request:
        execution = request['execution']
        if not isinstance(execution, dict) or set(execution) - {'mode', 'budget_seconds', 'confirmation'}:
            raise ValueError('execution accepts mode, budget_seconds and confirmation')
        if execution.get('mode') not in POLICIES:
            raise ValueError('execution.mode must be quick or standard; deep is not implemented')
        execution.setdefault('budget_seconds', policy(request)['budget_seconds'])
        execution.setdefault('confirmation','timeout_auto')
        if execution['confirmation'] not in ('timeout_auto','required'):
            raise ValueError('execution.confirmation must be timeout_auto or required')
        if type(execution['budget_seconds']) is not int or execution['budget_seconds'] <= 0:
            raise ValueError('execution.budget_seconds must be a positive integer')
    if 'sources' in request:
        sources = request['sources']
        if not isinstance(sources, dict) or set(sources)-{'policy','refs'} or 'policy' not in sources:
            raise ValueError('sources requires policy')
        if sources['policy'] not in (PROVIDED_ONLY, SUPPLEMENT, DISCOVER):
            raise ValueError('sources.policy must be provided_only, supplement or discover')
        refs = sources.get('refs', [])
        if not isinstance(refs, list) or any(not isinstance(ref, str) or not ref for ref in refs) or len(set(refs)) != len(refs):
            raise ValueError('sources.refs must be unique actual product reference IDs')
    if 'deliverable' in request:
        deliverable = request['deliverable']
        if not isinstance(deliverable, dict) or set(deliverable) != {'kind', 'unit'}:
            raise ValueError('deliverable requires kind and unit')
        if deliverable['kind'] not in KINDS:
            raise ValueError('deliverable.kind must be one of: '+', '.join(KINDS))
        if deliverable['unit'] not in UNITS:
            raise ValueError('deliverable.unit must be one of: '+', '.join(UNITS))
        expected_scope = 'survey' if deliverable['unit'] == DOCUMENT else 'section'
        if request['output_scope'] != expected_scope:
            raise ValueError('deliverable.unit conflicts with output_scope')
