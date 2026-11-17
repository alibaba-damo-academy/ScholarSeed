import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { AsyncFileLog } from './logging.ts'
import { PersistenceClient, type PersistenceRequest } from './persistence.ts'
import { PreferenceDiagnostics } from '../preference-diagnostics.ts'
import { acquireDirectoryWriter } from './writer.ts'
import type { DomainNative } from '../../native/domains.cjs'
import { REGISTRY_DIRECTORY } from '../../native/registry.cjs'

const desktop = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)

async function fixture(context: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'persistence-worker-')))
  const directory = join(root, 'data')
  mkdirSync(directory)
  const entry = join(root, 'persistor.js')
  copyFileSync(join(desktop, 'out/main/lease.node'), join(root, 'lease.node'))
  await build({
    entryPoints: [join(desktop, 'src/main/persistor.ts')],
    outfile: entry,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['./lease.node'],
    plugins: [
      {
        name: 'isolated-writer-account',
        setup(bundle) {
          bundle.onResolve({ filter: /^node:os$/ }, (args) =>
            args.importer === join(desktop, 'src/main/writer.ts')
              ? { path: 'account', namespace: 'fixture' }
              : undefined
          )
          bundle.onLoad({ filter: /^account$/, namespace: 'fixture' }, () => ({
            contents: `export const userInfo = () => ({ homedir: ${JSON.stringify(root)} })`,
          }))
        },
      },
    ],
  })
  const worker = new Worker(entry)
  const uncertain: unknown[] = []
  const client = new PersistenceClient(worker, (owner) => uncertain.push(owner))
  const diagnostics: string[] = []
  client.diagnostics((line) => diagnostics.push(line))
  context.after(async () => {
    try {
      await client.close()
    } catch {
      await worker.terminate()
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, directory, client, diagnostics, uncertain, worker }
}

test('real coordination lock wait stays off the caller event loop and is separated from commit', async (context) => {
  const fx = await fixture(context)
  const path = join(fx.directory, 'window.log')
  const input = { path, chunk: 'warm\n', maxBytes: 1024, backups: 3 }
  assert.equal(await fx.client.request('log', input), true)
  const database = new DatabaseSync(join(fx.root, REGISTRY_DIRECTORY, 'registry.sqlite'))
  context.after(() => database.close())
  database.exec('BEGIN IMMEDIATE')
  let heartbeats = 0
  const heartbeat = setInterval(() => heartbeats++, 10)
  const release = setTimeout(() => database.exec('ROLLBACK'), 250)
  try {
    assert.equal(await fx.client.request('log', { ...input, chunk: 'blocked\n' }), true)
  } finally {
    clearInterval(heartbeat)
    clearTimeout(release)
  }
  assert.ok(heartbeats >= 5, `caller heartbeat: ${heartbeats}`)
  const record = JSON.parse(fx.diagnostics.at(-1)!.slice('[persistence]'.length))
  assert.ok(record.registry.beginMs >= 100, JSON.stringify(record))
  assert.ok(record.registry.commitMs < record.registry.beginMs)
  assert.ok(record.executionMs >= record.registry.beginMs)
  assert.ok(record.queueMs >= 0 && record.deliveryMs >= 0)
  assert.doesNotMatch(fx.diagnostics.join(''), /registry.sqlite|window.log|BEGIN|SELECT|blocked/)
  await fx.client.request('logEnd', { path })
  assert.deepEqual(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('[persistence-batch]')),
    ['warm', 'blocked']
  )
  assert.match(readFileSync(path, 'utf8'), new RegExp(`"jobId":${record.jobId}`))
})

test('deferred batching preserves line order, reports bounded omissions and drains rotation on close', async (context) => {
  const fx = await fixture(context)
  const path = join(fx.directory, 'backend.log')
  const log = new AsyncFileLog(path, { deferred: true, maxBytes: 16 }, fx.client)
  const omitted = log.write('old old old old old\n')
  const first = log.write('first\n')
  const second = log.write('second\n')
  assert.equal(await omitted, false)
  assert.equal(fx.diagnostics.length, 0)
  log.resume()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  await log.end()
  assert.match(readFileSync(path, 'utf8'), /bytes omitted\nfirst\nsecond\n$/)
  assert.equal(await log.write('late'), false)
  assert.equal(fx.diagnostics.filter((line) => line.includes('"operation":"log"')).length, 1)
})

test('real maintenance denial stays observable; idle workers do not retain a directory lease', async (context) => {
  const fx = await fixture(context)
  const input = { path: join(fx.directory, 'idle.log'), chunk: 'one\n', maxBytes: 1024, backups: 3 }
  assert.equal(await fx.client.request('log', input), true)
  const native = require(join(desktop, 'out/main/lease.node')) as DomainNative
  const maintenance = acquireDirectoryWriter(
    native,
    join(fx.root, REGISTRY_DIRECTORY),
    fx.directory,
    true
  )
  try {
    assert.equal(await fx.client.request('log', input), false)
    assert.match(fx.diagnostics.at(-1)!, /"result":"denied"/)
  } finally {
    maintenance.close()
  }
  assert.equal(await fx.client.request('log', input), true)
  await fx.client.close()
  assert.equal(fx.uncertain.length, 0)
  await assert.rejects(fx.client.request('log', input), /PERSISTENCE_CLOSED/)
})

