"""Run-scoped, local evidence diagnostics and complete response artifacts."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
from uuid import uuid4
from urllib.parse import urlsplit, urlunsplit

ROOT = Path('_logs/evidence')
EVENTS = 'events.jsonl'
REDACTED = '<redacted>'
SECRET_KEYS = re.compile(r'authorization|cookie|password|secret|api[_-]?key|access[_-]?token|credential', re.I)
URL = re.compile(r'https?://[^\s"<>]+')
JSON_SECRET = re.compile(r'("(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|credential)"\s*:\s*)"(?:\\.|[^"\\])*"', re.I)
STAGES = frozenset(('fulltext', 'processing'))


def sanitize(value):
    if isinstance(value, dict):
        return {str(key): REDACTED if SECRET_KEYS.search(str(key)) else sanitize(item)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        for key, secret in os.environ.items():
            if SECRET_KEYS.search(key) and secret:
                value = value.replace(secret, REDACTED)
        value = JSON_SECRET.sub(lambda match: match[1] + json.dumps(REDACTED), value)
        return URL.sub(safe_url, value)
    return value


def safe_url(match):
    try:
        parsed = urlsplit(match[0])
        return urlunsplit((parsed.scheme, parsed.netloc.rsplit('@', 1)[-1], parsed.path, '', ''))
    except ValueError:
        return REDACTED


def text_size(text):
    return {'characters': len(text), 'utf8_bytes': len(text.encode('utf-8')),
            'token_upper_bound': len(text.encode('utf-8')),
            'token_count_method': 'utf8_byte_upper_bound_not_model_tokenizer'}


class EvidenceLog:
    def __init__(self, workspace, stage):
        if stage not in STAGES:
            raise ValueError('unknown evidence diagnostic stage')
        self.workspace = Path(workspace).resolve()
        self.run_id = uuid4().hex
        self.directory = self.workspace / ROOT / f'{stage}-{self.run_id}'
        self.directory.mkdir(parents=True, exist_ok=False)
        self.events = self.directory / EVENTS
        self.lock = threading.Lock()
        self.stage = stage
        self.event('run_started')

    def result(self, paper_id, kind, value):
        identity = hashlib.sha256(str(paper_id).encode()).hexdigest()
        directory = self.directory / identity
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f'{uuid4().hex}.json'
        path.write_text(json.dumps(sanitize(value), ensure_ascii=False, indent=2), encoding='utf-8')
        self.event('artifact_saved', paper_id=paper_id, kind=kind,
                   artifact=str(path.relative_to(self.workspace)))
        return str(path.relative_to(self.workspace))

    def event(self, event, **values):
        record = {'schema': 'slr-evidence/v1', 'run_id': self.run_id,
                  'stage': self.stage, 'at': datetime.now(timezone.utc).isoformat(),
                  'event': event, **values}
        with self.lock, self.events.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(sanitize(record), ensure_ascii=False) + '\n')

    @contextmanager
    def measure(self, event, paper_id, **values):
        started = time.monotonic()
        self.event(event + '_started', paper_id=paper_id, **values)
        try:
            yield values
        except BaseException as error:
            self.event(event + '_completed', paper_id=paper_id, **values, status='failed',
                       elapsed_seconds=time.monotonic() - started,
                       error_type=type(error).__name__, error=str(error))
            raise
        else:
            self.event(event + '_completed', paper_id=paper_id, **values, status='success',
                       elapsed_seconds=time.monotonic() - started)
