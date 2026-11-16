"""Product-owned plan decisions before discovery; never a full-text grant."""

import math
import time
import uuid
from pathlib import Path

from confirmation import SECONDS, lock, _read
from task_contract import atomic_json, configure, digest, publication_view, read_request, preview_request
from materials import LOCAL_MANIFEST
from strategy import PROVIDED_ONLY
from layouts import resolve_template
from citation_styles import CITATION_STYLES

PLAN_PACKET = '01_input/plan_packet.json'
PLAN_DECISION = '_status/plan_decision.json'
PLAN_POLICY = 'plan'
APPROVED = 'approved'
RESPONDED = 'responded'
PAUSED = 'paused'
CANCELLED = 'cancelled'
APPLYING = 'applying'
PROCEED = 'proceed'
DECISIONS = {PROCEED: APPROVED, 'pause': PAUSED, 'cancel': CANCELLED}
RECEIPT_FIELDS = {'packet_id', 'snapshot_id', 'request_id', 'started_at', 'deadline_at', 'decision'}
PLAN_RESPONSE_FIELDS = frozenset(('ok', 'confirmation', 'next_action'))
PLAN_RESPONSES = '_status/plan_responses'
APPLYING_PUBLICATION = 'applying_publication'
OUTLINE_AMENDMENT = 'outline_amendment'
OUTLINE_AMENDMENTS = 'outline_amendments'
OUTLINE_APPROVAL = '04_outline/approval.json'
LOCAL_METADATA_FIELDS = frozenset(('title', 'authors', 'year', 'doi'))
LOCAL_METADATA_UPDATES = 'local_metadata_updates'
PROCEED_ACTION = (
    'The execution agreement is approved. Create or continue the execution tracker now. '
    'Before importing papers, searching or processing evidence, '
    'read the declared host plan contract: flat update_plan uses operation=get alone; '
    'only an actually declared legacy get/write tool uses operation=get, request={}. '
    'If the actual materials stage is already in_progress, continue its work without another mutation. '
    'Otherwise call the declared host tool directly to start the actual materials step, using '
    'the observed plan_id, revision and turn_id plus a fresh request_id. No saved JSON or progress CLI is needed. '
    'For flat create, read get again and call start before work. '
    'Use the actual existing item ID when a tracker already exists. Do not infer protocol from get.actions. '
    'Preserve the complete tree and root content unchanged; execution actions do not rewrite structure. '
    'After starting materials, run the bound doctor --scope full --no-network --json. '
    'Resolve required failures without changing the approved request or repeating confirmation. '
    'Reuse the selected-source preparation consumed from task activation and run papers budget. '
    'Library full-text authorization and the assembled-corpus checkpoint remain separate from this agreement.'
)


def completed_outline_amendment(workspace, packet, decision):
    plan = _read(Path(workspace) / PLAN_DECISION)
    for amendment in reversed(plan.get(OUTLINE_AMENDMENTS, [])):
        if amendment.get('packet') != packet or amendment.get('decision') != decision:
            continue
        approval = amendment.get('approval')
        if (plan.get('state') != APPROVED or plan.get('approved_snapshot') != amendment.get('target')
                or snapshot(workspace) != amendment.get('target')
                or _read(Path(workspace) / OUTLINE_APPROVAL) != approval):
            raise ValueError('completed outline decision belongs to a stale task or approval')
        return approval
    return None


def resume_outline_amendment(workspace, packet, decision):
    plan = _read(Path(workspace) / PLAN_DECISION)
    pending = plan.get(OUTLINE_AMENDMENT)
    if not pending:
        return None
    if (plan.get('state') != APPLYING_PUBLICATION or pending.get('packet') != packet
            or pending.get('decision') != decision
            or plan.get('approved_snapshot') != pending.get('before')
            or snapshot(workspace) not in (pending.get('before'), pending.get('target'))):
        raise ValueError('resume the same outline publication decision; task or decision changed')
    return pending


