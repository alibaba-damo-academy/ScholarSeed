"""Incremental response persistence and compact progress for streamed model calls."""
import asyncio
import contextlib
import json
import sys
import time
from task_contract import atomic_json


class StreamProgress:
    def __init__(self,workspace,stage,folder,attempt):
        self.workspace=workspace;self.stage=stage;self.folder=folder;self.attempt=attempt
        self.characters=0;self.started=time.monotonic();self.last=0;self.stream=None;self.task=None
    def event(self,state):
        value={'event':'llm_progress','stage':self.stage,'state':state,'attempt':self.attempt,
               'characters_received':self.characters,'elapsed_sec':round(time.monotonic()-self.started,1),'log_dir':str(self.folder)}
        atomic_json(self.folder/'progress.json',value)
        atomic_json(self.workspace/'_status/llm_requests'/f'{self.stage}.json',value)
        print(json.dumps(value,ensure_ascii=False),file=sys.stderr,flush=True)
    def chunk(self,content):
        if content:
            self.stream.write(content);self.stream.flush();self.characters+=len(content)
        if time.monotonic()-self.last>=15:self.event('streaming');self.last=time.monotonic()
    async def heartbeat(self):
        while True:
            await asyncio.sleep(15);self.event('streaming' if self.characters else 'waiting_for_stream')
    async def __aenter__(self):
        self.stream=(self.folder/f'attempt-{self.attempt}.partial.txt').open('w',encoding='utf-8')
        self.event('requesting');self.task=asyncio.create_task(self.heartbeat());return self
    async def __aexit__(self,*exc):
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):await self.task
        self.stream.close();self.event('interrupted' if exc[0] else 'response_received')
