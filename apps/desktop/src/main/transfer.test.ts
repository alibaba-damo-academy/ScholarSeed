import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { ComponentDiagnostics, ComponentTimer, COMPONENT_TIMING } from './timing.ts'
import { commitWithActivation, ActivationExpired } from './update-authorization.ts'
import type { WindowsTransfer } from './transfer.ts'
import {
  inspectionResult,
  TransferEvents,
  transferRequest,
  NATIVE_UPDATE_LOG_FILE,
  WindowsHandoffCancelled,
  validatedToolPrincipal,
} from './transfer.ts'

test('apply handoff preserves the active custom Home diagnostic path', () => {
  const root = win32.resolve('C:/installed')
  const application = win32.join(root, 'current')
  const diagnosticFile = win32.resolve('D:/custom 书深/logs', NATIVE_UPDATE_LOG_FILE)
  const request = JSON.parse(
    JSON.stringify(
      transferRequest(
        {
          operation: 'apply',
          application,
          diagnosticFile,
        },
        root
      )
    )
  )
  assert.equal(request.diagnosticFile, diagnosticFile)
  assert.equal(request.mainPid, process.pid)
  for (const operation of ['inspect', 'prepare', 'group'] as const) {
    const other = JSON.parse(
      JSON.stringify(
        transferRequest(
          {
            operation,
            application,
            diagnosticFile,
          },
          root
        )
      )
    )
    assert.equal(Object.hasOwn(other, 'diagnosticFile'), false)
  }
})

test('handoff events preserve ordering across asynchronous approval', async () => {
  const events = new TransferEvents()
  events.push('{"event":"ready"}')
  await events.expect('ready')
  const authorized = events.expect('authorized')
  events.push('{"event":"authorized"}')
  assert.equal((await authorized).event, 'authorized')
  events.push('{"event":"started"}')
  events.fail(new Error('pipe closed after acknowledgement'))
  assert.equal((await events.expect('started')).event, 'started')
  await assert.rejects(events.expect('complete'), /pipe closed/)
})

test('tool group results require an actual local account SID', () => {
  const principal = 'S-1-5-21-123-456-789-1001'
  assert.equal(validatedToolPrincipal(principal), principal)
  for (const value of [
    undefined,
    '',
    'CodexSandboxUsers',
    'S-1-5-18',
    'S-1-5-32-544',
    `${principal}\n`,
    'S-1-5-21-0123-456-789-1001',
    'S-1-5-21-123-456-789-4294967296',
  ])
    assert.throws(() => validatedToolPrincipal(value), /group result is invalid/)
})

test('UAC cancellation and terminal errors reject a pending handoff', async () => {
  for (const [line, expected] of [
    ['{"event":"cancelled"}', WindowsHandoffCancelled],
    ['{"event":"error","message":"invalid archive"}', /invalid archive/],
    ['{"event":"unknown"}', /Invalid Windows handoff event/],
    ['not json', SyntaxError],
  ] as const) {
    const events = new TransferEvents()
    const pending = events.expect('authorized')
    events.push(line)
    await assert.rejects(pending, expected)
  }
})

test('early commit acknowledgement cannot bypass authorization phase', async () => {
  const events = new TransferEvents()
  events.push('{"event":"started"}')
  await assert.rejects(events.expect('authorized'), /expected authorized, received started/)
})

test('handoff protocol bounds queued messages and event sizes', async () => {
  const events = new TransferEvents()
  const pending = events.expect('ready')
  events.push(JSON.stringify({ event: 'ready', message: 'x'.repeat(16 * 1024) }))
  await assert.rejects(pending, /exceeds limit/)
})

test('component progress never consumes or completes an authorization acknowledgement', async () => {
  const observed: unknown[] = []
  const events = new TransferEvents((p) => observed.push(p))
  const pending = events.expect('complete')
  const progress = {
    kind: 'python',
    phase: 'extracting',
    files: 7,
    totalFiles: 10,
    bytes: 30,
    totalBytes: 100,
  }
  for (let i = 0; i < 10; i++) events.push(JSON.stringify({ event: 'progress', progress }))
  events.push('{"event":"complete"}')
  assert.equal((await pending).event, 'complete')
  assert.equal(observed.length, 10)
  assert.deepEqual(observed[0], progress)
})
test('malformed progress fails the protocol instead of displaying a false percentage', async () => {
  for (const patch of [
    { bytes: 101 },
    { files: -1 },
    { totalBytes: NaN },
    { phase: 'authorized' },
    { kind: '../python' },
  ]) {
    const events = new TransferEvents()
    const pending = events.expect('complete')
    events.push(
      JSON.stringify({
        event: 'progress',
        progress: {
          kind: 'python',
          phase: 'extracting',
          files: 1,
          totalFiles: 2,
          bytes: 10,
          totalBytes: 100,
          ...patch,
        },
      })
    )
    await assert.rejects(pending, /Invalid Windows component progress/)
  }
})