def begin_outline_amendment(workspace, packet, decision, publication):
    if 'execution' not in read_request(workspace):
        return None
    require_plan(workspace)
    before = snapshot(workspace)
    target_request = preview_request(before['request'], {'publication': publication})
    pending = {'packet': packet, 'decision': decision, 'before': before,
               'target': {**before, 'request': target_request, 'publication': publication_view(target_request)}}
    destination = Path(workspace) / PLAN_DECISION
    plan = _read(destination)
    plan.update(state=APPLYING_PUBLICATION, can_continue=False)
    plan[OUTLINE_AMENDMENT] = pending
    atomic_json(destination, plan)
    return pending


def complete_outline_amendment(workspace, packet, decision, approval):
    pending = resume_outline_amendment(workspace, packet, decision)
    if not pending:
        return
    if (snapshot(workspace) != pending['target']
            or _read(Path(workspace) / OUTLINE_APPROVAL) != approval
            or approval.get('source_packet_id') != packet['packet_id']
            or approval.get('user_response') != decision['user_response']):
        raise ValueError('outline publication amendment is not completely applied')
    destination = Path(workspace) / PLAN_DECISION
    plan = _read(destination)
    plan.setdefault(OUTLINE_AMENDMENTS, []).append({**pending, 'approval': approval})
    del plan[OUTLINE_AMENDMENT]
    plan.update(state=APPROVED, approved_snapshot=pending['target'], can_continue=True)
    atomic_json(destination, plan)


def snapshot(workspace):
    request = read_request(workspace)
    current = {'request': request, 'publication': publication_view(request)}
    if request.get('local_pdfs'):
        manifest = _read(Path(workspace) / LOCAL_MANIFEST)
        if manifest.get('input_sha256') != digest(request['local_pdfs']) or not manifest.get('papers'):
            raise ValueError('import the current local PDF inputs before creating an execution plan')
        current['local_materials'] = {
            identity: {key: paper['local_source'][key] for key in ('path', 'sha256')}
            for identity, paper in manifest['papers'].items()}
    return current


def refresh_local_metadata(workspace):
    with lock(workspace):
        return _refresh_local_metadata(workspace)


def _refresh_local_metadata(workspace):
    destination = Path(workspace) / PLAN_DECISION
    decision = _read(destination)
    if decision.get('state') != APPROVED:
        return False
    before = decision.get('approved_snapshot', {})
    current = snapshot(workspace)
    if before == current:
        return True
    if not before.get('local_materials') or before['local_materials'] != current.get('local_materials'):
        return False
    requests = []
    for value in (before['request'], current['request']):
        requests.append({**value, 'local_pdfs': [
            {key: item for key, item in paper.items() if key not in LOCAL_METADATA_FIELDS}
            for paper in value.get('local_pdfs', [])]})
    if requests[0] != requests[1]:
        return False
    decision.setdefault(LOCAL_METADATA_UPDATES, []).append({'before': before, 'after': current})
    decision['approved_snapshot'] = current
    atomic_json(destination, decision)
    return True


def require_plan(workspace):
    if 'execution' not in read_request(workspace):
        return
    decision = _read(Path(workspace) / PLAN_DECISION)
    if decision.get('state') != APPROVED or decision.get('approved_snapshot') != snapshot(workspace):
        raise ValueError('execution plan decision missing or stale; use writing plan-packet and the product plan checkpoint')


