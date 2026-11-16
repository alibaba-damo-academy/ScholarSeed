import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import * as images from '../images.ts'
import { resolveBrowserDestinations } from './network.ts'

interface Reply {
  status?: number
  headers?: Record<string, string>
  chunks?: Buffer[]
  truncated?: boolean
}

function reader(replies: Reply[], options: { addresses?: string[]; timeout?: boolean } = {}) {
  const requests: { url: string; headers: Record<string, string>; pinned: unknown }[] = []
  const resolved: string[] = []
  let aborted = false
  const dependencies: Record<string, unknown> = {
    '../images.ts': images,
    './network.ts': {
      resolveBrowserDestinations: async (url: URL, origin: null) => {
        assert.equal(origin, null)
        resolved.push(url.href)
        if (options.timeout) return new Promise(() => undefined)
        return resolveBrowserDestinations(url, null, async () =>
          (options.addresses ?? ['93.184.216.34']).map((address) => ({ address, family: 4 }))
        )
      },
    },
    'node:https': {
      request: (
        url: URL,
        settings: {
          headers: Record<string, string>
          agent: boolean
          rejectUnauthorized: boolean
          signal: AbortSignal
          lookup: (
            hostname: string,
            options: { all: boolean },
            callback: (error: unknown, addresses: unknown) => void
          ) => void
        },
        respond: (reply: unknown) => void
      ) => {
        assert.equal(settings.agent, false)
        assert.equal(settings.rejectUnauthorized, true)
        let pinned: unknown
        settings.lookup(url.hostname, { all: true }, (error, addresses) => {
          assert.equal(error, null)
          pinned = addresses
        })
        requests.push({ url: url.href, headers: settings.headers, pinned })
        settings.signal.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true }
        )
        const outgoing = new EventEmitter() as EventEmitter & { end: () => void }
        outgoing.end = () =>
          queueMicrotask(() => {
            const specification = replies.shift() ?? {}
            const response = Object.assign(new PassThrough(), {
              statusCode: specification.status ?? 200,
              headers: specification.headers ?? { 'content-type': 'image/jpeg' },
            })
            respond(response)
            if (specification.truncated) {
              response.destroy()
              return
            }
            for (const chunk of specification.chunks ?? [Buffer.from('image')])
              response.write(chunk)
            response.end()
          })
        return outgoing
      },
    },
  }
  const exports: { readRemoteImage?: (url: unknown) => Promise<Buffer> } = {}
  const output = ts.transpileModule(readFileSync(new URL('./remote.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(output, {
    exports,
    require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), name)
      return dependencies[name]
    },
    URL,
    Buffer,
    Set,
    AbortController,
    setTimeout: (callback: () => void, timeout: number) =>
      setTimeout(callback, options.timeout ? 10 : timeout),
    clearTimeout,
  })
  return { run: exports.readRemoteImage!, requests, resolved, aborted: () => aborted }
}

test('remote image reads pin every HTTPS redirect and send only fixed anonymous image headers', async () => {
  const fixture = reader([
    { status: 302, headers: { location: 'https://cdn.example.test/image' } },
    { chunks: [Buffer.from('actual'), Buffer.from(' image')] },
  ])
  assert.equal((await fixture.run('https://images.example.test/start')).toString(), 'actual image')
  assert.deepEqual(fixture.resolved, [
    'https://images.example.test/start',
    'https://cdn.example.test/image',
  ])
  for (const outgoing of fixture.requests) {
    assert.deepEqual(Object.keys(outgoing.headers).sort(), [
      'Accept',
      'Accept-Encoding',
      'User-Agent',
    ])
    assert.match(outgoing.headers['User-Agent'], /^ScholarSeed /)
    assert.equal(outgoing.headers['Accept-Encoding'], 'identity')
    assert.deepEqual(JSON.parse(JSON.stringify(outgoing.pinned)), [
      { address: '93.184.216.34', family: 4 },
    ])
  }
  assert.equal(fixture.aborted(), true)
})