test('inspection only admits a ready runtime with a validated principal', () => {
  const sid = 'S-1-5-21-123-456-789-1001'
  assert.deepEqual(inspectionResult({ runtimeReady: true, principalSid: sid }), {
    ready: true,
    principalSid: sid,
  })
  assert.deepEqual(inspectionResult({ runtimeReady: false }), { ready: false })
  for (const value of [
    {},
    { runtimeReady: 1 },
    { runtimeReady: true },
    { runtimeReady: true, principalSid: 'S-1-5-18' },
    { runtimeReady: false, principalSid: sid },
  ]) {
    assert.throws(() => inspectionResult(value))
  }
})

// Exercise the real transport state machine with controlled OS/process boundaries.
// This is not Windows native or signed installation acceptance.
const transportSource = ts.createSourceFile(
  'transfer.ts',
  readFileSync(new URL('./transfer.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const transportCode = ts.transpileModule(
  transportSource.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(transportSource))
    .join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText
for (const outcome of [
  'success',
  'renew',
  'expired',
  'refused',
  'cancelled',
  'helper-exited',
  'helper-error',
  'early-ack',
  'closed',
  'close-timeout',
  'initialization-close-timeout',
  'initialization-closed',
] as const) {
  test(`Windows final asynchronous authorization cannot bypass transport state: ${outcome}`, async () => {
    const initializationError = new Error('helper failed before ready')
    const logs: string[] = []
    const commands: string[] = []
    const controller = new AbortController()
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable(),
      unref: () => {},
    })
    const emit = (event: string) => child.stdout.write(JSON.stringify({ event }) + '\n')
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const { command } = JSON.parse(chunk.toString())
        commands.push(command)
        queueMicrotask(() => emit(command === 'start' ? 'authorized' : 'started'))
        callback()
      },
      final(callback) {
        if (!['close-timeout', 'initialization-close-timeout'].includes(outcome))
          queueMicrotask(() => child.emit('close', 0, null))
        callback()
      },
    })
    const noop = async () => {}
    const context = {
      exports: {} as {
        prepareWindowsTransfer: (options: unknown) => Promise<WindowsTransfer>
        WindowsHandoffExitUnconfirmed: new () => Error
      },
      process: { platform: 'win32', pid: 123, env: { LOCALAPPDATA: 'C:\\profile' } },
      ...win32,
      randomUUID,
      createInterface,
      Buffer,
      copyFile: noop,
      mkdir: noop,
      rename: noop,
      rm: noop,
      writeFile: noop,
      spawn: () => {
        setImmediate(() => {
          if (outcome.startsWith('initialization-')) child.emit('error', initializationError)
          else emit('ready')
        })
        return child
      },
      setTimeout: (callback: () => void, ms: number) =>
        setTimeout(callback, outcome.endsWith('close-timeout') && ms === 5_000 ? 10 : ms),
      clearTimeout,
      ComponentDiagnostics,
      ComponentTimer,
      COMPONENT_TIMING,
      commitWithActivation,
    }
    runInNewContext(transportCode, context)
    const preparation = context.exports.prepareWindowsTransfer({
      operation: 'apply',
      application: 'C:\\app\\current',
      signal: controller.signal,
      log: (message: string) => logs.push(message),
    })
    if (outcome.startsWith('initialization-')) {
      await assert.rejects(preparation, (error) => {
        assert.equal(
          error instanceof context.exports.WindowsHandoffExitUnconfirmed,
          outcome === 'initialization-close-timeout'
        )
        if (outcome === 'initialization-close-timeout')
          assert.equal((error as Error).cause, initializationError)
        else assert.equal(error, initializationError)
        return true
      })
      assert.ok(logs.some((message) => message.includes(initializationError.message)))
      assert.deepEqual(commands, [])
      assert.equal(child.stdin.writableEnded, true)
      child.emit('close', 0, null)
      child.stdout.end()
      child.stderr.end()
      return
    }
    const transfer = await preparation
    let requests = 0
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = transfer.start(async () => {
      requests++
      assert.deepEqual(commands, ['start'])
      enter()
      await waiting
      if (outcome === 'refused') throw new Error('withdrawn')
      return () => {
        if (outcome === 'expired' || (outcome === 'renew' && requests === 1))
          throw new ActivationExpired()
      }
    })
    await entered
    assert.deepEqual(commands, ['start'])
    if (outcome === 'cancelled') controller.abort(new Error('cancelled'))
    if (outcome === 'helper-exited') child.emit('close', 1, null)
    if (outcome === 'helper-error') emit('error')
    if (outcome === 'early-ack') emit('started')
    if (outcome === 'closed') await transfer.close()
    if (outcome === 'close-timeout') await assert.rejects(transfer.close(), /exit is unconfirmed/)
    release()
    if (outcome === 'success' || outcome === 'renew') {
      await pending
      assert.deepEqual(commands, ['start', 'commit'])
      await assert.rejects(transfer.start(), /no longer available/)
    } else {
      await assert.rejects(pending)
      assert.deepEqual(commands, ['start'])
      if (outcome === 'close-timeout') await assert.rejects(transfer.close(), /exit is unconfirmed/)
      else await transfer.close()
      assert.equal(child.stdin.writableEnded, true)
    }
    assert.equal(requests, outcome === 'renew' || outcome === 'expired' ? 2 : 1)
    child.stdout.end()
    child.stderr.end()
  })
}
