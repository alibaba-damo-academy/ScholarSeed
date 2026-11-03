import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { unzipSync, strFromU8 } from 'fflate'

import { FEEDBACK_LIMITS } from '../feedback.ts'
import { FeedbackSubmissionService } from './submission.ts'
import { clientVersion, STARTUP_BUILD_NUMBER } from './version.ts'

const require = createRequire(import.meta.url)
const { verifyClosure } = require('../../scripts/cd/closure.cjs')
const WORKER_BOUNDARY_BYTES = 160000
const ZIP_COMPRESSION_OFFSET = 8

async function compiledSubmission() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./submission.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  })
  return result.outputFiles[0].text
}

test('compiled feedback submission retains the production closure security boundary', async () => {
  const compiled = await compiledSubmission()
  assert.doesNotThrow(() =>
    verifyClosure(
      new Map([
        ['out/main/index.js', compiled],
        ['out/main/data-inspection.js', 'module.exports = {}'],
        ['out/preload/index.js', 'require("electron")'],
      ])
    )
  )
})

test('compiled feedback packages boundary and maximum reports without host module or Worker access', async () => {
  const module = { exports: {} as { FeedbackSubmissionService: typeof FeedbackSubmissionService } }
  runInNewContext(await compiledSubmission(), {
    module,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    Headers,
    AbortSignal,
  })
  for (const size of [
    WORKER_BOUNDARY_BYTES - 1,
    WORKER_BOUNDARY_BYTES,
    FEEDBACK_LIMITS.reportBytes,
  ]) {
    const report = JSON.stringify({ schemaVersion: 1, padding: '' })
    const recording = report.replace(
      '"padding":""',
      `"padding":"${'x'.repeat(size - report.length)}"`
    )
    const renderer = report.replace(
      '"padding":""',
      `"padding":"${'y'.repeat(size - report.length)}"`
    )
    const hostLog = 'z'.repeat(FEEDBACK_LIMITS.hostBytes)
    let submissions = 0
    const service = new module.exports.FeedbackSubmissionService({
      baseUrl: 'https://feedback.example.test',
      accountBaseUrl: '',
      version: '0.3.0',
      platform: 'darwin',
      arch: 'arm64',
      readToken: async () => '',
      isCurrent: () => true,
      collectBundle: async () => {
        throw new Error('Serve unavailable')
      },
      hostDiagnostics: () => hostLog,
      fetch: async (_url, init) => {
        submissions += 1
        const bundle = (init?.body as FormData).get('logs_bundle') as File
        const bytes = new Uint8Array(await bundle.arrayBuffer())
        assert.ok(bytes.byteLength <= FEEDBACK_LIMITS.bundleBytes)
        assert.equal(
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
            ZIP_COMPRESSION_OFFSET,
            true
          ),
          0
        )
        const entries = unzipSync(bytes)
        assert.deepEqual(Object.keys(entries).sort(), [
          'feedback/collection.json',
          'feedback/recording-report.json',
          'feedback/renderer-diagnostics.json',
          'host/desktop.log',
        ])
        assert.equal(strFromU8(entries['feedback/recording-report.json']), recording)
        assert.equal(strFromU8(entries['feedback/renderer-diagnostics.json']), renderer)
        assert.equal(strFromU8(entries['host/desktop.log']), hostLog)
        assert.deepEqual(JSON.parse(strFromU8(entries['feedback/collection.json'])), {
          schemaVersion: 1,
          backend: 'unavailable',
          conversationRequested: true,
          diagnosticsRequested: true,
        })
        assert.equal(new Headers(init?.headers).has('authorization'), false)
        return Response.json({ id: 'bounded-report-feedback' })
      },
    })
    const recordingReport = new TextEncoder().encode(recording)
    const rendererDiagnostics = new TextEncoder().encode(renderer)
    assert.equal(recordingReport.byteLength, size)
    assert.equal(rendererDiagnostics.byteLength, size)
    const result = await service.submit({ ...request, recordingReport, rendererDiagnostics })
    assert.equal(result.ok, true)
    assert.equal(result.diagnostics, 'partial')
    assert.equal(submissions, 1)
  }
})

const request = {
  description: '[测试] Feedback transport',
  includeLogs: true,
  includeTrace: true,
  sessionId: 'selected-session',
  images: [],
}

test('desktop feedback wires the packaged build number into the submitted version', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /new FeedbackSubmissionService\(\{[^]*?version:\s*clientVersion\(app\.getVersion\(\),\s*feedbackConfig\.buildNumber\)/
  )
})

