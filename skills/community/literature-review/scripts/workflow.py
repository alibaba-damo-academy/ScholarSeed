"""Advance existing commands to explicit main-agent decision boundaries.

No new model prompts, retries, implicit approvals or generation cache policy.
Starting from a named stage is explicit: this runner never guesses freshness.
"""
import json
import sys
from pathlib import Path

from main_view import compact
from platform_io import run_stream
from usage import summarize
from lifecycle import OperationBlocked, operation, read_status
from platform_runtime import utf8_env
from recovery import files, digest
from reading import load, material_selection

from platform_io import file_lock
from paper_materials import is_quick
from task_contract import read_request

EVIDENCE = ('retrieval_adapt', 'fulltext', 'processing', 'outline', 'review-packet')
RESUME_INPUTS = {
    'retrieval_adapt': ('02_retrieval/metadata.json', '02_retrieval/local_papers.json', '02_retrieval/material_papers.json'),
    'fulltext': ('02_retrieval/reading_assets.json',),
    'processing': ('02_retrieval/reading_assets.json', '02_retrieval/paper_info.json', '02_retrieval/fulltext_report.json'),
    'outline': ('03_process/paper_cards.json', '03_process/cite_keys.json', '03_process/references.bib', '03_process/cards_index.jsonl'),
    'review-packet': ('04_outline/outline.json', '04_outline/output_spec.json'),
}


def resume_guard(ws, stage):
    selected = load(Path(ws) / '02_retrieval/selected_paper.json', {})
    if stage in ('fulltext', 'processing', 'retrieval_adapt'):
        selected = {pid: material_selection(paper) for pid, paper in selected.items()}
    return digest({'selection': selected, 'inputs': files(ws, (
        '01_input/writing_request.json', *RESUME_INPUTS[stage]))})

FULLTEXT_AUTHORIZATION_BOUNDARY = 'fulltext_authorization'
ABSTRACT_CHECKPOINT_BOUNDARY = 'retrieval_checkpoint'
FULLTEXT_AUTHORIZATION_ACTION = (
    'Complete the product-owned full-text authorization checkpoint, then resume with '
    '`workflow evidence --from fulltext`.'
)


def execute(ws, command):
    root = Path(__file__).resolve().parent
    log = ws / '_logs/workflow.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    rc, stdout = run_stream([sys.executable, str(root / 'slr.py'), *command,
                            '--workspace', str(ws), '--full'],
                           ws, log, utf8_env(), None, stderr_to_log=True)
    try:
        report = json.loads(stdout)
        if not isinstance(report, dict):
            raise ValueError('expected a JSON object')
    except ValueError:
        path = ws / '_logs/workflow-unparsed.log'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(stdout)
        report = {'status': 'FAILED', 'code': 'WORKFLOW_OUTPUT_INVALID', 'log': str(log), 'stdout_log': str(path)}
    return rc, report


def retrieval_summary(ws):
    path = ws / '02_retrieval/retrieval_report.json'
    report = json.loads(path.read_text())
    flagged = report.get('flagged_for_review', [])
    from collections import Counter
    return {k: report[k] for k in ('output_count', 'corpus_plan', 'outside_time_range_retained',
            'delegated_exclusions', 'must_include', 'degradations', 'fulltext_candidates',
            'missing_abstracts', 'metadata_filter', 'citation_metadata', 'bibliography_preflight') if k in report} | {
        'drop_counts': dict(Counter(r.get('rule', 'unknown') for r in report.get('dropped', []))),
        'flagged_for_review': flagged, 'report': str(path),
        'interpretation': 'Fulltext misses can use actual abstracts; zero fulltext candidates is not a permission question. '
                          'Review named metadata gaps and unmet requirements; topic exclusions belong to the search subagent. '
                          'A reported search shortfall alone does not require another search or user decision. '
                          'Ask only when proceeding requires changing scope, constraints or delivery commitments.'}


def advance(workspace, phase, start=None, runner=None, resume=False):
    ws = Path(workspace).resolve()
    folder = ws / '_status'
    folder.mkdir(parents=True, exist_ok=True)
    try:
        with operation(ws, 'workflow') as attempt:
            if resume:
                previous = attempt.previous
                current = previous.get('current_stage')
                if start is not None or phase != 'evidence' or previous.get('phase') != phase or current not in EVIDENCE:
                    return attempt.finish({'status': 'FAILED', 'code': 'WORKFLOW_RESUME_UNAVAILABLE',
                        'boundary': 'error', 'message': 'No matching recorded evidence stage; no work started.',
                        'next_action': 'Inspect workflow status and current inputs before choosing an explicit --from stage.'})
                if previous.get('resume_guard') != resume_guard(ws, current):
                    return attempt.finish({'status': 'FAILED', 'code': 'WORKFLOW_RESUME_INPUTS_CHANGED',
                        'boundary': 'error', 'message': 'Recorded upstream inputs changed or lack a dependency receipt; no work started.',
                        'next_action': 'Inspect changed inputs and choose the earliest affected --from stage; preserve completed evidence.'})
                boundary = previous.get('boundary')
                start = (('processing' if is_quick(ws) else 'fulltext') if boundary in (FULLTEXT_AUTHORIZATION_BOUNDARY, 'retrieval_review') else
                         'review-packet' if boundary == 'outline_display' else current)
            return _advance(ws, phase, start, runner or execute, attempt)
    except OperationBlocked as exc:
        return exc.value
    except (KeyboardInterrupt, Exception):
        result = read_status(ws, 'workflow')
        result.update(boundary='error', report=str(folder / 'workflow.json'))
        return result


