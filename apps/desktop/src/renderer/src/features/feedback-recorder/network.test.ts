import assert from 'node:assert/strict'
import test from 'node:test'

import { installRecorderProbe } from './probe.ts'
import type { NetworkRecord } from './model.ts'

class RecordingXhr extends EventTarget {
  status = 200
  responseType = ''
  responseText = ''
  response: unknown
  responseURL = 'https://example.test/download.bin'
  headers = new Headers()
  sentBody: unknown
  open(..._arguments: unknown[]): void {}
  send(body: unknown): void {
    this.sentBody = body
  }
  getResponseHeader(name: string): string | null {
    return this.headers.get(name)
  }
}

async function withProbe(
  originalFetch: typeof fetch,
  run: (
    wrapped: typeof fetch,
    records: NetworkRecord[],
    waitForSummaries: () => Promise<void>
  ) => Promise<void>
): Promise<void> {
  const records: NetworkRecord[] = []
  const summaryListeners = new Set<() => void>()
  const summariesReady = (): boolean =>
    records.every(
      (record) =>
        record.requestBody !== '[正文摘要生成中]' && record.responseBody !== '[正文摘要生成中]'
    )
  const waitForSummaries = (): Promise<void> =>
    summariesReady()
      ? Promise.resolve()
      : new Promise((resolve) => {
          const listener = (): void => {
            if (!summariesReady()) return
            summaryListeners.delete(listener)
            resolve()
          }
          summaryListeners.add(listener)
        })
  const documentTarget = Object.assign(new EventTarget(), { title: 'ScholarSeed' })
  const windowTarget = Object.assign(new EventTarget(), {
    location: { href: 'https://example.test/' },
    fetch: originalFetch,
  })
  const replacements = {
    window: windowTarget,
    document: documentTarget,
    history: { pushState: () => undefined, replaceState: () => undefined },
    XMLHttpRequest: RecordingXhr,
  }
  const originalDescriptors = new Map(
    Object.keys(replacements).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ])
  )
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const lease = installRecorderProbe({
    startedAtMs: Date.now(),
    latestStep: () => undefined,
    onStep: () => undefined,
    onRequest: (record) => {
      const index = records.findIndex((entry) => entry.requestId === record.requestId)
      if (index === -1) records.push(record)
      else records[index] = record
      for (const listener of summaryListeners) listener()
    },
  })
  try {
    await run(windowTarget.fetch, records, waitForSummaries)
  } finally {
    lease.dispose()
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as Record<string, unknown>)[name]
    }
  }
}

test('fetch text summaries do not consume the business response', async () => {
  const text = JSON.stringify({ message: '中'.repeat(100) })
  const response = new Response(text, { headers: { 'content-type': 'application/json' } })
  await withProbe(
    async () => response,
    async (wrapped, records, waitForSummaries) => {
      const returned = await wrapped('https://example.test/items', {
        method: 'POST',
        body: 'x'.repeat(201),
      })
      assert.equal(returned, response)
      assert.equal(await returned.text(), text)
      await waitForSummaries()
      assert.equal(records[0].requestBody, `${'x'.repeat(200)}…[已截断，省略 1 字节]`)
      assert.match(records[0].responseBody || '', /已截断，省略 \d+ 字节/)
    }
  )
})

test('fetch returns headers before a streaming text body finishes', async () => {
  let releaseBody: (() => void) | undefined
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'))
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode('true}'))
          controller.close()
        }
      },
    }),
    { headers: { 'content-type': 'application/json' } }
  )
  await withProbe(
    async () => response,
    async (wrapped) => {
      let returned: Response | undefined
      const pending = wrapped('https://example.test/stream').then((value) => {
        returned = value
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        assert.equal(returned, response)
      } finally {
        releaseBody?.()
        await pending
      }
      assert.equal(await response.text(), '{"ok":true}')
    }
  )
})

test('fetch forwards a streaming Request before its recording summary finishes', async () => {
  let releaseBody: (() => void) | undefined
  const request = new Request('https://example.test/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'))
          controller.close()
        }
      },
    }),
    duplex: 'half',
  } as RequestInit)
  let forwarded = false
  await withProbe(
    async (input) => {
      assert.equal(input, request)
      forwarded = true
      return new Response('{}')
    },
    async (wrapped) => {
      const pending = wrapped(request)
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        assert.equal(forwarded, true)
      } finally {
        releaseBody?.()
        await pending
      }
      assert.equal(await request.text(), '{"ok":true}')
    }
  )
})