for (const [platform, arch, expectedPlatform] of [
  ['darwin', 'arm64', 'macos'],
  ['win32', 'x64', 'windows'],
]) {
  for (const buildNumber of ['202610251405', '']) {
    test(`feedback submits the complete ${platform} version with ${buildNumber ? 'packaged' : 'startup'} build identity`, async () => {
      let submitted = 0
      const service = new FeedbackSubmissionService({
        baseUrl: 'https://feedback.example.test',
        accountBaseUrl: '',
        version: clientVersion('0.3.0', buildNumber),
        platform,
        arch,
        readToken: async () => '',
        isCurrent: () => true,
        collectBundle: async () => {
          assert.fail('version reporting must not require diagnostics')
        },
        hostDiagnostics: () => '',
        fetch: async (url, init) => {
          submitted += 1
          assert.equal(String(url), 'https://feedback.example.test/api/v1/feedback/submit')
          const body = init?.body as FormData
          assert.equal(body.get('client_version'), `0.3.0-${buildNumber || STARTUP_BUILD_NUMBER}`)
          assert.equal(body.get('client_platform'), expectedPlatform)
          assert.equal(body.get('client_arch'), arch)
          return Response.json({ id: 'version-feedback' })
        },
      })
      assert.equal((await service.submit({ ...request, includeLogs: false })).ok, true)
      assert.equal(submitted, 1)
    })
  }
}

test('local opaque credentials remain local and do not block anonymous remote feedback', async () => {
  let submitted = 0
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: 'https://account.example.test',
    version: '0.3.0',
    platform: 'darwin',
    arch: 'arm64',
    readToken: async () => 'local-only-token',
    isCurrent: () => true,
    collectBundle: async (_request, token) => {
      assert.equal(token, 'local-only-token')
      return new Uint8Array([1])
    },
    hostDiagnostics: () => '',
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://feedback.example.test/api/v1/feedback/submit')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      submitted += 1
      return Response.json({ id: 'anonymous-local-test' })
    },
  })
  assert.equal((await service.submit(request)).ok, true)
  assert.equal(submitted, 1)
})

test('feedback reaches remote once when Serve is unavailable, retaining the recording report', async () => {
  const calls: string[] = []
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: 'https://account.example.test',
    version: '0.3.0',
    platform: 'win32',
    arch: 'x64',
    readToken: async () => '',
    isCurrent: () => true,
    collectBundle: async () => {
      throw new Error('Serve unavailable')
    },
    hostDiagnostics: () => 'Authorization: Bearer hidden-token\nbackend exited code=1',
    fetch: async (url, init) => {
      calls.push(String(url))
      const body = init?.body as FormData
      assert.equal(body.get('description'), request.description)
      assert.equal(body.get('client_platform'), 'windows')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      const bundle = body.get('logs_bundle') as File
      const entries = unzipSync(new Uint8Array(await bundle.arrayBuffer()))
      assert.equal(
        strFromU8(entries['feedback/recording-report.json']),
        JSON.stringify({ schemaVersion: 1 })
      )
      assert.equal(strFromU8(entries['host/desktop.log']).includes('hidden-token'), false)
      assert.match(strFromU8(entries['host/desktop.log']), /backend exited/)
      assert.equal(
        JSON.parse(strFromU8(entries['feedback/collection.json'])).backend,
        'unavailable'
      )
      return Response.json({ ok: true, id: 'test-feedback-1' })
    },
  })
  assert.deepEqual(
    await service.submit({
      ...request,
      recordingReport: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1 })),
    }),
    { ok: true, id: 'test-feedback-1', diagnostics: 'partial' }
  )
  assert.deepEqual(calls, ['https://feedback.example.test/api/v1/feedback/submit'])
})

test('feedback rejects oversized or untrusted payloads before collecting or sending', async () => {
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: '',
    version: '0.3.0',
    platform: 'darwin',
    arch: 'arm64',
    readToken: async () => '',
    isCurrent: () => true,
    collectBundle: async () => {
      assert.fail('invalid request must not collect')
    },
    hostDiagnostics: () => {
      assert.fail('invalid request must not collect host logs')
    },
    fetch: async () => {
      assert.fail('invalid request must not send')
    },
  })
  for (const payload of [
    { ...request, url: 'https://attacker.test' },
    { ...request, description: '' },
    {
      ...request,
      images: [{ name: '../private.png', type: 'image/png', bytes: new Uint8Array([1]) }],
    },
    { ...request, recordingReport: new TextEncoder().encode('{}') },
  ]) {
    assert.equal((await service.submit(payload)).ok, false)
  }
})

