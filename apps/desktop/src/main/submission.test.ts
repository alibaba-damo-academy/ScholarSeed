import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { unzipSync, strFromU8 } from 'fflate'

import { FEEDBACK_LIMITS } from '../feedback.ts'
import { collectServeFeedbackBundle, FeedbackSubmissionService } from './submission.ts'
import {
  parseRunnerExitEvents,
  readFeedbackSandboxLog,
  readFeedbackUpdateLog,
} from './feedback-log.ts'
import { clientVersion, STARTUP_BUILD_NUMBER } from './version.ts'

const require = createRequire(import.meta.url)
const { verifyClosure } = require('../../scripts/cd/closure.cjs')
const WORKER_BOUNDARY_BYTES = 160000
const ZIP_COMPRESSION_OFFSET = 8
const SANDBOX_TIMESTAMP = '2026-11-12 15:04:01.510'
const SANDBOX_RPC =
  'WARNING:scholarseed_codex.rpc:codex_rpc_rejected method=command/exec code=-32603 ' +
  'request_id=4 generation=1 pid=12588 latency_ms=9640 native_stage=runner_pipe_connect ' +
  'native_code_type=win32 native_code=5 reason=windows_sandbox_failed rpc:length=105:sha256=8d5f1b8d6df8'
const SANDBOX_PIPE_TIMEOUT = SANDBOX_RPC.replace('request_id=4', 'request_id=6')
  .replace('native_code_type=win32 native_code=5', 'native_code_type=None native_code=None')
  .replace(' rpc:length=', ' pipe=in timeout_ms=15000 rpc:length=')

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
          backendFailure: 'transport_error',
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