test('fetch downloads capture metadata without cloning or reading file content', async () => {
  const response = new Response('secret', {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="proof.pdf"',
      'content-length': '6',
    },
  })
  response.clone = () => {
    throw new Error('file must not be cloned')
  }
  await withProbe(
    async () => response,
    async (wrapped, records) => {
      const returned = await wrapped('https://example.test/fallback.pdf')
      assert.equal(returned.bodyUsed, false)
      assert.equal(records[0].responseBody, '[File proof.pdf 6 bytes]')
      assert.equal(await returned.text(), 'secret')
    }
  )
})

test('fetch Request JSON summaries preserve the original request body', async () => {
  const text = JSON.stringify({ value: '中'.repeat(100) })
  const request = new Request('https://example.test/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  })
  await withProbe(
    async (input) => {
      assert.equal(input, request)
      assert.equal(await request.text(), text)
      return new Response('{}')
    },
    async (wrapped, records, waitForSummaries) => {
      await wrapped(request)
      await waitForSummaries()
      assert.match(records[0].requestBody || '', /已截断，省略 \d+ 字节/)
    }
  )
})

test('fetch binary Request bodies are not cloned to discover file metadata', async () => {
  const request = new Request('https://example.test/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1, 2, 3]),
  })
  request.clone = () => {
    throw new Error('file content must not be cloned')
  }
  await withProbe(
    async (input) => {
      assert.equal(input, request)
      assert.equal(request.bodyUsed, false)
      return new Response('{}')
    },
    async (wrapped, records) => {
      await wrapped(request)
      assert.equal(records[0].requestBody, '[File unknown unknown bytes]')
    }
  )
})

test('fetch multipart Request records unknown file metadata without reading its encoded body', async () => {
  const body = new FormData()
  body.append('attachment', new File(['private-file'], 'evidence.txt'))
  const request = new Request('https://example.test/upload', { method: 'POST', body })
  request.clone = () => {
    throw new Error('must not read encoded file data')
  }
  await withProbe(
    async () => new Response('{}'),
    async (wrapped, records, waitForSummaries) => {
      await wrapped(request)
      await waitForSummaries()
      assert.equal(records[0].requestBody, '[File unknown unknown bytes]')
      assert.equal(request.bodyUsed, false)
    }
  )
})

test('XHR summarizes text and leaves outgoing files unchanged', async () => {
  await withProbe(
    async () => new Response('{}'),
    async (_wrapped, records) => {
      const request = new RecordingXhr()
      const file = new File(['secret'], 'proof.txt')
      request.headers.set('content-type', 'application/json')
      request.responseText = 'x'.repeat(201)
      request.open('POST', 'https://example.test/upload')
      request.send(file)
      request.dispatchEvent(new Event('loadend'))
      assert.equal(request.sentBody, file)
      assert.equal(request.responseText, 'x'.repeat(201))
      assert.equal(records[0].requestBody, '[File proof.txt 6 bytes]')
      assert.equal(records[0].responseBody, `${'x'.repeat(200)}…[已截断，省略 1 字节]`)
    }
  )
})

test('XHR binary response metadata does not read responseText', async () => {
  await withProbe(
    async () => new Response('{}'),
    async (_wrapped, records) => {
      const request = new RecordingXhr()
      request.responseType = 'blob'
      request.response = new Blob(['secret'])
      Object.defineProperty(request, 'responseText', {
        get: () => {
          throw new Error('must not read')
        },
      })
      request.open('GET', request.responseURL)
      request.send(null)
      request.dispatchEvent(new Event('loadend'))
      assert.equal(records[0].responseBody, '[File unknown 6 bytes]')
    }
  )
})

test('XHR file response uses the available Blob size when content-length is unknown', async () => {
  await withProbe(
    async () => new Response('{}'),
    async (_wrapped, records) => {
      const request = new RecordingXhr()
      request.responseType = 'blob'
      request.response = new Blob(['secret'])
      request.headers.set('content-type', 'application/pdf')
      request.headers.set('content-disposition', 'attachment; filename="proof.pdf"')
      request.open('GET', request.responseURL)
      request.send(null)
      request.dispatchEvent(new Event('loadend'))
      assert.equal(records[0].responseBody, '[File proof.pdf 6 bytes]')
    }
  )
})

test('XHR JSON responses retain small bodies and summarize large bodies', async () => {
  await withProbe(
    async () => new Response('{}'),
    async (_wrapped, records) => {
      for (const response of [{ value: 'small' }, { value: '中'.repeat(100) }]) {
        const request = new RecordingXhr()
        request.responseType = 'json'
        request.response = response
        request.headers.set('content-type', 'application/json')
        request.open('GET', 'https://example.test/items')
        request.send(null)
        request.dispatchEvent(new Event('loadend'))
      }
      assert.equal(records[0].responseBody, '{"value":"small"}')
      assert.match(records[1].responseBody || '', /已截断，省略 \d+ 字节/)
    }
  )
})