test('preference jobs preserve authoritative opt-out, correlate diagnostics and survive worker restart', async (context) => {
  const fx = await fixture(context)
  const path = join(fx.directory, 'renderer-preferences.json')
  const diagnostics = new PreferenceDiagnostics('main')
  const input = { path, language: 'en' as const, diagnostics: diagnostics.context() }
  const lines: string[] = []
  const automation = fx.client.request('preferences', {
    ...input,
    mode: 'automation',
    enabled: false,
  })
  const save = fx.client.request(
    'preferences',
    { ...input, mode: 'save', value: { theme: 'dark', browserAutomationEnabled: true } },
    { diagnostic: (line) => lines.push(line) }
  )
  await automation
  const preferences = await save
  assert.equal(preferences.browserAutomationEnabled, false)
  assert.equal(preferences.theme, 'dark')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).theme, 'dark')
  const written = lines
    .map((line) => JSON.parse(line.slice('[preferences]'.length)))
    .find((record) => record.operation === 'complete')
  assert.equal(written.attempt, diagnostics.context().attempt)
  assert.equal(written.published, true)
  assert.doesNotMatch(lines.join(''), /renderer-preferences|dark/)
  await fx.client.close()
  const restarted = new PersistenceClient(new Worker(join(fx.root, 'persistor.js')))
  try {
    const restored = await restarted.request('preferences', { ...input, mode: 'read' })
    assert.equal(restored.theme, 'dark')
    assert.equal(restored.browserAutomationEnabled, false)
  } finally {
    await restarted.close()
  }
})

test('invalid font cache never becomes a successful save acknowledgement', async (context) => {
  const fx = await fixture(context)
  await assert.rejects(
    fx.client.request('cache', {
      directory: fx.directory,
      namespace: 'engine',
      fingerprint: 'fonts',
      mode: 'save',
      value: undefined,
    }),
    /Incomplete Office font cache/
  )
  assert.equal(
    await fx.client.request('cache', {
      directory: fx.directory,
      namespace: 'engine',
      fingerprint: 'fonts',
      mode: 'load',
    }),
    null
  )
})

test('worker death and uncertain release fail closed without restarting or acknowledging pending work', async () => {
  for (const death of [true, false, 'late']) {
    const port = new EventEmitter() as EventEmitter & {
      postMessage(message: PersistenceRequest): void
    }
    const sent: PersistenceRequest[] = []
    port.postMessage = (message) => {
      sent.push(message)
    }
    let retained = 0
    const client = new PersistenceClient(port, () => retained++)
    const pending = client.request('close', undefined)
    if (death === true) port.emit('exit', 0)
    else
      port.emit('message', {
        id: death === 'late' ? 999 : sent[0].id,
        fatal: true,
        error: { message: 'release uncertain' },
      })
    assert.equal(retained, 1)
    await assert.rejects(pending, /PERSISTENCE_UNAVAILABLE/)
    await assert.rejects(client.close(), /PERSISTENCE_UNAVAILABLE/)
    assert.equal(retained, 1)
    assert.equal(sent.length, 1)
  }
})

test('close waits for physical append, archive acknowledgement and worker exit; telemetry does not recurse', async () => {
  const port = new EventEmitter() as EventEmitter & {
    postMessage(message: PersistenceRequest): void
  }
  const sent: PersistenceRequest[] = []
  port.postMessage = (message) => {
    sent.push(message)
  }
  const client = new PersistenceClient(port, () => assert.fail('normal drain cannot be uncertain'))
  const log = new AsyncFileLog('owned.log', {}, client)
  client.diagnostics((line) => {
    void log.write(line, true)
  })
  let persisted = false
  const first = log.write('one\n').then((result) => {
    persisted = result
  })
  const second = log.write('two\n')
  await Promise.resolve()
  assert.equal(sent.length, 1)
  assert.equal((sent[0].input as { chunk: string }).chunk, 'one\ntwo\n')
  assert.equal(persisted, false)
  port.emit('message', { id: sent[0].id, value: true, timing: { operation: 'log' } })
  await first
  assert.equal(await second, true)
  await Promise.resolve()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].telemetryOnly, true)
  port.emit('message', { id: sent[1].id, value: true })
  let drained = false
  const ending = log.end().then(() => {
    drained = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(sent[2].kind, 'logEnd')
  assert.equal(drained, false)
  port.emit('message', { id: sent[2].id })
  await ending
  const closing = client.close()
  assert.equal(client.close(), closing)
  port.emit('message', { id: sent[3].id })
  await Promise.resolve()
  let exited = false
  void closing.then(() => {
    exited = true
  })
  assert.equal(exited, false)
  port.emit('exit', 0)
  await closing
  assert.equal(sent.length, 4)
})
