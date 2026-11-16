"""Read product-owned task handoffs by reference, without agent serialization."""

import hashlib
import json
import re
from pathlib import Path, PurePosixPath

SCHEMA = 'task-receipt/v1'
DIRECTORY = '_status/product_receipts'
MAX_BYTES = 2 * 1024 * 1024
ACTIVATION = 'task.activate'
PLAN = 'literature.review.plan'
OUTLINE = 'literature.review.outline'


def read(workspace, reference, operation):
    relative = PurePosixPath(reference)
    if (not reference or relative.is_absolute() or '..' in relative.parts
            or '\\' in reference or ':' in reference):
        raise ValueError('receipt reference must be session-relative')
    root = Path.cwd().resolve()
    ws = Path(workspace).resolve()
    source = root.joinpath(*relative.parts)
    if source.parent != ws / DIRECTORY or not re.fullmatch(r'[0-9a-f]{64}\.json', source.name):
        raise ValueError('receipt reference must name the bound task product receipt')
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise ValueError('linked product receipt is not supported')
    with source.open('rb') as handle:
        payload = handle.read(MAX_BYTES + 1)
    if len(payload) > MAX_BYTES or hashlib.sha256(payload).hexdigest() != source.stem:
        raise ValueError('product receipt digest or size mismatch; recover the original reference')
    envelope = json.loads(payload)
    binding = json.loads((ws / '.slr-binding.json').read_text(encoding='utf-8'))
    if (not isinstance(envelope, dict) or envelope.get('schema') != SCHEMA
            or envelope.get('operation') != operation or not isinstance(envelope.get('workspace'), str)):
        raise ValueError('product receipt operation or schema mismatch')
    run_id = binding.get('run_id') or 'slr-' + hashlib.sha256(envelope['workspace'].encode()).hexdigest()[:16]
    if (envelope.get('run_id') != run_id or root / envelope['workspace'] != ws
            or not isinstance(envelope.get('response'), dict) or envelope['response'].get('ok') is not True):
        raise ValueError('product receipt task binding mismatch')
    return envelope['response']


def approval(response, amendments=None):
    receipt = response.get('confirmation', {})
    decision = receipt.get('decision', {})
    answer = decision.get('answers', {}).get(receipt.get('request_id'))
    if decision.get('cancelled') or decision.get('timed_out') or not isinstance(answer, str) or not answer.strip():
        raise ValueError('approval requires an actual answer; cancellation or timeout cannot approve')
    if amendments is not None and (not isinstance(amendments, dict) or set(amendments) - {'publication'}):
        raise ValueError('receipt approval amendments accept only requested publication changes')
    return {**(amendments or {}), 'packet_id': receipt['packet_id'],
            'message_id': receipt['request_id'], 'user_response': answer}