def packet(workspace, source_summary=None):
    with lock(workspace):
        current = snapshot(workspace)
        if 'execution' not in current['request']:
            raise ValueError('configure execution before creating a v3.1 plan')
        sources = current['request'].get('sources', {})
        if (sources.get('policy') == PROVIDED_ONLY and not sources.get('refs')
                and not current.get('local_materials')):
            raise ValueError('provided_only requires exact sources.refs or imported local PDFs before plan confirmation; '
                             'for a project library, enumerate metadata-only literature/search pages and configure all actual literature:<id> refs before writing plan-packet')
        previous = _read(Path(workspace) / PLAN_PACKET)
        identity = previous.get('packet_id') if previous.get('snapshot') == current else None
        decision = _read(Path(workspace) / PLAN_DECISION)
        approved = decision.get('state') == APPROVED and decision.get('approved_snapshot') == current
        result = {'status': 'SUCCESS', 'stage':'execution_plan', 'packet_id': identity or uuid.uuid4().hex,
                  'snapshot': current, 'publication': current['publication'],
                  'execution': current['request']['execution'],
                  'summary': {key:current['request'].get(key) for key in ('effective_requirements','intent','deliverable','sources','retrieval','language')},
                  'confirmation': {'state': APPROVED if approved else 'awaiting_display'},
                  'timeout_seconds': SECONDS,
                  'next_action': 'Display the task, sources, years, mode, format, template, citations and processing-time estimate. Call literature.review checkpoint=plan; pass its receipt_ref to writing plan-resolve --receipt. Source authorization remains separate.'}
        result['publication_display'] = {'citation_style': CITATION_STYLES[current['publication']['citation_style']]['labels'][current['request']['language']]['option']}
        if current['publication'].get('format') == 'latex_pdf':
            result['publication_display']['template'] = resolve_template(current['publication']['template'])['title']
        if source_summary is not None:
            result['source_summary'] = {key: source_summary[key] for key in
                ('local_count', 'search_target', 'combined_target', 'pending_count') if key in source_summary}
        elif identity and 'source_summary' in previous:
            result['source_summary'] = previous['source_summary']
        atomic_json(Path(workspace) / PLAN_PACKET, result)
        return result


def complete(workspace, receipt):
    if not isinstance(receipt, dict) or set(receipt) != RECEIPT_FIELDS:
        raise ValueError('plan-complete requires the unchanged product confirmation receipt')
    with lock(workspace):
        destination = Path(workspace) / PLAN_DECISION
        previous = _read(destination)
        current = snapshot(workspace)
        if previous.get('receipt') == receipt:
            expected=previous.get('approved_snapshot',previous.get('snapshot'))
            allowed=(previous.get('snapshot'),previous.get('target_snapshot')) if previous.get('state')==APPLYING else (expected,)
            if current not in allowed:
                raise ValueError('plan receipt belongs to a stale task')
            return previous
        plan = _read(Path(workspace) / PLAN_PACKET)
        if (not receipt.get('packet_id') or receipt['packet_id'] != plan.get('packet_id')
                or plan.get('snapshot') != current or receipt['snapshot_id'] != digest(current)):
            raise ValueError('plan receipt belongs to a stale task or packet')
        if previous.get('packet_id') == receipt['packet_id']:
            raise ValueError('a different decision already completed this plan')
        decision = receipt['decision']
        if not isinstance(decision, dict) or not isinstance(receipt['request_id'], str) or not receipt['request_id']:
            raise ValueError('invalid plan receipt')
        result = {'status': 'SUCCESS', 'stage':'execution_plan', 'packet_id': receipt['packet_id'], 'snapshot': current,
                  'receipt': receipt, 'state': RESPONDED, 'can_continue': False}
        if decision.get('cancelled'):
            result['state'] = CANCELLED
        elif decision.get('timed_out'):
            started, deadline = receipt['started_at'], receipt['deadline_at']
            if (current['request']['execution']['confirmation'] != 'timeout_auto'
                    or any(type(value) not in (int, float) or not math.isfinite(value)
                    for value in (started, deadline)) or deadline - started != SECONDS
                    or time.time() < deadline or decision.get('answers')):
                raise ValueError('invalid or unexpired plan timeout receipt')
            result.update(state=APPROVED, approved_snapshot=current, can_continue=True,
                          decision_source='timeout_default', user_response=None,
                          next_action=PROCEED_ACTION,
                          notice='No reply within five minutes. Proceeding with the displayed plan; paper authorization is still required.')
        else:
            answers = decision.get('answers', {})
            answer = answers.get(receipt['request_id']) if isinstance(answers, dict) else None
            if not isinstance(answer, str) or not answer.strip():
                raise ValueError('plan receipt has no actual answer')
            result['user_response'] = answer
            result['next_action'] = 'Interpret the actual answer. Use plan-decide with proceed and only requested changes, pause or cancel. Do not reconfirm clear changes.'
        atomic_json(destination, result)
        return result


