import assert from 'node:assert/strict'
import test from 'node:test'

import { CsvClient } from './client.ts'
import type { CsvRequest, CsvResponse } from './protocol.ts'

test('cancellation during worker dispatch registration never posts the save read', async (context) => {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const posts: CsvRequest[] = []
  class WorkerStub {
    onmessage: ((event: MessageEvent<CsvResponse>) => void) | null = null

    postMessage(request: CsvRequest): void {
      posts.push(request)
      const response = {
        requestId: request.requestId,
        identity: request.identity,
        version: 0,
        ok: true,
      }
      this.onmessage?.(new MessageEvent('message', { data: response }))
    }

    terminate(): void {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerStub })
  const client = new CsvClient('document')
  context.after(() => {
    client.dispose()
    if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker)
    else Reflect.deleteProperty(globalThis, 'Worker')
  })

  const deadline = new AbortController()
  const reason = new DOMException('save deadline', 'TimeoutError')
  const listen = deadline.signal.addEventListener.bind(deadline.signal)
  context.mock.method(
    deadline.signal,
    'addEventListener',
    (...args: Parameters<AbortSignal['addEventListener']>) => {
      deadline.abort(reason)
      return listen(...args)
    }
  )

  await assert.rejects(
    client.readForSave('serialize', deadline.signal),
    (error) => error === reason
  )
  assert.deepEqual(posts, [])
  assert.equal((await client.request({ command: 'state' })).ok, true)
})