test('fallback feedback keeps a redacted, bounded update log and classifies the Serve response', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-update-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const updateLog = join(directory, 'update.log')
  writeFileSync(
    updateLog,
    `old-line ${'x'.repeat(FEEDBACK_LIMITS.updateLogBytes)}\n` +
      '[update] ShipIt ShipIt_stderr.log\n' +
      'Authorization: Bearer shipit-secret\n' +
      'failed at /Users/private-user/Applications/ScholarSeed.app\n'
  )
  const calls: string[] = []
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: 'https://account.example.test',
    version: '0.3.0',
    platform: 'darwin',
    arch: 'arm64',
    readToken: async () => '',
    isCurrent: () => true,
    collectBundle: () =>
      collectServeFeedbackBundle(async () => new Response('internal-secret', { status: 503 })),
    hostDiagnostics: () => 'Authorization: Bearer hidden-token\nbackend exited code=1',
    updateDiagnostics: () => readFeedbackUpdateLog(updateLog),
    sandboxDiagnostics: () => assert.fail('macOS must not collect Windows sandbox diagnostics'),
    fetch: async (url, init) => {
      calls.push(String(url))
      const body = init?.body as FormData
      assert.equal(body.get('description'), request.description)
      assert.equal(body.get('client_platform'), 'macos')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      const bundle = body.get('logs_bundle') as File
      const entries = unzipSync(new Uint8Array(await bundle.arrayBuffer()))
      assert.equal(
        strFromU8(entries['feedback/recording-report.json']),
        JSON.stringify({ schemaVersion: 1 })
      )
      assert.equal(strFromU8(entries['host/desktop.log']).includes('hidden-token'), false)
      assert.match(strFromU8(entries['host/desktop.log']), /backend exited/)
      assert.deepEqual(JSON.parse(strFromU8(entries['feedback/collection.json'])), {
        schemaVersion: 1,
        backend: 'unavailable',
        backendFailure: 'http_error',
        backendHttpStatus: 503,
        conversationRequested: true,
        diagnosticsRequested: true,
      })
      const update = entries['update/update.log']
      assert.ok(update.byteLength <= FEEDBACK_LIMITS.updateLogBytes)
      const text = strFromU8(update)
      assert.match(text, /ShipIt_stderr\.log/)
      assert.match(text, /Authorization:.*<REDACTED>/)
      assert.doesNotMatch(text, /shipit-secret|private-user|old-line|x{100}/)
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

test('runner exit parsing projects only a recognized native event without its raw fields', () => {
  const event =
    "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>" +
    "<System><TimeCreated SystemTime='2026-11-12T05:46:44.4895302Z'/>" +
    '<EventRecordID>96353</EventRecordID><Computer>private-host</Computer></System>' +
    "<EventData><Data Name='Caption'>codex-command-runner-0.165.0.exe - Application Error</Data>" +
    "<Data Name='Message'>unavailable (0xc0000142), private details</Data></EventData></Event>"
  const unrelated = event.replace('codex-command-runner', 'private-process')
  assert.deepEqual(parseRunnerExitEvents(`<Events>\r\n${event}${unrelated}</Events>\r\n`), [
    {
      eventRecordId: 96353,
      timestamp: '2026-11-12T05:46:44.4895302Z',
      status: '0xc0000142',
    },
  ])
  assert.deepEqual(parseRunnerExitEvents(`<Events>${event.repeat(16)}</Events>`), [])
  assert.deepEqual(parseRunnerExitEvents(`<Events>${event}<unexpected /></Events>`), [])
})

test('Windows feedback retains only allowlisted sandbox evidence when Serve rejects collection', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-sandbox-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const backendLog = join(directory, 'backend.log')
  const timestamp = SANDBOX_TIMESTAMP
  const rpc = SANDBOX_RPC
  const finished = new Date(timestamp.replace(' ', 'T')).getTime()
  const exit = {
    eventRecordId: 96353,
    timestamp: new Date(finished - 200).toISOString(),
    status: '0xC0000142',
  }
  const setup =
    'INFO:scholarseed_runtime.resources.sandbox:windows_sandbox_initialization ' +
    JSON.stringify({
      event: 'completion',
      stage: 'completion',
      setup_attempt_id: '739eec24ab974f6689c9a8a3ce438ea1',
      generation: 1,
      pid: 12588,
      elapsed_ms: 520,
      native_code: 'helper_read_acl_helper_spawn_failed',
      native_stage: 'setup_read_acl_helper',
      success: false,
      account_update_code: null,
      unreviewed: 'private-token',
    })
  writeFileSync(
    backendLog,
    [
      `${timestamp} ${'x'.repeat(FEEDBACK_LIMITS.hostBytes)}`,
      `${timestamp} ${setup}`,
      `${timestamp} ${rpc}`,
      `${timestamp} ${SANDBOX_PIPE_TIMEOUT}`,
      `${timestamp} WARNING:scholarseed_runtime.resources.sandbox:windows_sandbox_execution_check ` +
        'event=failed probe=bootstrap outcome=rpc generation=1 pid=12588 rpc_request_id=4 exit_code=None',
      `${timestamp} ${rpc} raw=private-token`,
      `${timestamp} ${rpc.replace('command/exec', 'thread/read')}`,
      `${timestamp} ${rpc.replace('request_id=4', 'request_id=5')}`,
    ].join('\r\n')
  )
  let reads = 0
  let queries = 0
  let startUpdate: () => void = () => undefined
  let finishUpdate: (value: string) => void = () => undefined
  const updateStarted = new Promise<void>((resolve) => {
    startUpdate = resolve
  })
  const updateReady = new Promise<string>((resolve) => {
    finishUpdate = resolve
  })
  const readRunnerExits = async (start: number, end: number) => {
    queries += 1
    assert.deepEqual([start, end], [finished - 9640, finished])
    return [exit, { ...exit, eventRecordId: 96352, timestamp: new Date(start - 1).toISOString() }]
  }
  const service = new FeedbackSubmissionService({
    baseUrl: 'https://feedback.example.test',
    accountBaseUrl: '',
    version: '0.3.2',
    platform: 'win32',
    arch: 'x64',
    readToken: async () => '',
    isCurrent: () => true,
    collectBundle: () =>
      collectServeFeedbackBundle(async () => new Response(null, { status: 503 })),
    hostDiagnostics: () => 'backend exited',
    updateDiagnostics: () => {
      startUpdate()
      return updateReady
    },
    sandboxDiagnostics: () => {
      reads += 1
      return readFeedbackSandboxLog(backendLog, readRunnerExits)
    },
    fetch: async (_url, init) => {
      const bundle = (init?.body as FormData).get('logs_bundle') as File | null
      if (bundle) {
        const entries = unzipSync(new Uint8Array(await bundle.arrayBuffer()))
        assert.equal(strFromU8(entries['update/update.log']), 'update diagnostic')
        const text = strFromU8(entries['host/sandbox-diagnostics.log'])
        assert.match(text, /request_id=4 generation=1 pid=12588/)
        assert.match(text, /native_stage=runner_pipe_connect native_code_type=win32 native_code=5/)
        assert.match(text, /event=failed probe=bootstrap outcome=rpc/)
        assert.match(text, /helper_read_acl_helper_spawn_failed/)
        assert.match(text, /"native_stage":"setup_read_acl_helper"/)
        assert.match(text, /windows_sandbox_runner_exit .*"correlation":"request_window"/)
        assert.match(text, /"status_type":"ntstatus","status":"0xc0000142"/)
        assert.match(text, /"request_id":6,"generation":1,"app_server_pid":12588/)
        assert.doesNotMatch(text, /private-token|unreviewed|thread\/read|request_id=5|x{100}/)
        assert.doesNotMatch(text, /96352/)
        assert.ok(entries['host/sandbox-diagnostics.log'].byteLength <= FEEDBACK_LIMITS.hostBytes)
      }
      return Response.json({ id: 'sandbox-feedback' })
    },
  })
  const pending = service.submit(request)
  await updateStarted
  try {
    assert.equal(reads, 1, 'sandbox collection starts while the update log is pending')
  } finally {
    finishUpdate('update diagnostic')
    assert.equal((await pending).diagnostics, 'partial')
  }
  assert.equal((await service.submit({ ...request, includeLogs: false })).ok, true)
  assert.equal(reads, 1)
  assert.equal(queries, 1)
  assert.doesNotMatch(
    await readFeedbackSandboxLog(backendLog, async () => [exit, { ...exit, eventRecordId: 96354 }]),
    /windows_sandbox_runner_exit/
  )
  assert.doesNotMatch(
    await readFeedbackSandboxLog(backendLog, async () => {
      throw new Error('private query failure')
    }),
    /windows_sandbox_runner_exit|private query failure/
  )
})

test('sandbox setup keeps explicit unknown results and applies the full record size limit', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-setup-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const backendLog = join(directory, 'backend.log')
  const setupLogger = 'windows_sandbox_initialization '
  const prefix = `${SANDBOX_TIMESTAMP} INFO:scholarseed_runtime.resources.sandbox:${setupLogger}`
  const acceptedAttempt = '1'.repeat(32)
  const completedAttempt = '2'.repeat(32)
  const oversizedAttempt = '3'.repeat(32)
  const accepted =
    prefix +
    JSON.stringify({
      event: 'setup_accepted',
      stage: 'setup_start',
      setup_attempt_id: acceptedAttempt,
      started: 'unknown',
      error_present: 'unknown',
      padding: '',
    })
  const padding = 'x'.repeat(4096 - accepted.length)
  const boundary = accepted.replace('"padding":""', `"padding":"${padding}"`)
  const oversized = boundary
    .replace(acceptedAttempt, oversizedAttempt)
    .replace(padding, padding + 'x')
  const completed =
    prefix +
    JSON.stringify({
      event: 'completion',
      stage: 'completion',
      setup_attempt_id: completedAttempt,
      success: 'unknown',
      started: 'private-token',
      error_present: false,
      error_is_string: true,
    })
  writeFileSync(backendLog, [boundary, oversized, completed, ''].join('\n'))
  const result = await readFeedbackSandboxLog(backendLog)
  assert.deepEqual(
    result
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line.slice(prefix.length))),
    [
      {
        event: 'setup_accepted',
        stage: 'setup_start',
        setup_attempt_id: acceptedAttempt,
        started: 'unknown',
      },
      {
        event: 'completion',
        stage: 'completion',
        setup_attempt_id: completedAttempt,
        success: 'unknown',
        error_present: false,
        error_is_string: true,
      },
    ]
  )
})

