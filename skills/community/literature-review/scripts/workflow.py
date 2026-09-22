"""Advance existing commands to explicit main-agent decision boundaries.

No new model prompts, retries, implicit approvals or generation cache policy.
Starting from a named stage is explicit: this runner never guesses freshness.
"""
import json
import subprocess
import sys
from pathlib import Path

from task_contract import atomic_json
from main_view import compact

EVIDENCE = ('retrieval_adapt', 'fulltext', 'processing', 'outline', 'review-packet')
FULLTEXT_AUTHORIZATION_BOUNDARY = 'fulltext_authorization'
FULLTEXT_AUTHORIZATION_ACTION = (
    'Complete the product-owned full-text authorization checkpoint, then resume with '
    '`workflow evidence --from fulltext`.'
)


def execute(ws, command):
    root = Path(__file__).resolve().parent
    proc = subprocess.run([sys.executable, str(root / 'slr.py'), *command,
                           '--workspace', str(ws), '--full'],
                          stdout=subprocess.PIPE, text=True)
    try:
        report = json.loads(proc.stdout)
        if not isinstance(report, dict):
            raise ValueError('expected a JSON object')
    except ValueError:
        path = ws / '_logs/workflow-unparsed.log'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(proc.stdout)
        report = {'status': 'FAILED', 'code': 'WORKFLOW_OUTPUT_INVALID', 'log': str(path)}
    return proc.returncode, report


def retrieval_summary(ws):
    path = ws / '02_retrieval/retrieval_report.json'
    report = json.loads(path.read_text())
    flagged = report.get('flagged_for_review', [])
    from collections import Counter
    return {k: report[k] for k in ('output_count', 'corpus_plan', 'outside_time_range_retained',
            'delegated_exclusions', 'must_include', 'degradations', 'fulltext_candidates',
            'missing_abstracts', 'metadata_filter', 'citation_metadata') if k in report} | {
        'drop_counts': dict(Counter(r.get('rule', 'unknown') for r in report.get('dropped', []))),
        'flagged_for_review': flagged, 'report': str(path),
        'interpretation': 'Fulltext misses can use actual abstracts; zero fulltext candidates is not a permission question. '
                          'Review named metadata gaps and unmet requirements; topic exclusions belong to the search subagent. '
                          'A reported search shortfall alone does not require another search or user decision. '
                          'Ask only when proceeding requires changing scope, constraints or delivery commitments.'}


def advance(workspace, phase, start=None, runner=None):
    import fcntl
    ws = Path(workspace).resolve()
    folder = ws / '_status'
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'workflow.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            return _advance(ws, phase, start, runner or execute)
        except (ValueError, OSError, KeyError, TypeError) as exc:
            path = folder / 'workflow.json'
            result = json.loads(path.read_text()) if path.exists() else {'phase': phase, 'steps': []}
            result.update(status='FAILED', boundary='error', report=str(path),
                          result={'status': 'FAILED', 'message': str(exc)})
            atomic_json(path, result)
            return result


def _advance(ws, phase, start, runner):
    if phase == 'evidence':
        start = start or 'retrieval_adapt'
        if start not in EVIDENCE:
            raise ValueError('invalid evidence starting stage')
        stages = EVIDENCE[EVIDENCE.index(start):]
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
        atomic_json(path, result)
        return result

    for stage in stages:
        result['current_stage'] = stage
        atomic_json(path, result)
        command = (['outline', 'generate' if stage == 'outline' else stage]
                   if stage in ('outline', 'review-packet') else
                   ['manuscript', 'publish'] if stage == 'publish' else ['run', stage])
        rc, report = runner(ws, command)
        result['steps'].append({'stage': stage, 'status': report.get('status'),
                                'detail': report})
        if rc or report.get('status') not in ('SUCCESS', 'PARTIAL_SUCCESS'):
            return finish('error', report, 'FAILED')
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
                FULLTEXT_AUTHORIZATION_BOUNDARY,
                {**summary, 'next_action': FULLTEXT_AUTHORIZATION_ACTION},
            )
        # Fulltext misses are an expected degradation. Processing's existing
        # readiness gate decides whether actual fulltext/abstract evidence works.
        elif report['status'] != 'SUCCESS' and stage != 'fulltext':
            return finish('stage_review', report, 'PARTIAL_SUCCESS')
        if stage == 'review-packet':
            return finish('outline_display', report)
        if stage == 'verify_postcheck':
            return finish('pdf_inspection' if report.get('visual_review_required',
                          report.get('pages_to_read') or report.get('render_error'))
                          else 'delivery', report)
    raise RuntimeError('workflow ended without a decision boundary')
