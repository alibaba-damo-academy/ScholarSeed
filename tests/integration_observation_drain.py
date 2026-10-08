"""Real OS pipe and adapter dispatch; controlled consumer, not product acceptance."""

from __future__ import annotations

import asyncio
import hashlib
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from scholarseed_codex.events import translate_event
from scholarseed_codex.mailbox import ObservationMailbox
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import CodexSessionOpenRequest
from scholarseed_codex.protocol.state import CODEX_STREAM_LIMIT_BYTES
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_runtime.contract import RuntimeEventKind

OUTPUT_COUNT = 5000
PIPE_TIMEOUT_SECONDS = 10
CHILD = r"""
import sys,json
def emit(method, **params):
    print(json.dumps({'method':method,'params':{'threadId':'probe','turnId':'turn',**params}}),flush=True)
emit('item/started',item={'id':'item','type':'commandExecution','command':'probe','cwd':'.','status':'inProgress'})
for i in range(int(sys.argv[1])):
    emit('item/commandExecution/outputDelta',itemId='item',delta=f'{i:06d}:'+('x'*24)+'\n')
emit('item/completed',item={'id':'item','type':'commandExecution','command':'probe','cwd':'.','status':'completed','exitCode':0})
"""


class ObservationDrainIntegration(unittest.IsolatedAsyncioTestCase):
    async def test_reader_finishes_while_projection_is_paused(self) -> None:
        host = CodexProcessHost()
        host._generation = 1
        mailbox = ObservationMailbox()
        self.addAsyncCleanup(mailbox.close)
        holder = SimpleNamespace(_events=mailbox, _watermark=0)

        async def listener(event) -> None:
            await CodexRuntimeSession._publish_observation(
                holder, translate_event(event, product_session_id="probe", process_generation=1)
            )

        state = SimpleNamespace(
            thread_id="probe",
            attached_generation=1,
            listener=listener,
            request=CodexSessionOpenRequest(request_id="probe", runtime_id="codex", cwd=Path.cwd()),
        )
        state.turn = CodexTurnRuntime(
            state,
            request=host._request_connected,
            ensure_attached=host.ensure_attached,
            stale_requests=host._stale_requests,
            emitter=host._emitter,
            router=host._router,
            watcher=host._watcher,
            diagnostic=host._diagnostics.append,
            protocol_error=host._protocol_errors.append,
        )
        host._threads["probe"] = state
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            CHILD,
            str(OUTPUT_COUNT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=CODEX_STREAM_LIMIT_BYTES,
        )
        reader = asyncio.create_task(host._read_stdout(proc, 1))
        try:
            # No consumer runs until the real stdout reader and child both finish.
            await asyncio.wait_for(reader, PIPE_TIMEOUT_SECONDS)
            self.assertEqual(await proc.wait(), 0)
            chunks, sequences = [], []
            while True:
                event = await mailbox.get()
                sequences.append(event.sequence)
                if event.kind is RuntimeEventKind.TOOL_PROGRESS:
                    chunks.append(event.payload["output"])
                elif event.kind is RuntimeEventKind.TOOL_COMPLETED:
                    complete = event.payload["output"]
                    break
            expected = "".join(f"{i:06d}:" + "x" * 24 + "\n" for i in range(OUTPUT_COUNT))
            self.assertEqual(len(chunks), OUTPUT_COUNT)
            self.assertEqual("".join(chunks), complete)
            self.assertEqual(complete, expected)
            self.assertEqual(
                hashlib.sha256(complete.encode()).hexdigest(),
                "a37bbc523b733b106bf59dd23b910f8a229fcabea00a9e66d781ea35b52d706a",
            )
            self.assertEqual(sequences, sorted(set(sequences)))
            self.assertEqual(list(host._protocol_errors), [])
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
