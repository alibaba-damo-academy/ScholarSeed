import { parentPort } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { dirname } from 'node:path'
import { withRegistryObserver, type RegistryTiming } from '../../native/registry.cjs'
import { RotatingFileLog } from './logfile.ts'
import { assertDirectoryOwnership, desktopDirectoryWriter } from './writer.ts'
import { PreferenceDiagnostics } from '../preference-diagnostics.ts'
import { readPreferences, savePreferences, writePreferences } from './preferencefile.ts'
import type {
  PersistenceOperation,
  PersistenceOperations,
  PersistenceReply,
  PersistenceRequest,
} from './persistence.ts'

const port = parentPort!
const logs = new Map<string, RotatingFileLog>()
let queue = Promise.resolve()
let closing = false

async function perform<Kind extends PersistenceOperation>(
  request: PersistenceRequest<Kind>
): Promise<unknown> {
  assertDirectoryOwnership()
  if (request.kind === 'log') {
    const input = request.input as PersistenceOperations['log']['input']
    let log = logs.get(input.path)
    if (!log) {
      log = new RotatingFileLog(input.path, {
        maxBytes: input.maxBytes,
        backups: input.backups,
        acquireWriter: () => {
          const writer = desktopDirectoryWriter(dirname(input.path))
          return {
            close() {
              try {
                writer.close()
              } catch (error) {
                port.postMessage({ id: request.id, fatal: true })
                throw error
              }
            },
          }
        },
      })
      logs.set(input.path, log)
    }
    const batch = JSON.stringify({
      jobId: request.id,
      scope: input.scope,
      entries: input.entries,
      timestamp: new Date().toISOString(),
    })
    const appended = log.write(`[persistence-batch] ${batch}\n${input.chunk}`)
    await log.flush()
    return appended
  }
  if (request.kind === 'preferences') {
    const input = request.input as PersistenceOperations['preferences']['input']
    const diagnostics = PreferenceDiagnostics.restore(input.diagnostics, (diagnostic) =>
      port.postMessage({ id: request.id, diagnostic })
    )
    if (input.mode === 'read')
      return diagnostics.runSync('read', () => readPreferences(input.path, input.language))
    if (input.mode === 'save')
      return savePreferences(input.path, input.language, input.value, diagnostics)
    const previous = diagnostics.runSync('read', () => readPreferences(input.path, input.language))
    return writePreferences(
      input.path,
      { ...previous, browserAutomationEnabled: input.enabled === true },
      diagnostics
    )
  }
  if (request.kind === 'logEnd') {
    const input = request.input as PersistenceOperations['logEnd']['input']
    await logs.get(input.path)?.end()
    logs.delete(input.path)
    return undefined
  }
  await Promise.all([...logs.values()].map((log) => log.end()))
  assertDirectoryOwnership()
  return undefined
}

port.on('message', (request: PersistenceRequest) => {
  if (closing) return
  if (request.kind === 'close') closing = true
  queue = queue.then(async () => {
    const started = performance.now()
    const totals = {
      count: 0,
      failed: 0,
      beginMs: 0,
      operationMs: 0,
      commitMs: 0,
      rollbackMs: 0,
      maxBeginMs: 0,
      maxCommitMs: 0,
    }
    const observe = (event: Readonly<RegistryTiming>) => {
      totals.count++
      if (event.result !== 'committed') totals.failed++
      totals.beginMs += event.beginMs
      totals.operationMs += event.operationMs
      totals.commitMs += event.commitMs
      totals.rollbackMs += event.rollbackMs
      totals.maxBeginMs = Math.max(totals.maxBeginMs, event.beginMs)
      totals.maxCommitMs = Math.max(totals.maxCommitMs, event.commitMs)
    }
    const reply: PersistenceReply = { id: request.id }
    try {
      reply.value = await withRegistryObserver(observe, () => perform(request))
    } catch (error) {
      const source = error as NodeJS.ErrnoException
      reply.error = { code: source.code, message: source.message }
    }
    try {
      assertDirectoryOwnership()
    } catch {
      reply.fatal = true
    }
    if (!request.telemetryOnly)
      reply.timing = {
        timestamp: new Date().toISOString(),
        jobId: request.id,
        operation: request.kind,
        queueMs: started - request.submittedAt,
        executionMs: performance.now() - started,
        result: reply.error
          ? 'failed'
          : request.kind === 'log' && reply.value === false
            ? 'denied'
            : 'completed',
        registry: totals,
        errorCode: reply.error?.code,
        ...(request.kind === 'log'
          ? {
              log: {
                scope: (request.input as PersistenceOperations['log']['input']).scope,
                entries: (request.input as PersistenceOperations['log']['input']).entries,
              },
            }
          : {}),
      }
    reply.finishedAt = performance.now()
    port.postMessage(reply)
    if (request.kind === 'close' && !reply.fatal) port.close()
  })
})