test('remote image protocol, userinfo, private and mixed DNS targets fail before a request', async () => {
  for (const url of [
    'http://images.example.test/a',
    'file:///a',
    'data:image/png,a',
    'https://user:password@images.example.test/a',
    'https://127.0.0.1/a',
  ]) {
    const fixture = reader([])
    await assert.rejects(fixture.run(url))
    assert.equal(fixture.requests.length, 0)
  }
  const mixed = reader([], { addresses: ['93.184.216.34', '10.0.0.1'] })
  await assert.rejects(mixed.run('https://images.example.test/a'))
  assert.equal(mixed.requests.length, 0)
})

test('redirects cannot downgrade, reach private hosts or exceed their finite budget', async () => {
  for (const location of [
    'http://images.example.test/a',
    'https://127.0.0.1/a',
    'https://user@images.example.test/a',
  ]) {
    const fixture = reader([{ status: 302, headers: { location } }])
    await assert.rejects(fixture.run('https://images.example.test/a'))
    assert.equal(fixture.requests.length, 1)
  }
  const fixture = reader(
    Array.from({ length: 5 }, () => ({ status: 302, headers: { location: '/again' } }))
  )
  await assert.rejects(fixture.run('https://images.example.test/a'))
  assert.equal(fixture.requests.length, 4)
})

test('non-image, encoded, oversized and truncated responses never become display bytes', async () => {
  const rejectedHeaders: Record<string, string>[] = [
    { 'content-type': 'text/html' },
    { 'content-type': 'image/svg+xml' },
    { 'content-type': 'image/jpeg', 'content-encoding': 'gzip' },
    { 'content-type': 'image/jpeg', 'content-length': String(images.OFFICE_IMAGE_MAX_BYTES + 1) },
  ]
  for (const headers of rejectedHeaders) {
    await assert.rejects(reader([{ headers }]).run('https://images.example.test/a'))
  }
  await assert.rejects(
    reader([{ chunks: [Buffer.alloc(images.OFFICE_IMAGE_MAX_BYTES), Buffer.from('x')] }]).run(
      'https://images.example.test/a'
    )
  )
  await assert.rejects(reader([{ truncated: true }]).run('https://images.example.test/a'))
})

test('a DNS stall is bounded by the image deadline without creating a socket', async () => {
  const fixture = reader([], { timeout: true })
  await assert.rejects(fixture.run('https://images.example.test/a'))
  assert.equal(fixture.requests.length, 0)
})

test('remote image IPC accepts only the current main frame before calling acquisition', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const block = source.slice(
    source.indexOf('ipcMain.handle(REMOTE_IMAGE_CHANNEL,'),
    source.indexOf("ipcMain.handle('scholarseed:write-clipboard'")
  )
  let calls = 0
  let handler!: (event: unknown, url: unknown) => unknown
  const sender = {}
  const frame = {}
  const output = ts.transpileModule(block, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(output, {
    REMOTE_IMAGE_CHANNEL: images.REMOTE_IMAGE_CHANNEL,
    ipcMain: {
      handle: (_channel: string, callback: typeof handler) => {
        handler = callback
      },
    },
    isMainWindowSender: (candidate: unknown, candidateFrame: unknown) =>
      candidate === sender && candidateFrame === frame,
    acquireRemoteImage: () => {
      calls++
      return 'acquired'
    },
  })
  for (const event of [
    { sender },
    { sender, senderFrame: null },
    { sender, senderFrame: {} },
    { sender: {}, senderFrame: frame },
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(handler(event, 'https://images.example.test/a'))), {
      status: 'error',
      code: 'invalid_sender',
    })
  }
  assert.equal(calls, 0)
  assert.equal(handler({ sender, senderFrame: frame }, 'https://images.example.test/a'), 'acquired')
  assert.equal(calls, 1)
})