def resolve(workspace, response, action=None, patch=None, source_reference=None):
    if (not isinstance(response, dict) or set(response) != PLAN_RESPONSE_FIELDS
            or response.get('ok') is not True or not isinstance(response.get('next_action'), str)):
        raise ValueError('plan-resolve requires the complete unchanged decoded literature.review plan response')
    receipt = response.get('confirmation')
    if not isinstance(receipt, dict) or set(receipt) != RECEIPT_FIELDS:
        raise ValueError('plan response has no confirmation receipt; recover the original response without another checkpoint')
    decision = receipt.get('decision')
    if not isinstance(decision, dict):
        raise ValueError('invalid plan receipt decision')
    terminal = bool(decision.get('cancelled') or decision.get('timed_out'))
    if terminal:
        if action is not None or patch is not None:
            raise ValueError('timeout or cancellation must be consumed unchanged, without an action or patch')
    elif action not in DECISIONS:
        raise ValueError('interpret the actual answer with proceed, pause or cancel')
    if patch is not None and not isinstance(patch, dict):
        raise ValueError('plan patch must be an object')
    with lock(workspace):
        result = complete(workspace, receipt)
        if source_reference is not None:
            relative = (Path.cwd() / source_reference).relative_to(Path(workspace).resolve())
        else:
            relative = Path(PLAN_RESPONSES) / (digest(response) + '.json')
            destination = Path(workspace) / relative
            if destination.exists() and _read(destination) != response:
                raise ValueError('saved plan response changed; preserve the original evidence')
            if not destination.exists():
                atomic_json(destination, response)
        if not terminal:
            resolution = {'packet_id': receipt['packet_id'], 'action': action}
            if patch is not None:
                resolution['patch'] = patch
            result = decide(workspace, resolution)
        return {**result, 'source_response': relative.as_posix()}


def decide(workspace, value):
    if not isinstance(value, dict) or set(value) - {'packet_id', 'action', 'patch'}:
        raise ValueError('plan-decide accepts packet_id, action and patch')
    action = value.get('action')
    if action not in DECISIONS:
        raise ValueError('plan action must be proceed, pause or cancel')
    with lock(workspace):
        destination = Path(workspace) / PLAN_DECISION
        decision = _read(destination)
        if decision.get('resolution') == value and decision.get('state') == DECISIONS[action]:
            if action == PROCEED:
                require_plan(workspace)
            return decision
        if (not value.get('packet_id') or value['packet_id'] != decision.get('packet_id')
                or decision.get('state') not in (RESPONDED, APPLYING)):
            raise ValueError('plan-decide requires an unresolved actual product answer')
        if decision['state'] == APPLYING and decision.get('resolution') != value:
            raise ValueError('resume the same pending plan decision')
        patch = value.get('patch', {})
        if not isinstance(patch,dict):
            raise ValueError('plan patch must be an object')
        if action != PROCEED and patch:
            raise ValueError('pause and cancel do not modify the task')
        if patch:
            history = decision['snapshot']['request'].get('user_requests', [])
            if patch.get('user_requests') != [*history, decision['user_response']]:
                raise ValueError('plan amendment must append the actual answer to user_requests')
        target_request=preview_request(decision['snapshot']['request'],patch)
        target={**decision['snapshot'],'request':target_request,'publication':publication_view(target_request)}
        if decision['state'] == RESPONDED:
            if decision['snapshot'] != snapshot(workspace):
                raise ValueError('task changed before plan resolution')
            decision.update(state=APPLYING, resolution=value,target_snapshot=target)
            atomic_json(destination, decision)
        elif decision.get('target_snapshot') != target:
            raise ValueError('pending plan target changed; do not apply this decision')
        if snapshot(workspace) not in (decision['snapshot'],target):
            raise ValueError('task changed during plan resolution; do not approve unrelated changes')
        if patch:
            configure(workspace, patch)
        decision.update(state=DECISIONS[action], can_continue=action == PROCEED,
                        decision_source='user',
                        next_action=PROCEED_ACTION if action==PROCEED else 'The plan is paused or cancelled. Do not start execution.')
        if action==PROCEED:
            decision['approved_snapshot']=snapshot(workspace)
        atomic_json(destination, decision)
        return decision