def _advance(ws, phase, start, runner, attempt):
    if phase == 'evidence':
        start = start or 'retrieval_adapt'
        if start not in EVIDENCE:
            raise ValueError('invalid evidence starting stage')
        stages = EVIDENCE[EVIDENCE.index(start):]
        if is_quick(ws):
            if start == 'fulltext':
                raise ValueError('Quick starts from processing after paper confirmation; it never runs fulltext')
            stages = tuple(stage for stage in stages if stage not in ('fulltext', 'outline', 'review-packet'))
    elif phase == 'publish':
        if start is not None:
            raise ValueError('--from is only supported for workflow evidence')
        stages = ('publish', 'verify_postcheck')
    else:
        raise ValueError('unknown workflow phase')
    result = {'status': 'RUNNING', 'phase': phase, 'steps': [], 'boundary': None}
    path = ws / '_status/workflow.json'

    def finish(boundary, report, status='SUCCESS'):
        result.update(status=status, boundary=boundary, result=report, report=str(path))
        if status in ('FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED'):
            result.update({key: report[key] for key in
                           ('code', 'message', 'status_reason', 'issues', 'next_action', 'failed_substep', 'metadata_repair')
                           if key in report})
        result.update(model_usage=summarize(ws))
        return attempt.finish(result)

    for stage in stages:
        result['current_stage'] = stage
        if phase == 'evidence':
            result['resume_guard'] = resume_guard(ws, stage)
        attempt.save(**result)
        command = (['outline', 'generate' if stage == 'outline' else stage]
                   if stage in ('outline', 'review-packet') else
                   ['manuscript', 'publish'] if stage == 'publish' else ['run', stage])
        rc, report = runner(ws, command)
        result['steps'].append({'stage': stage, 'status': report.get('status'),
                                'detail': report})
        if rc or report.get('status') not in ('SUCCESS', 'PARTIAL_SUCCESS'):
            return finish('error', report, report['status'] if report.get('status') in ('INTERRUPTED', 'RECOVERY_REQUIRED') else 'FAILED')
        if phase == 'evidence':
            result['resume_guard'] = resume_guard(ws, stage)
        if stage in ('fulltext', 'processing'):
            result[stage] = compact(report)
        if stage == 'publish':
            result['deliverable'] = report.get('deliverable')
        if stage == 'retrieval_adapt':
            summary = retrieval_summary(ws)
            result['retrieval'] = summary
            unmet = any(not r.get('found', False) for r in summary.get('must_include', []))
            if report['status'] != 'SUCCESS' or summary['flagged_for_review'] or unmet:
                return finish('retrieval_review', {**summary, 'status_reason': report.get('status_reason', '')}, 'PARTIAL_SUCCESS')
            return finish(
                ABSTRACT_CHECKPOINT_BOUNDARY if is_quick(ws) else FULLTEXT_AUTHORIZATION_BOUNDARY,
                {**summary, 'next_action': ('Publish the prepared abstract corpus through the product retrieval checkpoint, then run workflow evidence --from processing.'
                                          if is_quick(ws) else FULLTEXT_AUTHORIZATION_ACTION)},
            )
        # Fulltext misses are an expected degradation. Processing's existing
        # readiness gate decides whether actual fulltext/abstract evidence works.
        elif report['status'] != 'SUCCESS' and stage != 'fulltext':
            return finish('stage_review', report, 'PARTIAL_SUCCESS')
        writing_ready = (stage == 'processing' and is_quick(ws) or
                         stage == 'review-packet' and
                         read_request(ws).get('outline_review') in ('plan', 'auto'))
        if writing_ready:
            rc, prepared = runner(ws, ['manuscript', 'prepare'])
            result['steps'].append({'stage': 'manuscript_prepare', 'status': prepared.get('status'),
                                    'detail': prepared})
            if rc or prepared.get('status') != 'SUCCESS':
                return finish('error', prepared, 'FAILED')
            return finish('writing_ready', {**prepared,
                'next_action': 'Complete evidence and start writing with the host tracker. '
                               'Run manuscript generate; preparation is complete. '
                               'Delegate the returned figure_brief in Standard when figure_slots are nonempty.'})
        if stage == 'review-packet':
            return finish('outline_display', report)
        if stage == 'verify_postcheck':
            return finish('pdf_inspection' if report.get('visual_review_required',
                          report.get('pages_to_read') or report.get('render_error'))
                          else 'delivery', report)
    raise RuntimeError('workflow ended without a decision boundary')