test('sandbox diagnostics keep the correlated runner exit and its RPC within a full budget', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-budget-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const backendLog = join(directory, 'backend.log')
  const anchor = `${SANDBOX_TIMESTAMP} ${SANDBOX_PIPE_TIMEOUT}\n`
  const record = `${SANDBOX_TIMESTAMP} ${SANDBOX_RPC}\n`
  const olderRecord = record.replace('request_id=4', 'request_id=7')
  const fillerCount = Math.floor((FEEDBACK_LIMITS.hostBytes - anchor.length) / record.length)
  writeFileSync(backendLog, anchor + olderRecord + record.repeat(fillerCount - 1))
  assert.equal(
    await readFeedbackSandboxLog(backendLog, async () => []),
    anchor + olderRecord + record.repeat(fillerCount - 1)
  )
  const result = await readFeedbackSandboxLog(backendLog, async (_start, end) => [
    { eventRecordId: 96353, timestamp: new Date(end - 200).toISOString(), status: '0xC0000142' },
  ])
  const records = result.trimEnd().split('\n')
  assert.match(
    records.at(-1) ?? '',
    /^windows_sandbox_runner_exit .*"status":"0xc0000142".*"request_id":6,/
  )
  assert.equal(records[0], anchor.trimEnd())
  assert.equal(records.length, fillerCount + 1)
  assert.ok(records.slice(1, -1).every((entry) => entry === record.trimEnd()))
  assert.ok(Buffer.byteLength(result) <= FEEDBACK_LIMITS.hostBytes)
})

test('Serve bundle collection distinguishes transport, timeout and unexpected content type', async (t) => {
  await assert.rejects(
    collectServeFeedbackBundle(async () => {
      throw new Error('private transport detail')
    }),
    { message: 'transport_error' }
  )
  await assert.rejects(
    collectServeFeedbackBundle(async () => Response.json({ ok: true })),
    { message: 'unexpected_content_type' }
  )
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort())
  await assert.rejects(
    collectServeFeedbackBundle(async (signal) => {
      signal.throwIfAborted()
      return new Response()
    }),
    { message: 'timeout' }
  )
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
