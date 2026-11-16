import assert from 'node:assert/strict'
import test from 'node:test'
import { generateReading, observeReading, readReading, ReadingError } from './comprehension.ts'

function install(fetch: typeof globalThis.fetch): () => void {
  const oldWindow = globalThis.window,
    oldFetch = globalThis.fetch
  globalThis.window = { scholarseed: { getApiBase: () => 'http://service.test' } } as Window &
    typeof globalThis
  globalThis.fetch = fetch
  return () => {
    globalThis.window = oldWindow
    globalThis.fetch = oldFetch
  }
}
test('reading discovery is read-only and binds the requested attachment and version', async () => {
  const restore = install(async (url, init) => {
    const parsed = new URL(String(url))
    assert.equal(parsed.searchParams.get('attachment_id'), 'attachment')
    assert.equal(parsed.searchParams.get('source_revision'), 'revision')
    assert.notEqual(init?.method, 'POST')
    return Response.json({
      revision: 'revision',
      attachment_id: 'attachment',
      results: {},
      task: { task_id: 'running', status: 'running' },
    })
  })
  try {
    assert.equal((await readReading('paper', 'attachment', 'revision')).task?.task_id, 'running')
  } finally {
    restore()
  }
})
test('a failed load cannot be mistaken for an empty reading asset', async () => {
  const restore = install(async () =>
    Response.json({ detail: { code: 'pdf_ai_source_changed' } }, { status: 422 })
  )
  try {
    await assert.rejects(
      readReading('paper', 'attachment', 'old'),
      (error: ReadingError) => error.code === 'pdf_ai_source_changed'
    )
  } finally {
    restore()
  }
})
test('generation accepts an already running workflow with its original model', async () => {
  const restore = install(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).response_language, 'en')
    return Response.json({ task_id: 'existing', status: 'running', model_key: 'original' })
  })
  try {
    assert.equal(
      (await generateReading('paper', 'attachment', 'revision', 'new', 'en')).model_key,
      'original'
    )
  } finally {
    restore()
  }
})
test('restarted unknown task is a truthful terminal state, incomplete streams still fail', async () => {
  for (const status of ['unknown', 'running']) {
    const restore = install(
      async () =>
        new Response(`data: ${JSON.stringify({ task_id: 'task', status })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
    )
    try {
      const statuses: string[] = []
      const stream = observeReading('task', new AbortController().signal, (task) =>
        statuses.push(task.status)
      )
      if (status === 'running') await assert.rejects(stream, ReadingError)
      else await stream
      assert.deepEqual(statuses, [status])
    } finally {
      restore()
    }
  }
})

test('organized item previews arrive before the saved result without a new request', async () => {
  const preview = {
    organized: true,
    text: 'TLDR',
    sections: [
      { key: 'method', items: [{ text: 'Mechanism', evidence: [{ page: 2, quote: 'Evidence' }] }] },
    ],
  }
  const events = [
    { task_id: 'task', status: 'running', preview },
    { task_id: 'task', status: 'completed', result: { modules: { summary: preview } } },
  ]
  let calls = 0
  const restore = install(async () => {
    calls += 1
    return new Response(events.map((task) => `data: ${JSON.stringify(task)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  try {
    const received: unknown[] = []
    await observeReading('task', new AbortController().signal, (task) => received.push(task))
    assert.deepEqual(received, events)
    assert.equal(calls, 1)
  } finally {
    restore()
  }
})