test('signed-in feedback uses the hosted managed slot without forwarding the user JWT', async () => {
  const calls: string[] = []
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: 'https://account.example.test',
    version: '0.3.0',
    platform: 'darwin',
    arch: 'arm64',
    readToken: async () => 'user.jwt.signature',
    isCurrent: () => true,
    collectBundle: async () => {
      assert.fail('no diagnostic consent')
    },
    hostDiagnostics: () => {
      assert.fail('no diagnostic consent')
    },
    fetch: async (url, init) => {
      calls.push(String(url))
      if (String(url).startsWith('https://account.example.test')) {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer user.jwt.signature')
        assert.deepEqual(JSON.parse(String(init?.body)), {
          slot: 'scholarseed',
          name: '书深技能凭据',
        })
        return Response.json({ token: 'ssk-feedback-key' })
      }
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ssk-feedback-key')
      assert.equal((init?.body as FormData).has('logs_bundle'), false)
      assert.equal((init?.body as FormData).get('client_platform'), 'macos')
      assert.equal(init?.redirect, 'error')
      return Response.json({ id: 'signed-in-feedback' })
    },
  })
  assert.deepEqual(await service.submit({ ...request, includeLogs: false }), {
    ok: true,
    id: 'signed-in-feedback',
    diagnostics: 'not_requested',
  })
  assert.equal(calls.length, 2)
})

test('remote rate limits and ambiguous network failures are never retried through another transport', async () => {
  for (const limited of [true, false]) {
    let sent = 0
    const service = new FeedbackSubmissionService({
      baseUrl: 'https://feedback.example.test',
      accountBaseUrl: '',
      version: '0.3.0',
      platform: 'darwin',
      arch: 'arm64',
      readToken: async () => '',
      isCurrent: () => true,
      collectBundle: async () => new Uint8Array(),
      hostDiagnostics: () => '',
      fetch: async () => {
        sent += 1
        if (!limited) throw new Error('connection lost after upload')
        return new Response('', { status: 429 })
      },
    })
    const result = await service.submit({ ...request, includeLogs: false })
    assert.equal(result.ok, false)
    assert.equal(Boolean(result.rateLimited), limited)
    assert.equal(sent, 1)
  }
})

test('identity changes stop old credentials before collection or remote feedback submission', async () => {
  let token = 'old.user.signature'
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: 'https://account.example.test',
    version: '0.3.0',
    platform: 'win32',
    arch: 'x64',
    readToken: async () => token,
    isCurrent: () => true,
    collectBundle: async () => {
      assert.fail('old identity must not collect')
    },
    hostDiagnostics: () => '',
    fetch: async () => {
      token = 'new-user'
      return Response.json({ token: 'ssk-old-user' })
    },
  })
  assert.deepEqual(await service.submit(request), { ok: false, code: 'identity_changed' })
})

test('feedback serializes concurrent submissions and rejects a stale renderer', async () => {
  let complete: (value: Response) => void = () => undefined
  const pending = new Promise<Response>((resolve) => {
    complete = resolve
  })
  let sent = 0
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: '',
    version: '0.3.0',
    platform: 'darwin',
    arch: 'arm64',
    readToken: async () => '',
    isCurrent: () => true,
    collectBundle: async () => new Uint8Array([1]),
    hostDiagnostics: () => '',
    fetch: async () => {
      sent += 1
      return pending
    },
  })
  assert.deepEqual(await service.submit(request, () => false), {
    ok: false,
    code: 'invalid_sender',
  })
  const first = service.submit({ ...request, includeLogs: false })
  assert.deepEqual(await service.submit(request), { ok: false, code: 'busy' })
  complete(Response.json({ id: 'single-feedback' }))
  assert.equal((await first).ok, true)
  assert.equal(sent, 1)
})

test('backend-unavailable feedback includes startup identity only with diagnostic consent', async () => {
  const identity = JSON.stringify({
    schema_version: 1,
    runtime_kind: 'local_dev',
    commit: 'a'.repeat(40),
  })
  for (const includeLogs of [true, false]) {
    const service = new FeedbackSubmissionService({
      baseUrl: 'https://feedback.example.test',
      accountBaseUrl: '',
      version: '0.3.0',
      platform: 'darwin',
      arch: 'arm64',
      readToken: async () => '',
      isCurrent: () => true,
      sourceBaseline: () => identity,
      hostDiagnostics: () => '',
      collectBundle: async () => {
        throw new Error('backend unavailable')
      },
      fetch: async (_url, init) => {
        const bundle = (init!.body as FormData).get('logs_bundle') as File | null
        if (includeLogs) {
          const entries = unzipSync(new Uint8Array(await bundle!.arrayBuffer()))
          assert.equal(strFromU8(entries['feedback/source-baseline.json']), identity)
        } else assert.equal(bundle, null)
        return Response.json({ id: 'source-feedback' })
      },
    })
    assert.equal((await service.submit({ ...request, includeLogs })).ok, true)
  }
})
