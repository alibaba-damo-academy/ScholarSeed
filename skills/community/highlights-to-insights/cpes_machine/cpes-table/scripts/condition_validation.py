"""Validate explicit row conditions against an independently reviewed inventory.

This module does not discover conditions, transcribe numbers, or certify a
model's own header inventory. Unknown inventories fail closed in the opt-in
V13 experiment. The reviewed rows contain labels/conditions, never metric cells.
"""
import copy
import hashlib


def validate_contract(contract, image):
    if not isinstance(contract,dict) or contract.get('version') != 1 or contract.get('status') != 'reviewed':
        raise ValueError('Row condition contract must be independently reviewed')
    if not contract.get('review_method'):
        raise ValueError('Row condition contract missing review method')
    if hashlib.sha256(image.read_bytes()).hexdigest() != contract.get('image_sha256'):
        raise ValueError('Row condition contract image hash mismatch')
    headers = contract.get('headers');rows = contract.get('rows')
    if not isinstance(headers,list) or not headers or any(not isinstance(h,str) or not h.strip() for h in headers) or len(set(headers)) != len(headers):
        raise ValueError('Row condition contract invalid headers')
    if not isinstance(rows,list) or not rows or any(not isinstance(row,dict) or set(row) != set(headers) or
            any(not isinstance(v,str) or not v.strip() for v in row.values()) for row in rows):
        raise ValueError('Row condition contract incomplete row assignments')
    return copy.deepcopy(contract)


def check_locator(locator, contract, path):
    if not contract:raise ValueError(path + ': condition contract unavailable')
    selected = {};errors = []
    for label in locator['row_path']:
        matches=[name for name in contract['headers'] if label.startswith(name + ': ')]
        if len(matches) != 1:
            errors.append('unnamed or unknown row condition ' + repr(label));continue
        name=matches[0];value=label[len(name)+2:].strip()
        if name in selected:errors.append('duplicate row condition ' + name)
        if not value:errors.append('empty row condition ' + name)
        selected[name]=value
    missing=[h for h in contract['headers'] if h not in selected]
    if missing:errors.append('missing row conditions: ' + ', '.join(missing))
    if not errors and selected not in contract['rows']:
        errors.append('unknown or mixed row assignment')
    if errors:raise ValueError(path + ': ' + '; '.join(errors))
